// Profile plugins are global to the running DSH profile. DS Bot exposes a
// read-only inventory and points people to DSH's own plugin manager; Bots never
// install, enable, disable or remove profile-wide code.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const CACHE_MS = 15_000
const MAX_TEXT = 500

const textOf = value => {
  if (typeof value === 'string') return value
  if (value !== null && typeof value === 'object') {
    if (typeof value.en === 'string') return value.en
    const first = Object.values(value).find(item => typeof item === 'string')
    if (typeof first === 'string') return first
  }
  return undefined
}
const clip = value => {
  const text = textOf(value)?.trim()
  return text === undefined || text === '' ? undefined : text.slice(0, MAX_TEXT)
}
const codeOf = error => typeof error?.code === 'string' ? error.code : undefined

export function normalizePluginInventory(plugins, bundles, unavailable) {
  return {
    scope: 'profile',
    readOnly: true,
    managementAvailable: unavailable === undefined,
    ...(unavailable === undefined ? {} : { unavailable }),
    entries: (Array.isArray(plugins) ? plugins : []).map(entry => ({
      name: clip(entry.meta?.title) ?? clip(entry.moduleName) ?? 'Plugin',
      moduleName: clip(entry.moduleName),
      description: clip(entry.meta?.description),
      enabled: entry.enabled === true,
      phase: typeof entry.fiberPhase === 'string' ? entry.fiberPhase : null,
      readOnly: entry.readOnlyReason !== undefined,
      ...(entry.readOnlyReason === undefined ? {} : { readOnlyReason: entry.readOnlyReason }),
      ...(clip(entry.meta?.error) === undefined ? {} : { metadataError: clip(entry.meta?.error) }),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    bundles: (Array.isArray(bundles) ? bundles : []).map(bundle => ({
      name: clip(bundle.meta?.title) ?? clip(bundle.name) ?? 'Bundle',
      packageName: clip(bundle.name),
      description: clip(bundle.meta?.description) ?? clip(bundle.description),
      version: clip(bundle.version),
      enabled: bundle.enabled === true,
      installed: bundle.installed === true,
      official: bundle.official === true,
      removable: bundle.removable === true,
      ...(codeOf(bundle.error) === undefined ? {} : { error: codeOf(bundle.error) }),
    })).sort((a, b) => a.name.localeCompare(b.name)),
  }
}

export function install(rt) {
  const { ctx } = rt

  let cache
  let cachedAt = 0
  let loading
  const empty = () => normalizePluginInventory([], [], 'The DSH plugin manager is not available in this profile.')

  const load = async (fresh = false) => {
    if (!fresh && cache !== undefined && Date.now() - cachedAt < CACHE_MS) return cache
    if (loading !== undefined) return loading
    loading = (async () => {
      const manager = ctx.get?.('pluginManager')
      if (typeof manager?.listPlugins !== 'function' || typeof manager?.listBundles !== 'function') {
        cache = empty()
      } else {
        try {
          const [plugins, bundles] = await Promise.all([manager.listPlugins(), manager.listBundles()])
          cache = normalizePluginInventory(plugins, bundles)
        } catch (error) {
          cache = normalizePluginInventory([], [], `Could not read the DSH plugin inventory: ${rt.redactSecrets?.(String(error?.message ?? error)) ?? error}`)
        }
      }
      cachedAt = Date.now()
      return cache
    })().finally(() => { loading = undefined })
    return loading
  }

  const inventoryView = () => cache ?? empty()
  ctx.on('plugin-manager/changed', () => {
    cache = undefined
    cachedAt = 0
  })

  ctx.tools.register(defineTool({
    name: 'plugin_list',
    description: 'List profile-wide DSH plugins and bundles. Read-only; profile plugin changes belong to the user in DSH settings.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const self = rt.selfOf(exec.agent?.id)
      if (!rt.botOf(self)) return 'Only Bots on the team can use plugin_list.'
      const value = await load()
      if (value.unavailable !== undefined) return value.unavailable
      const lines = [
        'Profile plugins are shared by every Session and Bot. Read-only inventory:',
        ...value.entries.map(entry => {
          const state = !entry.enabled ? 'disabled' : entry.phase === 'failed' ? 'failed' : entry.phase ?? 'not running'
          return `- ${entry.name} [${state}]${entry.description ? ` — ${entry.description}` : ''}`
        }),
      ]
      if (value.entries.length === 0) lines.push('- No running profile plugins were reported.')
      lines.push('', 'Bundles:')
      if (value.bundles.length === 0) lines.push('- No profile bundles were reported.')
      else lines.push(...value.bundles.map(bundle => `- ${bundle.name}${bundle.version ? ` ${bundle.version}` : ''}${bundle.enabled ? ' [enabled]' : ' [disabled]'}`))
      lines.push('', 'Only the user can install, enable, disable or remove profile plugins through DSH settings.')
      return lines.join('\n')
    },
  }))

  ctx.systemPrompt.section({
    name: 'bot-plugins',
    order: 648,
    text: context => rt.selfOf(context?.agent?.id) === undefined ? '' : [
      '# DSH plugins',
      '- plugin_list reports profile-wide plugins and bundles. It is read-only.',
      '- Never install, enable, disable or remove profile plugins, and never run package-manager commands for that purpose. Direct the user to DSH settings.',
    ].join('\n'),
  })

  Object.assign(rt, {
    pluginInventory: load,
    pluginInventoryView: inventoryView,
    pluginEndpoint: async (endpoint, body = {}) => {
      if (endpoint !== 'plugin-inventory') throw new Error('Unknown plugin operation.')
      return load(body.fresh === true)
    },
  })
}
