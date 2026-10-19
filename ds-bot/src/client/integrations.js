import { createElement as h, useEffect, useState } from 'react'
import { ChatsIcon, ConnectorIcon, CopyIcon, PlusIcon, SwitchIcon } from './icons.js'
import { MaskedInput } from './secret-card.js'
import { dateLocale, hostText, t } from './i18n.js'

const PROVIDERS = {
  github: {
    name: 'GitHub',
    icon: ConnectorIcon,
    events: 'issues, issue_comment, pull_request, pull_request_review, workflow_run, check_run',
  },
  slack: {
    name: 'Slack',
    icon: ChatsIcon,
    events: 'app_mention, message',
  },
  im: {
    name: 'IM',
    icon: SwitchIcon,
    events: '',
  },
}

const when = ms => new Intl.DateTimeFormat(dateLocale(), {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(ms)

const splitTarget = (value) => {
  const at = value.indexOf(':')
  return at === -1 ? ['bot', value] : [value.slice(0, at), value.slice(at + 1)]
}

function Field({ label, hint, children }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-integration-field' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, t(label)),
      hint ? h('span', { className: 'bt-set-hint' }, t(hint)) : null),
    children)
}

function SecretField({ label, configured, value, onChange }) {
  return h('div', { className: 'bt-set-row bt-bs-row bt-bs-stack bt-integration-field' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, t(label)),
      configured ? h('span', { className: 'bt-set-hint bt-integration-ready' }, t('Saved; leave blank to keep it')) : null),
    h('label', { className: 'bt-q-field bt-secret-field' }, h(MaskedInput, { value, onChange, label: t(label) })))
}

function blank(provider = 'github', roster) {
  return {
    provider,
    name: PROVIDERS[provider].name,
    target: `bot:${roster.bots[0]?.id ?? ''}`,
    events: PROVIDERS[provider].events,
    repos: '',
    channels: '',
    conversations: '',
    secret: '',
    signingSecret: '',
    botToken: '',
    outboundUrl: '',
    outboundToken: '',
    reply: true,
    enabled: true,
  }
}

function draftOf(item, roster) {
  if (item === undefined) return blank('github', roster)
  return {
    id: item.id,
    provider: item.provider,
    name: item.name,
    target: `${item.target.kind}:${item.target.id}`,
    events: (item.filters?.events ?? []).join(', '),
    repos: (item.filters?.repos ?? []).join(', '),
    channels: (item.filters?.channels ?? []).join(', '),
    conversations: (item.filters?.conversations ?? []).join(', '),
    secret: '',
    signingSecret: '',
    botToken: '',
    outboundUrl: '',
    outboundToken: '',
    reply: item.reply !== false,
    enabled: item.enabled,
  }
}

function IntegrationForm({ roster, actions, item, onClose }) {
  const [draft, setDraft] = useState(() => draftOf(item, roster))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const chooseProvider = (provider) => {
    const fresh = blank(provider, roster)
    setDraft(previous => ({
      ...previous,
      provider,
      name: previous.id === undefined ? fresh.name : previous.name,
      events: previous.id === undefined ? fresh.events : previous.events,
      target: previous.target || fresh.target,
    }))
  }
  useEffect(() => {
    const [kind, id] = splitTarget(draft.target)
    const targets = kind === 'room' ? roster.rooms : roster.bots
    if (targets.some(target => target.id === id)) return
    set('target', `bot:${roster.bots[0]?.id ?? ''}`)
  }, [roster.bots.length, roster.rooms.length])
  const submit = async (event) => {
    event.preventDefault()
    if (busy) return
    const [targetKind, target] = splitTarget(draft.target)
    setBusy(true)
    setError('')
    try {
      await actions.integrationSave({
        ...(draft.id === undefined ? {} : { id: draft.id }),
        provider: draft.provider,
        name: draft.name,
        targetKind,
        target,
        events: draft.events,
        repos: draft.repos,
        channels: draft.channels,
        conversations: draft.conversations,
        secret: draft.secret,
        signingSecret: draft.signingSecret,
        botToken: draft.botToken,
        outboundUrl: draft.outboundUrl,
        outboundToken: draft.outboundToken,
        reply: draft.reply,
        enabled: draft.enabled,
      })
      onClose()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
      setBusy(false)
    }
  }
  const configured = item?.secrets ?? {}
  return h('form', { className: 'bt-set-card bt-task-form bt-integration-form', onSubmit: submit },
    h(Field, { label: 'Provider' },
      h('select', { className: 'bt-select', value: draft.provider, disabled: item !== undefined, onChange: event => chooseProvider(event.target.value) },
        Object.entries(PROVIDERS).map(([id, provider]) => h('option', { key: id, value: id }, provider.name)))),
    h(Field, { label: 'Name' },
      h('input', { className: 'bt-input', value: draft.name, maxLength: 80, autoFocus: true, onChange: event => set('name', event.target.value) })),
    h(Field, { label: 'Target' },
      h('select', { className: 'bt-select', value: draft.target, onChange: event => set('target', event.target.value) },
        h('optgroup', { label: t('Bots') }, roster.bots.map(bot => h('option', { key: bot.id, value: `bot:${bot.id}` }, bot.name))),
        roster.rooms.length > 0 ? h('optgroup', { label: t('Group chats') }, roster.rooms.map(room => h('option', { key: room.id, value: `room:${room.id}` }, room.name))) : null)),
    draft.provider === 'github' ? h(SecretField, {
      label: 'GitHub webhook secret',
      configured: configured.GITHUB_WEBHOOK_SECRET,
      value: draft.secret,
      onChange: value => set('secret', value),
    }) : null,
    draft.provider === 'slack' ? h(SecretField, {
      label: 'Slack signing secret',
      configured: configured.SLACK_SIGNING_SECRET,
      value: draft.signingSecret,
      onChange: value => set('signingSecret', value),
    }) : null,
    draft.provider === 'slack' ? h(SecretField, {
      label: 'Slack bot token',
      configured: configured.SLACK_BOT_TOKEN,
      value: draft.botToken,
      onChange: value => set('botToken', value),
    }) : null,
    draft.provider === 'im' ? h(SecretField, {
      label: 'IM webhook secret',
      configured: configured.IM_WEBHOOK_SECRET,
      value: draft.signingSecret,
      onChange: value => set('signingSecret', value),
    }) : null,
    draft.provider === 'im' ? h(SecretField, {
      label: 'IM outbound webhook URL',
      configured: configured.IM_OUTBOUND_URL,
      value: draft.outboundUrl,
      onChange: value => set('outboundUrl', value),
    }) : null,
    draft.provider === 'im' ? h(SecretField, {
      label: 'IM outbound token (optional)',
      configured: configured.IM_OUTBOUND_TOKEN,
      value: draft.outboundToken,
      onChange: value => set('outboundToken', value),
    }) : null,
    draft.provider === 'github' ? h(Field, { label: 'Events', hint: 'Comma-separated GitHub event names; leave a list empty to allow every event in the list.' },
      h('input', { className: 'bt-input', value: draft.events, onChange: event => set('events', event.target.value) })) : null,
    draft.provider === 'slack' ? h(Field, { label: 'Events', hint: 'app_mention and message' },
      h('input', { className: 'bt-input', value: draft.events, onChange: event => set('events', event.target.value) })) : null,
    draft.provider === 'github' ? h(Field, { label: 'Repositories', hint: 'Optional owner/repository filters, separated by commas.' },
      h('input', { className: 'bt-input', value: draft.repos, onChange: event => set('repos', event.target.value) })) : null,
    draft.provider === 'slack' ? h(Field, { label: 'Channels', hint: 'Optional Slack channel IDs, separated by commas.' },
      h('input', { className: 'bt-input', value: draft.channels, onChange: event => set('channels', event.target.value) })) : null,
    draft.provider === 'im' ? h(Field, { label: 'Conversations', hint: 'Optional conversation IDs, separated by commas.' },
      h('input', { className: 'bt-input', value: draft.conversations, onChange: event => set('conversations', event.target.value) })) : null,
    draft.provider !== 'github' ? h('div', { className: 'bt-set-row bt-integration-options' },
      h('label', { className: 'bt-check' },
        h('input', { type: 'checkbox', checked: draft.reply, onChange: event => set('reply', event.target.checked) }),
        h('span', null, t('Send Bot replies back')))) : null,
    h('div', { className: 'bt-set-row bt-integration-options' },
      h('label', { className: 'bt-check' },
        h('input', { type: 'checkbox', checked: draft.enabled, onChange: event => set('enabled', event.target.checked) }),
        h('span', null, t('Enabled')))),
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint', role: 'alert' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', {
        type: 'submit',
        className: 'bt-send bt-soft-sm',
        disabled: busy || draft.name.trim() === '' || draft.target === '' || roster.bots.length === 0,
      }, busy ? t('Saving…') : item ? t('Save changes') : t('Add integration'))))
}

function IntegrationRow({ item, actions, onEdit }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [copied, setCopied] = useState(false)
  const Mark = PROVIDERS[item.provider]?.icon ?? ConnectorIcon
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const operate = (task) => {
    if (busy) return
    setBusy(true)
    setError('')
    void task.then(() => setBusy(false), failure => {
      setError(hostText(failure?.message ?? String(failure)))
      setBusy(false)
    })
  }
  const remove = () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    operate(actions.integrationDelete(item.id))
  }
  const copy = () => {
    void navigator.clipboard?.writeText(item.endpoint).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    }).catch(() => {})
  }
  const state = !item.enabled ? t('Disabled') : !item.configured ? t('Needs credentials') : item.ready ? t('Ready') : t('Target missing')
  const filters = [
    ...(item.filters?.events ?? []),
    ...(item.filters?.repos ?? []),
    ...(item.filters?.channels ?? []),
    ...(item.filters?.conversations ?? []),
  ]
  return h('div', { className: 'bt-connector bt-integration-row', 'data-state': item.ready ? 'ready' : item.enabled ? 'off' : 'disabled' },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-mark' }, h(Mark)),
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, item.name),
        h('span', { className: 'bt-connector-status' }, `${item.providerName} · ${state} → ${item.targetName ?? t('missing target')}`)),
      h('span', { className: 'bt-connector-actions' },
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'bt-switch bt-automation-switch',
          'aria-checked': item.enabled,
          'aria-label': t('Enable {name}', { name: item.name }),
          disabled: busy,
          onClick: () => operate(actions.integrationToggle(item.id, !item.enabled)),
        }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true })),
        item.provider !== 'github' && item.enabled ? h('button', {
          type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy,
          onClick: () => operate(actions.integrationTest(item.id)),
        }, t('Test')) : null,
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: onEdit }, t('Edit')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: remove }, confirming ? t('Click again to delete.') : t('Delete')))),
    h('div', { className: 'bt-integration-endpoint' },
      h('code', { title: item.endpoint }, item.endpoint),
      h('button', {
        type: 'button',
        className: 'bt-mini bt-integration-copy',
        'aria-label': t('Copy webhook URL'),
        title: t('Copy webhook URL'),
        onClick: copy,
      }, h(CopyIcon)),
      copied ? h('span', { className: 'bt-set-hint', role: 'status' }, t('Copied')) : null),
    h('span', { className: 'bt-set-hint' },
      [filters.length > 0 ? filters.slice(0, 5).join(' · ') : t('All matching events'),
        item.lastDelivery ? t('Last delivery {time} · {status}', { time: when(item.lastDelivery.at), status: item.lastDelivery.status }) : t('No deliveries yet')].join(' · ')),
    item.lastError ? h('div', { className: 'bt-connector-error', role: 'alert' }, item.lastError) : null,
    error ? h('div', { className: 'bt-connector-error', role: 'alert' }, error) : null)
}

export function IntegrationsSection({ roster, actions }) {
  const view = roster.integrations ?? { available: true, items: [] }
  const [editing, setEditing] = useState(null)
  if (view.available === false) return null
  const items = view.items ?? []
  return h('section', { className: 'bt-set-section' },
    h('div', { className: 'bt-integration-heading' },
      h('h3', null, t('Inbound integrations')),
      h('button', {
        type: 'button',
        className: 'bt-soft bt-soft-sm bt-with-icon',
        disabled: roster.bots.length === 0,
        onClick: () => setEditing({}),
      }, h(PlusIcon), t('Add integration'))),
    editing !== null ? h(IntegrationForm, {
      key: editing.id ?? 'new',
      roster,
      actions,
      item: editing.id ? editing : undefined,
      onClose: () => setEditing(null),
    }) : null,
    h('div', { className: 'bt-set-card bt-connectors-card' },
      items.length === 0
        ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No inbound integrations yet.')))
        : items.map(item => h(IntegrationRow, { key: item.id, item, actions, onEdit: () => setEditing(item) }))))
}

export const INTEGRATION_CSS = `
.bt-integration-heading{display:flex;align-items:center;justify-content:space-between;gap:12px}
.bt-integration-form .bt-input,.bt-integration-form .bt-select,.bt-integration-form .bt-secret{width:100%;box-sizing:border-box}
.bt-integration-form .bt-secret-field{width:100%}
.bt-integration-options{align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px}
.bt-integration-ready{color:var(--bt-ink-2)}
.bt-integration-row{gap:8px}
.bt-integration-row[data-state=disabled]{opacity:.68}
.bt-integration-endpoint{display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap}
.bt-integration-endpoint code{min-width:0;max-width:100%;overflow-wrap:anywhere;font-size:11px;line-height:16px;padding:4px 7px;border:1px solid var(--bt-line);border-radius:6px;background:var(--bt-card);color:var(--bt-ink-2);font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
.bt-integration-copy{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;color:var(--bt-ink-2)}
.bt-integration-copy svg{width:14px;height:14px}
.bt-integration-event{flex-wrap:wrap;gap:6px}
@media (max-width:760px){
  .bt-integration-heading{align-items:flex-start;flex-wrap:wrap}
  .bt-integration-row .bt-connector-actions{width:100%;justify-content:flex-end}
  .bt-integration-row .bt-soft,.bt-integration-row .bt-switch{min-height:44px}
  .bt-integration-copy{width:44px;height:44px}
}
`
