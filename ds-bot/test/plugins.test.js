import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { normalizePluginInventory } from '../src/host/plugins.js'
import { fakeContext } from './fake-ctx.js'

async function setup(pluginManager) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-plugins-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify({
    version: 1,
    mainBotIds: ['chief'],
    bots: { chief: { id: 'chief', sessionId: 'chief', name: 'Chief', createdAt: 1 } },
    rooms: {},
    agents: {},
    exchanges: [],
    exchangeTurns: {},
    questions: {},
    revision: 1,
  }))
  const ctx = fakeContext({ services: pluginManager === undefined ? {} : { pluginManager } })
  const rt = createRuntime(ctx, { home, github: false, diagnosticsFile: false })
  await rt.load()
  return {
    ctx,
    rt,
    async dispose() {
      await ctx.dispose()
      rmSync(home, { recursive: true, force: true, maxRetries: 5 })
    },
  }
}

test('plugin inventory is normalized to a read-only profile view', () => {
  const value = normalizePluginInventory([
    {
      moduleName: 'alpha',
      meta: { title: { en: 'Alpha', zh: '甲' }, description: 'First' },
      enabled: true,
      fiberPhase: 'active',
      patchId: 'alpha-row',
    },
    {
      moduleName: 'beta',
      enabled: false,
      fiberPhase: null,
      readOnlyReason: 'management-required',
    },
  ], [
    { name: 'bundle-a', version: '1.2.3', enabled: true, installed: true, removable: true, official: false, rows: [] },
  ])
  assert.equal(value.scope, 'profile')
  assert.equal(value.readOnly, true)
  assert.equal(value.managementAvailable, true)
  assert.deepEqual(value.entries.map(entry => [entry.name, entry.enabled, entry.phase, entry.readOnly]), [
    ['Alpha', true, 'active', false],
    ['beta', false, null, true],
  ])
  assert.deepEqual(value.bundles.map(bundle => [bundle.name, bundle.version, bundle.enabled]), [['bundle-a', '1.2.3', true]])
})

test('plugin tools read the manager without exposing profile mutation operations', async t => {
  let reads = 0
  const mutation = () => { throw new Error('mutation must not run') }
  const manager = {
    async listPlugins() {
      reads += 1
      return [{ moduleName: 'alpha', meta: { title: 'Alpha', description: 'Plugin A' }, enabled: true, fiberPhase: 'active', patchId: 'a' }]
    },
    async listBundles() {
      return [{ name: 'bundle-a', version: '1.0.0', enabled: true, installed: true, removable: true, official: false, rows: [] }]
    },
    installBundle: mutation,
    removeBundle: mutation,
    setPluginEnabled: mutation,
  }
  const env = await setup(manager)
  t.after(() => env.dispose())
  const tool = env.ctx.registeredTools.get('plugin_list')
  const listed = await tool.execute({}, { agent: { session: { header: { id: 'chief' } }, id: 'chief' } })
  assert.match(listed, /Profile plugins are shared.*Read-only inventory/)
  assert.match(listed, /Alpha \[active\] — Plugin A/)
  assert.match(listed, /bundle-a 1\.0\.0 \[enabled\]/)
  assert.equal(reads, 1)
  await env.rt.pluginInventory()
  assert.equal(reads, 1)
  env.ctx.emit('plugin-manager/changed', { reason: 'plugin' })
  await env.rt.pluginInventory()
  assert.equal(reads, 2)
})

test('plugin inventory degrades when no manager is present and refuses DSH Agent sessions', async t => {
  const env = await setup()
  t.after(() => env.dispose())
  const value = await env.rt.pluginEndpoint('plugin-inventory', { fresh: true })
  assert.equal(value.managementAvailable, false)
  assert.match(value.unavailable, /not available/)
  const tool = env.ctx.registeredTools.get('plugin_list')
  assert.match(await tool.execute({}, { agent: { id: 'outside' } }), /Only Bots on the team/)
})
