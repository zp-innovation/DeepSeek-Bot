import { createElement as h, useEffect, useState } from 'react'
import { PlusIcon } from './icons.js'
import { dateLocale, hostText, t } from './i18n.js'

const TRIGGERS = [
  ['turn_completed', 'Bot finishes a turn'],
  ['turn_failed', 'A turn fails'],
  ['turn_aborted', 'A turn is stopped'],
  ['approval_requested', 'A Bot asks for approval'],
  ['schedule_delivered', 'A scheduled task runs'],
  ['background_job', 'A background job finishes'],
  ['user_message', 'You send a message'],
]
const triggerLabel = kind => t(TRIGGERS.find(([id]) => id === kind)?.[1] ?? kind)
const when = ms => new Intl.DateTimeFormat(dateLocale(), {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(ms)
const blank = () => ({
  name: '',
  triggerKind: 'turn_failed',
  sourceBot: '',
  contains: '',
  targetKind: 'bot',
  target: '',
  prompt: '',
  cooldownSeconds: 60,
  enabled: true,
  originalId: undefined,
})

function Field({ label, hint, children }) {
  return h('label', { className: 'bt-set-row bt-bs-row bt-bs-stack' },
    h('span', { className: 'bt-set-copy' },
      h('span', { className: 'bt-bs-label' }, t(label)),
      hint ? h('span', { className: 'bt-set-hint' }, t(hint)) : null),
    children)
}

function RuleForm({ roster, actions, rule, onClose }) {
  const [draft, setDraft] = useState(() => rule ? {
    name: rule.name,
    triggerKind: rule.trigger.kind,
    sourceBot: rule.trigger.sourceBotId ?? '',
    contains: rule.trigger.contains ?? '',
    targetKind: rule.target.kind,
    target: rule.targetName ?? '',
    prompt: rule.prompt,
    cooldownSeconds: rule.cooldownSeconds,
    enabled: rule.enabled,
    originalId: rule.id,
  } : {
    ...blank(),
    target: roster.bots[0]?.name ?? '',
  })
  const [error, setError] = useState('')
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const targets = draft.targetKind === 'bot' ? roster.bots.map(bot => bot.name) : roster.rooms.map(room => room.name)
  useEffect(() => {
    if (targets.includes(draft.target)) return
    set('target', targets[0] ?? '')
  }, [draft.targetKind, roster.bots.length, roster.rooms.length])
  const submit = async event => {
    event.preventDefault()
    setError('')
    try {
      await actions.automationSave({
        ...(draft.originalId === undefined ? {} : { id: draft.originalId }),
        name: draft.name,
        triggerKind: draft.triggerKind,
        sourceBot: draft.sourceBot,
        contains: draft.contains,
        targetKind: draft.targetKind,
        target: draft.target,
        prompt: draft.prompt,
        cooldownSeconds: Number(draft.cooldownSeconds),
        enabled: draft.enabled,
      })
      onClose()
    } catch (failure) {
      setError(hostText(failure?.message ?? String(failure)))
    }
  }
  return h('form', { className: 'bt-set-card bt-task-form bt-automation-form', onSubmit: submit },
    h(Field, { label: 'Name' },
      h('input', { className: 'bt-input', value: draft.name, maxLength: 80, autoFocus: true, onChange: event => set('name', event.target.value) })),
    h(Field, { label: 'Event' },
      h('select', { className: 'bt-select', value: draft.triggerKind, onChange: event => set('triggerKind', event.target.value) },
        TRIGGERS.map(([id, label]) => h('option', { key: id, value: id }, t(label))))),
    h(Field, { label: 'Source Bot', hint: 'Leave empty to watch every Bot.' },
      h('select', { className: 'bt-select', value: draft.sourceBot, onChange: event => set('sourceBot', event.target.value) },
        h('option', { value: '' }, t('Any Bot')),
        roster.bots.map(bot => h('option', { key: bot.id, value: bot.name }, bot.name)))),
    h(Field, { label: 'Text contains', hint: 'Optional case-insensitive filter.' },
      h('input', { className: 'bt-input', value: draft.contains, maxLength: 200, onChange: event => set('contains', event.target.value) })),
    h('div', { className: 'bt-set-row bt-automation-target' },
      h('label', { className: 'bt-set-copy' },
        h('span', { className: 'bt-bs-label' }, t('Send to')),
        h('select', { className: 'bt-select', value: draft.targetKind, onChange: event => set('targetKind', event.target.value) },
          h('option', { value: 'bot' }, t('Bot')),
          h('option', { value: 'room' }, t('Group chat')))),
      h('select', { className: 'bt-select', value: draft.target, onChange: event => set('target', event.target.value), 'aria-label': t('Automation target') },
        targets.map(name => h('option', { key: name, value: name }, name)))),
    h(Field, { label: 'Prompt', hint: 'Available tokens: {{rule}} {{event}} {{status}} {{bot}} {{room}} {{text}} {{time}}' },
      h('textarea', { className: 'bt-input bt-input-area', rows: 4, value: draft.prompt, onChange: event => set('prompt', event.target.value) })),
    h('div', { className: 'bt-set-row bt-automation-options' },
      h('label', { className: 'bt-check' },
        h('input', { type: 'checkbox', checked: draft.enabled, onChange: event => set('enabled', event.target.checked) }),
        h('span', null, t('Enabled'))),
      h('label', { className: 'bt-check bt-automation-cooldown' },
        h('span', null, t('Cooldown (seconds)')),
        h('input', { className: 'bt-input', type: 'number', min: 0, max: 604800, value: draft.cooldownSeconds, onChange: event => set('cooldownSeconds', event.target.value) }))),
    error ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-danger bt-set-hint', role: 'alert' }, error)) : null,
    h('div', { className: 'bt-set-row bt-task-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', { type: 'submit', className: 'bt-send bt-soft-sm', disabled: draft.name.trim() === '' || draft.prompt.trim() === '' || draft.target === '' },
        draft.originalId ? t('Save changes') : t('Create automation'))))
}

function RuleRow({ rule, actions, run, onEdit }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const remove = () => {
    if (!confirming) { setConfirming(true); return }
    setConfirming(false)
    void run(actions.automationDelete(rule.id))
  }
  const filter = rule.trigger.contains ? ` · ${t('contains “{text}”', { text: rule.trigger.contains })}` : ''
  const source = rule.sourceBotName ? ` · ${t('from {name}', { name: rule.sourceBotName })}` : ''
  return h('div', { className: 'bt-connector bt-automation-rule', 'data-disabled': !rule.enabled || undefined },
    h('div', { className: 'bt-connector-head' },
      h('span', { className: 'bt-connector-text' },
        h('span', { className: 'bt-connector-name' }, rule.name),
        h('span', { className: 'bt-connector-status' },
          `${triggerLabel(rule.trigger.kind)}${source}${filter} → ${rule.targetName}`)),
      h('span', { className: 'bt-connector-actions' },
        h('button', {
          type: 'button',
          role: 'switch',
          className: 'bt-switch bt-automation-switch',
          'aria-checked': rule.enabled,
          'aria-label': t('Enable {name}', { name: rule.name }),
          onClick: () => void run(actions.automationToggle(rule.id, !rule.enabled)),
        }, h('span', { className: 'bt-switch-knob', 'aria-hidden': true })),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => onEdit(rule) }, t('Edit')),
        h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: remove }, confirming ? t('Click again to delete.') : t('Delete')))),
    h('span', { className: 'bt-set-hint' },
      [rule.lastRunAt ? t('Last run {time} · {status}', { time: when(rule.lastRunAt), status: rule.lastStatus ?? '' }) : t('Never run'),
        t('Runs {count}', { count: rule.runCount ?? 0 })].join(' · ')))
}

function RunList({ runs }) {
  if (runs.length === 0) return null
  return h('section', { className: 'bt-set-section' },
    h('h3', null, t('Recent automation runs')),
    h('div', { className: 'bt-set-card' },
      runs.slice(0, 8).map(item => h('div', { key: item.id, className: 'bt-set-row bt-automation-run' },
        h('span', { className: 'bt-set-copy' },
          h('span', { className: 'bt-task-title' }, item.ruleName),
          h('span', { className: 'bt-set-hint' }, [triggerLabel(item.eventKind), item.target, item.error].filter(Boolean).join(' · '))),
        h('span', { className: 'bt-task-next' }, `${when(item.startedAt)} · ${item.status}`)))))
}

export function AutomationRulesPanel({ roster, actions, run }) {
  const view = roster.automations ?? { rules: [], runs: [] }
  const rules = [...(view.rules ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  const [editing, setEditing] = useState(null)
  const [error, setError] = useState('')
  const execute = run ?? (promise => Promise.resolve(promise).catch(failure => {
    setError(hostText(failure?.message ?? String(failure)))
    return false
  }))
  return [
    error ? h('div', { key: 'error', className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    h('div', { key: 'action', className: 'bt-actions' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: () => setEditing({}) }, h(PlusIcon), t('New automation'))),
    editing ? h(RuleForm, {
      key: editing.id ?? 'new',
      roster,
      actions,
      rule: editing.id ? editing : undefined,
      onClose: () => setEditing(null),
    }) : null,
    h('section', { key: 'rules', className: 'bt-set-section' },
      h('h3', null, t('Event automations · {count}', { count: rules.length })),
      h('div', { className: 'bt-set-card bt-connectors-card' },
        rules.length === 0
          ? h('div', { className: 'bt-set-row' }, h('span', { className: 'bt-set-hint' }, t('No event automations yet.')))
          : rules.map(rule => h(RuleRow, { key: rule.id, rule, actions, run: execute, onEdit: setEditing })))),
    h(RunList, { key: 'runs', runs: view.runs ?? [] }),
  ]
}

export const AUTOMATION_CSS = `
.bt-automation-form .bt-select{max-width:100%}
.bt-automation-form .bt-input{width:100%;box-sizing:border-box}
.bt-automation-form .bt-select{width:100%}
.bt-automation-target{display:grid;grid-template-columns:minmax(0,1fr) minmax(180px,1fr);gap:8px}
.bt-automation-options{align-items:center;justify-content:space-between;flex-wrap:wrap}
.bt-automation-cooldown{gap:8px}
.bt-automation-cooldown .bt-input{width:100px;height:32px}
.bt-automation-rule[data-disabled]{opacity:.58}
.bt-automation-switch{min-height:28px}
.bt-automation-run{gap:12px}
@media (max-width:760px){.bt-automation-target{grid-template-columns:minmax(0,1fr)}.bt-automation-rule .bt-connector-actions{width:100%;justify-content:flex-end}}
`
