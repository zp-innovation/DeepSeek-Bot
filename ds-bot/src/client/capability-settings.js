import { createElement as h, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { RecipesPage, BotRecipesCard } from './recipe-settings.js'

const SKILL_MD_EXAMPLE = ['---', 'name: my-skill', 'description: What it does', '---', '', 'Instructions'].join('\n')

const blank = () => ({
  name: '',
  kind: 'mcp',
  description: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '{}',
  url: '',
  headersText: '{}',
  content: '',
  whenToUse: '',
  modelInvocable: true,
  userInvocable: true,
  metadataText: '{}',
  items: [],
})
const parseMap = (text, label) => {
  let value
  try { value = JSON.parse(text || '{}') } catch { throw new Error(t('{label} must be valid JSON.', { label })) }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('{label} must be a JSON object.', { label }))
  return value
}
const statusText = status => !status ? undefined : status.state === 'ready' ? t('Ready')
  : status.state === 'needs-approval' ? t('Needs approval')
    : status.state === 'error' ? t('Could not connect: {error}', { error: status.error ?? '' })
      : t('Connecting…')

function Field({ label, value, onChange, multiline = false, disabled = false, placeholder }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t(label))),
    h(multiline ? 'textarea' : 'input', {
      className: multiline ? 'bt-input bt-input-area' : 'bt-input',
      value,
      disabled,
      maxLength: label === 'Name' ? 32 : undefined,
      placeholder,
      spellCheck: false,
      onChange: event => onChange(event.target.value),
    }))
}

function CapabilityForm({ draft, setDraft, items, actions, onClose }) {
  const [error, setError] = useState('')
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const submit = async event => {
    event.preventDefault()
    setError('')
    let payload
    try {
      payload = { name: draft.name.trim(), kind: draft.kind, description: draft.description }
      if (draft.kind === 'mcp' && draft.transport === 'stdio') {
        payload.transport = 'stdio'
        payload.command = draft.command
        payload.args = draft.argsText.split('\n').filter(line => line !== '')
        payload.env = parseMap(draft.envText, t('Environment'))
      } else if (draft.kind === 'mcp') {
        payload.transport = 'streamable-http'
        payload.url = draft.url
        payload.headers = parseMap(draft.headersText, t('Headers'))
      } else if (draft.kind === 'skill') {
        payload.content = draft.content
        if (draft.whenToUse.trim() !== '') payload.whenToUse = draft.whenToUse
        payload.invocation = { modelInvocable: draft.modelInvocable, userInvocable: draft.userInvocable }
        payload.metadata = parseMap(draft.metadataText, t('Metadata'))
      } else payload.items = draft.items
    } catch (failure) {
      setError(failure?.message ?? String(failure))
      return
    }
    try {
      await actions.saveCapability(payload)
      onClose()
    } catch (failure) {
      setError(failure?.message ?? String(failure))
    }
  }
  const available = items.filter(item => item.name !== draft.name && ['mcp', 'skill'].includes(item.kind))
  return h('form', { className: 'bt-connector-form', onSubmit: submit },
    h(Field, { label: 'Name', value: draft.name, disabled: draft.originalName !== undefined, onChange: value => set('name', value), placeholder: 'my-tool' }),
    h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Type'))),
      h('select', { className: 'bt-input', value: draft.kind, disabled: draft.originalName !== undefined, onChange: event => set('kind', event.target.value) },
        ['mcp', 'skill', 'pack'].map(kind => h('option', { key: kind, value: kind }, t(kind === 'mcp' ? 'MCP server' : kind === 'skill' ? 'Skill' : 'Pack'))))),
    h(Field, { label: 'Description', value: draft.description, onChange: value => set('description', value) }),
    draft.kind === 'mcp' ? h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
      h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Connection'))),
      h('select', { className: 'bt-input', value: draft.transport, onChange: event => set('transport', event.target.value) },
        h('option', { value: 'stdio' }, t('Local command')),
        h('option', { value: 'streamable-http' }, t('HTTP server')))) : null,
    draft.kind === 'mcp' && draft.transport === 'stdio' ? h('div', null,
      h(Field, { label: 'Command', value: draft.command, onChange: value => set('command', value) }),
      h(Field, { label: 'Arguments (one per line)', value: draft.argsText, onChange: value => set('argsText', value), multiline: true }),
      h(Field, { label: 'Environment (JSON)', value: draft.envText, onChange: value => set('envText', value), multiline: true, placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}') })) : null,
    draft.kind === 'mcp' && draft.transport === 'streamable-http' ? h('div', null,
      h(Field, { label: 'URL', value: draft.url, onChange: value => set('url', value) }),
      h(Field, { label: 'Headers (JSON)', value: draft.headersText, onChange: value => set('headersText', value), multiline: true, placeholder: t('{"API_KEY": "$DSH_SECRET_MY_KEY"}') })) : null,
    draft.kind === 'skill' ? h('div', null,
      h(Field, {
        label: 'SKILL.md or instructions',
        value: draft.content,
        onChange: value => set('content', value),
        multiline: true,
        placeholder: SKILL_MD_EXAMPLE,
      }),
      h(Field, { label: 'When to use', value: draft.whenToUse, onChange: value => set('whenToUse', value) }),
      h(Field, { label: 'Metadata (JSON)', value: draft.metadataText, onChange: value => set('metadataText', value), multiline: true, placeholder: '{}' }),
      h('div', { className: 'bt-set-row bt-bs-row' },
        h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, t('Invocation'))),
        h('div', { className: 'bt-skill-policy' },
          h('label', { className: 'bt-check' },
            h('input', { type: 'checkbox', checked: draft.modelInvocable, onChange: event => set('modelInvocable', event.target.checked) }),
            h('span', null, t('Model'))),
          h('label', { className: 'bt-check' },
            h('input', { type: 'checkbox', checked: draft.userInvocable, onChange: event => set('userInvocable', event.target.checked) }),
            h('span', null, t('User (/name)'))))),
      h('div', { className: 'bt-set-hint' }, t('SKILL.md frontmatter takes precedence over these fields. Project .agents/skills and .dsh/skills remain available through DSH discovery.'))) : null,
    draft.kind === 'pack' ? h('div', { className: 'bt-set-card' },
      available.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('Save an MCP server or skill first.')))
        : available.map(item => h('label', { key: item.name, className: 'bt-set-row bt-bs-row' },
          h('span', { className: 'bt-set-copy' }, h('span', { className: 'bt-bs-label' }, item.name)),
          h('input', { type: 'checkbox', checked: draft.items.includes(item.name), onChange: event => set('items', event.target.checked ? [...draft.items, item.name] : draft.items.filter(name => name !== item.name)) })))) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null,
    h('div', { className: 'bt-connector-form-row' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-soft bt-soft-sm' }, draft.originalName ? t('Save changes') : t('Add capability'))))
}

function CapabilityRow({ item, onEdit, onDelete, onApprove, confirming }) {
  const detail = item.kind === 'pack' ? `${t('Pack')}: ${(item.items ?? []).join(', ') || t('No items')}`
    : item.kind === 'mcp' ? item.transport === 'stdio' ? t('Local command') : t('HTTP server')
      : t('Skill')
  const skillPolicy = item.kind === 'skill'
    ? item.invocation?.userInvocable === false ? t('Model only')
      : item.invocation?.modelInvocable === false ? t('User only') : t('Model and user')
    : ''
  const secondary = item.kind === 'pack'
    ? [item.description, (item.items ?? []).join(', ') || t('No items')].filter(Boolean).join(' · ')
    : [item.description || detail, item.whenToUse ? t('Use when {when}', { when: item.whenToUse }) : '', skillPolicy].filter(Boolean).join(' · ')
  return h('div', { className: 'bt-connector' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, item.name),
        h('span', { className: 'bt-connector-status' }, secondary)),
      h('span', { className: 'bt-connector-actions' },
        item.kind === 'mcp' && item.transport === 'stdio' && !item.approved
          ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onApprove }, t('Allow')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onEdit }, t('Edit')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onDelete }, confirming ? t('Click again to delete.') : t('Delete')))))
}

export function CapabilitiesPage({ roster, actions, run }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [draft, setDraft] = useState(null)
  const [confirming, setConfirming] = useState('')
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(''), 4000)
    return () => clearTimeout(timer)
  }, [confirming])
  const startNew = () => setDraft(blank())
  const edit = item => setDraft({
    ...blank(),
    ...item,
    originalName: item.name,
    argsText: (item.args ?? []).join('\n'),
    envText: JSON.stringify(item.env ?? {}, null, 2),
    headersText: JSON.stringify(item.headers ?? {}, null, 2),
    whenToUse: item.whenToUse ?? '',
    modelInvocable: item.invocation?.modelInvocable !== false,
    userInvocable: item.invocation?.userInvocable !== false,
    metadataText: JSON.stringify(item.metadata ?? {}, null, 2),
    items: [...(item.items ?? [])],
  })
  const remove = item => {
    if (confirming !== item.name) { setConfirming(item.name); return }
    setConfirming('')
    void run(actions.deleteCapability(item.name))
  }
  return [
    h('section', { key: 'capabilities', className: 'bt-set-section' },
      h('h3', null, t('Shared capabilities')),
      h('div', { className: 'bt-actions' },
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: startNew }, t('Add capability'))),
      draft ? h(CapabilityForm, { draft, setDraft, items, actions, onClose: () => setDraft(null) }) : null,
      h('div', { className: 'bt-set-card bt-connectors-card' },
        items.length === 0 ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No capabilities saved')))
          : items.map(item => h(CapabilityRow, {
            key: item.name,
            item,
            confirming: confirming === item.name,
            onEdit: () => edit(item),
            onDelete: () => remove(item),
            onApprove: () => void run(actions.approveCapability(item.name)),
          })))),
    h(RecipesPage, { key: 'recipes', roster, actions, run }),
  ]
}

export function BotCapabilitiesCard({ bot, roster, actions, run, Card, SwitchRow }) {
  const items = [...(roster.capabilities ?? [])].sort((a, b) => Number(b.kind === 'pack') - Number(a.kind === 'pack') || a.name.localeCompare(b.name))
  const attached = new Set(bot.capabilities ?? [])
  const statuses = roster.capabilityStatuses?.[bot.id] ?? {}
  const cards = []
  if (items.length > 0) {
    cards.push(h(Card, { key: 'capabilities', title: t('Capabilities') },
      items.map(item => h(SwitchRow, {
        key: item.name,
        label: item.name,
        hint: attached.has(item.name) ? statusText(statuses[item.name]) : undefined,
        on: attached.has(item.name),
        onChange: enabled => void run(actions.setBotCapability(bot.id, item.name, enabled)),
      }))))
  }
  cards.push(h(BotRecipesCard, { key: 'recipes', bot, roster, actions, run, Card, SwitchRow }))
  return cards
}
