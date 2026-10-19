import { createElement as h, useEffect, useState } from 'react'
import { ChevronRightIcon, PlusIcon, TrashIcon } from './icons.js'
import { Segmented } from './motion.js'
import { dateLocale, hostText, t } from './i18n.js'

const number = value => new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 1 }).format(value ?? 0)
const rate = value => `${number(value ?? 0)}%`
const duration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${(ms / 60_000).toFixed(1)} min`
}
const when = ms => new Intl.DateTimeFormat(dateLocale(), {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(ms)
const tokenText = n => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n ?? 0)
const STATUS_LABELS = {
  completed: 'Completed',
  failed: 'Failed',
  running: 'Running',
  cancelled: 'Cancelled',
  interrupted: 'Interrupted',
  passed: 'Passed',
}
const statusLabel = value => t(STATUS_LABELS[value] ?? value)
const CHECKS = {
  completed: 'Completed',
  'no-tool-errors': 'No tool errors',
  contains: 'Contains',
  'not-contains': 'Does not contain',
  regex: 'Matches regex',
  'not-regex': 'Does not match regex',
  'required-tools': 'Required tools used',
  'forbidden-tools': 'Forbidden tools avoided',
  duration: 'Within time limit',
  tokens: 'Within token budget',
}

const blankCase = () => ({
  id: undefined,
  name: '',
  prompt: '',
  contains: '',
  notContains: '',
  regex: '',
  notRegex: '',
  requiredTools: '',
  forbiddenTools: '',
  maxDurationMs: '',
  maxTokens: '',
})

const blankSuite = roster => ({
  name: '',
  description: '',
  targetBotId: roster.bots[0]?.id ?? '',
  cases: [{ ...blankCase(), name: 'Main answer', prompt: '' }],
})

function draftOf(suite) {
  return {
    id: suite.id,
    name: suite.name,
    description: suite.description ?? '',
    targetBotId: suite.targetBotId,
    cases: suite.cases.map(item => ({
      ...blankCase(),
      ...item,
      requiredTools: (item.requiredTools ?? []).join(', '),
      forbiddenTools: (item.forbiddenTools ?? []).join(', '),
      maxDurationMs: item.maxDurationMs ?? '',
      maxTokens: item.maxTokens ?? '',
    })),
  }
}

function Field({ label, hint, children, wide = false }) {
  return h('label', { className: `bt-eval-field${wide ? ' bt-eval-wide' : ''}` },
    h('span', { className: 'bt-eval-label' }, t(label)),
    hint ? h('span', { className: 'bt-eval-hint' }, t(hint)) : null,
    children)
}

function CaseEditor({ item, index, onChange, onRemove, canRemove }) {
  const set = (key, value) => onChange({ ...item, [key]: value })
  return h('details', { className: 'bt-eval-case', open: index === 0 },
    h('summary', null,
      h('span', null, `${t('Case {count}', { count: index + 1 })} · ${item.name || t('Untitled')}`),
      item.contains ? h('span', { className: 'bt-tag' }, t('Contains check')) : null,
      item.requiredTools ? h('span', { className: 'bt-tag' }, t('Tool check')) : null),
    h('div', { className: 'bt-eval-case-body' },
      h(Field, { label: 'Case name' },
        h('input', { className: 'bt-input', value: item.name, maxLength: 80, onChange: event => set('name', event.target.value) })),
      h(Field, { label: 'Prompt', hint: 'The exact task the temporary evaluation Session receives.', wide: true },
        h('textarea', { className: 'bt-input bt-input-area', rows: 4, value: item.prompt, onChange: event => set('prompt', event.target.value) })),
      h(Field, { label: 'Answer contains' },
        h('input', { className: 'bt-input', value: item.contains, onChange: event => set('contains', event.target.value) })),
      h(Field, { label: 'Answer must not contain' },
        h('input', { className: 'bt-input', value: item.notContains, onChange: event => set('notContains', event.target.value) })),
      h(Field, { label: 'Answer matches regex' },
        h('input', { className: 'bt-input bt-mono', value: item.regex, onChange: event => set('regex', event.target.value) })),
      h(Field, { label: 'Answer must not match regex' },
        h('input', { className: 'bt-input bt-mono', value: item.notRegex, onChange: event => set('notRegex', event.target.value) })),
      h(Field, { label: 'Required tools', hint: 'Comma-separated tool names.' },
        h('input', { className: 'bt-input', value: item.requiredTools, onChange: event => set('requiredTools', event.target.value) })),
      h(Field, { label: 'Forbidden tools', hint: 'Comma-separated tool names.' },
        h('input', { className: 'bt-input', value: item.forbiddenTools, onChange: event => set('forbiddenTools', event.target.value) })),
      h(Field, { label: 'Maximum duration (ms)' },
        h('input', { className: 'bt-input', type: 'number', min: 1000, max: 900000, step: 1000, value: item.maxDurationMs, onChange: event => set('maxDurationMs', event.target.value) })),
      h(Field, { label: 'Maximum tokens' },
        h('input', { className: 'bt-input', type: 'number', min: 1, value: item.maxTokens, onChange: event => set('maxTokens', event.target.value) })),
      canRemove ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-eval-remove', onClick: onRemove }, h(TrashIcon), t('Remove case')) : null))
}

function SuiteForm({ roster, actions, suite, run, onClose }) {
  const [draft, setDraft] = useState(() => suite ? draftOf(suite) : blankSuite(roster))
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const set = (key, value) => setDraft(previous => ({ ...previous, [key]: value }))
  const setCase = (index, value) => setDraft(previous => ({ ...previous, cases: previous.cases.map((item, at) => at === index ? value : item) }))
  const removeCase = index => setDraft(previous => ({ ...previous, cases: previous.cases.filter((_item, at) => at !== index) }))
  const addCase = () => setDraft(previous => ({ ...previous, cases: [...previous.cases, { ...blankCase(), name: `Case ${previous.cases.length + 1}` }] }))
  const save = (event) => {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    const split = value => String(value ?? '').split(/[\n,]/).map(item => item.trim()).filter(Boolean)
    void run(actions.evalSave({
      ...(draft.id === undefined ? {} : { id: draft.id }),
      name: draft.name,
      description: draft.description,
      targetBotId: draft.targetBotId,
      cases: draft.cases.map(item => ({
        ...(item.id === undefined ? {} : { id: item.id }),
        name: item.name,
        prompt: item.prompt,
        contains: item.contains,
        notContains: item.notContains,
        regex: item.regex,
        notRegex: item.notRegex,
        requiredTools: split(item.requiredTools),
        forbiddenTools: split(item.forbiddenTools),
        ...(item.maxDurationMs === '' ? {} : { maxDurationMs: Number(item.maxDurationMs) }),
        ...(item.maxTokens === '' ? {} : { maxTokens: Number(item.maxTokens) }),
      })),
    })).then((ok) => {
      if (ok) onClose()
      else setBusy(false)
    }, (failure) => {
      setError(hostText(failure?.message ?? String(failure)))
      setBusy(false)
    })
  }
  return h('form', { className: 'bt-set-card bt-eval-form', onSubmit: save },
    h('div', { className: 'bt-eval-form-grid' },
      h(Field, { label: 'Suite name' }, h('input', { className: 'bt-input', value: draft.name, maxLength: 80, autoFocus: true, onChange: event => set('name', event.target.value) })),
      h(Field, { label: 'Target Bot' },
        h('select', { className: 'bt-select', value: draft.targetBotId, onChange: event => set('targetBotId', event.target.value) }, roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name)))),
      h(Field, { label: 'Description', wide: true },
        h('input', {
          className: 'bt-input',
          value: draft.description,
          maxLength: 1000,
          onChange: event => set('description', event.target.value),
        }))),
    h('div', { className: 'bt-eval-cases' },
      draft.cases.map((item, index) => h(CaseEditor, {
        key: item.id ?? index,
        item,
        index,
        canRemove: draft.cases.length > 1,
        onChange: value => setCase(index, value),
        onRemove: () => removeCase(index),
      })),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', onClick: addCase }, h(PlusIcon), t('Add case'))),
    h('div', { className: 'bt-eval-safety' }, t('Runs use a fresh read-only Session. Team tools are denied and the Session is archived after each case.')),
    error ? h('div', { className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    h('div', { className: 'bt-eval-form-foot' },
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Cancel')),
      h('button', {
        type: 'submit',
        className: 'bt-send bt-soft-sm',
        disabled: busy || draft.name.trim() === '' || draft.targetBotId === '' || draft.cases.some(item => item.name.trim() === '' || item.prompt.trim() === ''),
      }, busy ? t('Saving…') : suite ? t('Save changes') : t('Save suite'))))
}

function SuiteRow({ suite, actions, run, onEdit, onRun, disabled }) {
  const [confirming, setConfirming] = useState(false)
  useEffect(() => {
    if (!confirming) return undefined
    const timer = setTimeout(() => setConfirming(false), 3000)
    return () => clearTimeout(timer)
  }, [confirming])
  const remove = () => {
    if (!confirming) {
      setConfirming(true)
      return
    }
    setConfirming(false)
    void run(actions.evalDelete(suite.id))
  }
  return h('div', { className: 'bt-eval-suite' },
    h('span', { className: 'bt-eval-suite-main' },
      h('b', null, suite.name),
      h('span', null, `${suite.targetName} · ${suite.cases.length === 1 ? t('{count} case', { count: 1 }) : t('{count} cases', { count: suite.cases.length })}${suite.description ? ` · ${suite.description}` : ''}`)),
    h('span', { className: 'bt-eval-actions' },
      h('button', { type: 'button', className: 'bt-send bt-soft-sm', disabled, onClick: onRun }, t('Run')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: onEdit }, t('Edit')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled, onClick: remove }, confirming ? t('Click again to delete.') : t('Delete'))))
}

function RunRow({ item, onOpen }) {
  return h('button', { type: 'button', className: 'bt-eval-run', 'data-status': item.status, onClick: onOpen },
    h('span', { className: 'bt-eval-run-status', 'aria-label': item.status }),
    h('span', { className: 'bt-eval-run-main' },
      h('b', null, item.suiteName),
      h('span', null, `${item.botName} · ${when(item.startedAt)} · ${statusLabel(item.status)}`)),
    h('span', { className: 'bt-eval-run-nums' },
      h('b', null, rate(item.summary?.passRate)),
      h('span', null, `${duration(item.summary?.durationMs)} · ${tokenText(item.summary?.tokens)} ${t('tokens')}`)),
    h(ChevronRightIcon))
}

function RunDetail({ item, onClose }) {
  return h('div', { className: 'bt-eval-detail' },
    h('div', { className: 'bt-eval-detail-head' },
      h('div', null,
        h('b', null, item.suiteName),
        h('span', null, `${item.botName} · ${when(item.startedAt)} · ${statusLabel(item.status)}`)),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Close'))),
    item.comparison ? h('div', { className: 'bt-eval-compare' },
      h('span', null, t('Compared with previous run')),
      h('span', { 'data-good': item.comparison.passDelta >= 0 }, `${item.comparison.passDelta >= 0 ? '+' : ''}${item.comparison.passDelta} ${t('passed')}`),
      h('span', null, `${item.comparison.durationDeltaMs >= 0 ? '+' : ''}${duration(Math.abs(item.comparison.durationDeltaMs))} ${t('time')}`),
      h('span', null, `${item.comparison.tokenDelta >= 0 ? '+' : ''}${tokenText(item.comparison.tokenDelta)} ${t('tokens')}`),
      item.comparison.regressions.length > 0 ? h('span', { 'data-bad': true }, t('{count} regressions', { count: item.comparison.regressions.length })) : null) : null,
    h('div', { className: 'bt-eval-results' },
      item.results.map(result => h('details', { key: result.caseId, className: 'bt-eval-result', 'data-status': result.status },
        h('summary', null,
          h('span', { className: 'bt-eval-result-status', 'aria-hidden': true }),
          h('span', null, result.name),
          h('span', null, `${duration(result.durationMs)} · ${tokenText(result.tokens)} ${t('tokens')}`),
          h('span', { className: 'bt-tag' }, statusLabel(result.status))),
        h('div', { className: 'bt-eval-result-body' },
          result.checks.map(check => h('div', { key: check.id, className: 'bt-eval-check', 'data-pass': check.passed },
            h('span', null, check.passed ? '✓' : '×'),
            h('b', null, t(CHECKS[check.id] ?? check.id)),
            check.detail ? h('span', null, check.detail) : null)),
          result.output ? h('pre', { className: 'bt-eval-output', tabIndex: 0 }, result.output) : null,
          result.error ? h('div', { className: 'bt-danger bt-set-hint' }, result.error) : null)))),
    item.status === 'running' ? h('div', { className: 'bt-eval-progress' }, `${item.progress?.done ?? 0} / ${item.progress?.total ?? 0}`) : null)
}

export function EvaluationPage({ roster, actions, run: outerRun }) {
  const run = outerRun ?? (promise => Promise.resolve(promise))
  const [view, setView] = useState(null)
  const [mode, setMode] = useState('suites')
  const [editing, setEditing] = useState(null)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const load = () => actions.evaluations()
    .then((next) => { setView(next); setError('') })
    .catch(failure => setError(hostText(failure?.message ?? String(failure))))
  useEffect(() => {
    let stopped = false
    let timer
    const loop = () => {
      if (stopped) return
      void actions.evaluations()
        .then((next) => {
          setView(next)
          setError('')
          if (!stopped) timer = setTimeout(loop, next?.running ? 1_500 : 8_000)
        }, (failure) => {
          setError(hostText(failure?.message ?? String(failure)))
          if (!stopped) timer = setTimeout(loop, 8_000)
        })
    }
    loop()
    return () => { stopped = true; clearTimeout(timer) }
  }, [])
  useEffect(() => {
    if (detail === null) return
    const item = view?.runs?.find(entry => entry.id === detail.id)
    if (item !== undefined && JSON.stringify(item) !== JSON.stringify(detail)) setDetail(item)
  }, [view])
  const start = suite => void run(actions.evalRun(suite.id).then(() => {
    setDetail(null)
    setMode('runs')
    return load()
  }))
  const openRun = id => void run(actions.evalRunDetail(id).then(setDetail))
  const running = view?.running !== null && view?.running !== undefined
  const tabs = h('div', { className: 'bt-actions' },
    h(Segmented, { label: t('Evaluation view'), value: mode },
      h('button', { type: 'button', 'aria-pressed': mode === 'suites', onClick: () => setMode('suites') }, t('Suites')),
      h('button', { type: 'button', 'aria-pressed': mode === 'runs', onClick: () => setMode('runs') }, t('Runs'))))
  if (view === null) return [tabs, h('div', { key: 'loading', className: 'bt-set-hint' }, t('Loading…'))]
  if (mode === 'suites') return [
    tabs,
    error ? h('div', { key: 'error', className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    editing
      ? h(SuiteForm, { key: editing.id ?? 'new', roster, actions, suite: editing.id ? editing : undefined, run, onClose: () => { setEditing(null); void load() } })
      : h('div', { key: 'new', className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: running || roster.bots.length === 0, onClick: () => setEditing({}) }, h(PlusIcon), t('New suite'))),
    h('section', { key: 'suites', className: 'bt-set-section' },
      h('h3', null, t('Evaluation suites · {count}', { count: view.suites.length })),
      h('div', { className: 'bt-set-card bt-eval-suites' },
        view.suites.length === 0
          ? h('div', { className: 'bt-eval-empty' }, t('No evaluation suites yet'))
          : view.suites.map(suite => h(SuiteRow, {
              key: suite.id,
              suite,
            actions,
              run,
              disabled: running,
              onEdit: () => setEditing(suite),
              onRun: () => start(suite),
            })))),
  ]
  return [
    tabs,
    error ? h('div', { key: 'error', className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    running ? h('div', { key: 'running', className: 'bt-eval-running' },
      h('span', null, t('Evaluation running')),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => void run(actions.evalCancel()) }, t('Stop'))) : null,
    detail ? h(RunDetail, { key: 'detail', item: detail, onClose: () => setDetail(null) }) : null,
    h('section', { key: 'runs', className: 'bt-set-section' },
      h('h3', null, t('Evaluation runs · {count}', { count: view.runs.length })),
      h('div', { className: 'bt-set-card bt-eval-runs' },
        view.runs.length === 0
          ? h('div', { className: 'bt-eval-empty' }, t('No evaluation runs yet'))
          : view.runs.map(item => h(RunRow, { key: item.id, item, onOpen: () => openRun(item.id) })))),
  ]
}

export const EVALUATION_CSS = `
.bt-eval-form{display:flex;flex-direction:column;gap:14px;padding:14px}
.bt-eval-form-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
.bt-eval-field{display:flex;flex-direction:column;gap:4px;min-width:0}
.bt-eval-field.bt-eval-wide{grid-column:1/-1}
.bt-eval-label{font-size:12px;line-height:16px;font-weight:500;color:var(--bt-ink-2)}
.bt-eval-hint{font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-eval-field .bt-input,.bt-eval-field .bt-select{width:100%;box-sizing:border-box}
.bt-eval-cases{display:flex;flex-direction:column;gap:6px}
.bt-eval-case{border-top:1px solid var(--bt-line);padding:8px 0}
.bt-eval-case:first-child{border-top:0}
.bt-eval-case summary{display:flex;align-items:center;gap:6px;min-height:32px;cursor:pointer;font-size:12px;font-weight:500;list-style:none}
.bt-eval-case summary::-webkit-details-marker{display:none}
.bt-eval-case summary>span:first-child{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-eval-case-body{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding:10px 4px 4px}
.bt-eval-case-body>.bt-eval-wide,.bt-eval-remove{grid-column:1/-1}
.bt-eval-remove{align-self:flex-start;color:var(--bt-danger)}
.bt-eval-safety{padding:8px 10px;border-radius:8px;background:var(--bt-hover);font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-eval-form-foot{display:flex;justify-content:flex-end;gap:8px}
.bt-eval-suites,.bt-eval-runs{display:flex;flex-direction:column;gap:2px;padding:4px}
.bt-eval-suite{display:flex;align-items:center;gap:12px;min-width:0;padding:9px 8px;border-radius:8px}
.bt-eval-suite:hover{background:var(--bt-hover)}
.bt-eval-suite-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-eval-suite-main b{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-eval-suite-main span{font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-eval-actions{flex:none;display:flex;gap:6px;align-items:center}
.bt-eval-actions .bt-send{height:28px}
.bt-eval-empty{padding:24px 10px;text-align:center;font-size:12px;color:var(--bt-ink-3)}
.bt-eval-running{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--bt-accent) 9%,transparent);font-size:12px}
.bt-eval-run{display:flex;align-items:center;gap:10px;width:100%;min-width:0;padding:8px;border:0;border-radius:8px;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-eval-run:hover{background:var(--bt-hover)}
.bt-eval-run-status,.bt-eval-result-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-success,#2f9e62)}
.bt-eval-run[data-status=failed] .bt-eval-run-status,.bt-eval-result[data-status=failed] .bt-eval-result-status{background:var(--bt-danger)}
.bt-eval-run[data-status=running] .bt-eval-run-status,.bt-eval-run[data-status=interrupted] .bt-eval-run-status{background:#d7951d}
.bt-eval-run-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-eval-run-main b{font-size:13px;line-height:18px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-eval-run-main span,.bt-eval-run-nums span{font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-eval-run-nums{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-variant-numeric:tabular-nums}
.bt-eval-run-nums b{font-size:13px;line-height:18px}
.bt-eval-run>svg{flex:none;color:var(--bt-ink-3)}
.bt-eval-detail{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-eval-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bt-eval-detail-head>div{display:flex;flex-direction:column;gap:2px}
.bt-eval-detail-head b{font-size:14px;line-height:20px}
.bt-eval-detail-head span{font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-eval-compare{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-eval-compare>span:first-child{font-weight:500;color:var(--bt-ink)}
.bt-eval-compare [data-good]{color:var(--bt-success,#2f9e62)}
.bt-eval-compare [data-bad]{color:var(--bt-danger)}
.bt-eval-results{display:flex;flex-direction:column;gap:3px}
.bt-eval-result{border-top:1px solid var(--bt-line);padding:4px 0}
.bt-eval-result:first-child{border-top:0}
.bt-eval-result summary{display:grid;grid-template-columns:10px minmax(100px,1fr) auto auto;align-items:center;gap:8px;min-height:34px;cursor:pointer;font-size:12px;list-style:none}
.bt-eval-result summary::-webkit-details-marker{display:none}
.bt-eval-result summary>span:nth-child(2){overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-eval-result-body{display:flex;flex-direction:column;gap:5px;padding:4px 8px 10px 26px}
.bt-eval-check{display:flex;align-items:baseline;gap:7px;font-size:11px;line-height:16px;color:var(--bt-ink-2)}
.bt-eval-check>span:first-child{width:12px;color:var(--bt-danger)}
.bt-eval-check[data-pass=true]>span:first-child{color:var(--bt-success,#2f9e62)}
.bt-eval-output{margin:4px 0 0;max-height:220px;overflow:auto;padding:10px;border-radius:8px;background:var(--bt-hover);font:11px/16px ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;word-break:break-word}
.bt-eval-progress{font-size:11px;color:var(--bt-ink-3)}
.bt-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace}
@media (max-width:700px){
  .bt-eval-form-grid,.bt-eval-case-body{grid-template-columns:minmax(0,1fr)}
  .bt-eval-field.bt-eval-wide,.bt-eval-case-body>.bt-eval-wide,.bt-eval-remove{grid-column:auto}
  .bt-eval-suite{align-items:flex-start;flex-wrap:wrap}
  .bt-eval-actions{width:100%;justify-content:flex-end;flex-wrap:wrap}
  .bt-eval-actions .bt-soft,.bt-eval-actions .bt-send{min-height:44px}
  .bt-eval-run-nums{display:none}
}
`
