import { createElement as h, useEffect, useState } from 'react'
import { ChevronRightIcon, DownloadIcon, GaugeIcon } from './icons.js'
import { Segmented } from './motion.js'
import { dateLocale, hostText, t } from './i18n.js'

const RANGES = [
  [24, '24 hours'],
  [168, '7 days'],
  [720, '30 days'],
]

const number = value => new Intl.NumberFormat(dateLocale(), { maximumFractionDigits: 1 }).format(value ?? 0)
const rate = value => `${number(value ?? 0)}%`
const duration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '0 ms'
  if (ms < 1_000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)} s`
  return `${(ms / 60_000).toFixed(ms < 600_000 ? 1 : 0)} min`
}
const when = ms => new Intl.DateTimeFormat(dateLocale(), {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
}).format(ms)
const tokenText = n => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : String(n ?? 0)
const traceName = trace => trace.botName ?? (trace.kind === 'turn' ? t('Another Session') : t('Auxiliary model call'))
const STATUS_LABELS = {
  running: 'Running',
  completed: 'Completed',
  failed: 'Failed',
  aborted: 'Aborted',
  blocked: 'Blocked',
  interrupted: 'Interrupted',
  ok: 'OK',
  error: 'Error',
}
const statusLabel = value => t(STATUS_LABELS[value] ?? value)

function download(name, value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

function Metric({ label, value, detail, tone }) {
  return h('div', { className: 'bt-obs-metric', 'data-tone': tone },
    h('span', { className: 'bt-obs-metric-label' }, t(label)),
    h('b', null, value),
    detail ? h('span', { className: 'bt-obs-metric-detail' }, detail) : null)
}

function Trend({ points, hours }) {
  const max = Math.max(1, ...points.map(point => point.turns))
  if (points.length === 0) return h('div', { className: 'bt-obs-empty' }, t('No turns in this range'))
  return h('div', { className: 'bt-obs-trend', role: 'img', 'aria-label': t('Turn volume and failures over time') },
    points.map((point, index) => {
      const height = Math.max(point.turns === 0 ? 2 : 8, Math.round((point.turns / max) * 100))
      const failed = point.turns === 0 ? 0 : Math.round((point.failed / point.turns) * height)
      return h('span', {
        key: index,
        className: 'bt-obs-bar',
        title: t('{turns} turns · {failed} failed · {time}', { turns: point.turns, failed: point.failed, time: when(point.at) }),
        style: { '--h': `${height}%`, '--f': `${failed}%` },
        'aria-label': t('{turns} turns · {failed} failed · {time}', { turns: point.turns, failed: point.failed, time: when(point.at) }),
      }, h('i', null))
    }),
    h('div', { className: 'bt-obs-trend-foot' },
      h('span', null, when(points[0].at)),
      h('span', null, hours >= 168 ? t('Last {count} days', { count: Math.round(hours / 24) }) : t('Last {count} hours', { count: hours })),
      h('span', null, when(points.at(-1).at + (hours * 3_600_000 / points.length)))))
}

function spanLabel(span) {
  const attrs = span.attributes ?? {}
  if (span.kind === 'model') {
    return [attrs['gen_ai.provider.name'], attrs['gen_ai.request.model'], attrs['ds_bot.model.purpose']].filter(Boolean).join(' · ')
  }
  if (span.kind === 'tool') return attrs['gen_ai.tool.name'] ?? span.name
  if (span.kind === 'approval') return [attrs['ds_bot.tool.name'], attrs['ds_bot.approval.outcome']].filter(Boolean).join(' · ')
  if (span.kind === 'event') return [attrs['ds_bot.source.kind'], attrs['ds_bot.source.role'], attrs['ds_bot.integration.event']].filter(Boolean).join(' · ')
  return span.name
}

function TraceDetail({ detail, onClose }) {
  if (detail === null) return null
  const head = h('div', { className: 'bt-obs-detail-head' },
    h('div', null,
      h('b', null, traceName(detail.trace)),
      h('span', { title: detail.trace.sessionId }, `${t('Turn {turn}', { turn: detail.trace.turn })} · ${when(detail.trace.startedAt)} · ${duration(detail.trace.durationMs)} · ${detail.trace.sessionId.slice(0, 8)}`)),
    h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: onClose }, t('Close')))
  const rows = detail.spans.map(span => h('div', {
    key: span.id,
    className: 'bt-obs-span',
    'data-status': span.status,
    'data-kind': span.kind,
  },
  h('span', { className: 'bt-obs-span-mark', 'aria-hidden': true }),
  h('span', { className: 'bt-obs-span-name' }, span.name),
  h('span', { className: 'bt-obs-span-detail' }, spanLabel(span)),
  h('span', { className: 'bt-obs-span-time' }, duration(span.durationMs)),
  h('span', { className: 'bt-tag' }, statusLabel(span.status))))
  return h('div', { className: 'bt-obs-detail', 'aria-live': 'polite' },
    head,
    h('div', { className: 'bt-obs-spans' }, rows))
}

function Thresholds({ value, onSave, run }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => setDraft(value), [value])
  const set = (key, raw) => setDraft(previous => ({ ...previous, [key]: raw }))
  return h('details', { className: 'bt-obs-thresholds' },
    h('summary', null, t('Health thresholds')),
    h('div', { className: 'bt-obs-threshold-grid' },
      h('label', null, h('span', null, t('Turn success minimum (%)')), h('input', { type: 'number', min: 0, max: 100, value: draft.turnSuccessMin, onChange: event => set('turnSuccessMin', event.target.value) })),
      h('label', null, h('span', null, t('Tool failure maximum (%)')), h('input', { type: 'number', min: 0, max: 100, value: draft.toolFailureMax, onChange: event => set('toolFailureMax', event.target.value) })),
      h('label', null, h('span', null, t('Turn p95 maximum (ms)')), h('input', { type: 'number', min: 1000, max: 3600000, step: 1000, value: draft.p95MsMax, onChange: event => set('p95MsMax', event.target.value) })),
      h('label', null, h('span', null, t('Model error maximum (%)')), h('input', { type: 'number', min: 0, max: 100, value: draft.modelErrorMax, onChange: event => set('modelErrorMax', event.target.value) }))),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      onClick: () => void run(onSave({
        turnSuccessMin: Number(draft.turnSuccessMin),
        toolFailureMax: Number(draft.toolFailureMax),
        p95MsMax: Number(draft.p95MsMax),
        modelErrorMax: Number(draft.modelErrorMax),
      })),
    }, t('Save thresholds')))
}

export function ObservabilityPage({ roster, actions, run = promise => Promise.resolve(promise) }) {
  const [hours, setHours] = useState(24)
  const [botId, setBotId] = useState('')
  const [view, setView] = useState(null)
  const [detail, setDetail] = useState(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const load = (quiet = false) => {
    if (!quiet) setLoading(true)
    return actions.observability({ hours, botId: botId || undefined })
      .then((next) => { setView(next); setError('') })
      .catch(failure => setError(hostText(failure?.message ?? String(failure))))
      .finally(() => setLoading(false))
  }
  useEffect(() => {
    let stopped = false
    void load()
    const timer = setInterval(() => {
      if (!stopped) void load(true)
    }, 15_000)
    return () => { stopped = true; clearInterval(timer) }
  }, [hours, botId])
  useEffect(() => setDetail(null), [hours, botId])
  const openTrace = id => void run(actions.observabilityTrace(id).then(setDetail))
  const exportData = () => void run(actions.observabilityExport().then(value => download('ds-bot-observability.json', value)))
  const alertText = (() => {
    if (!view?.alerts?.length) return ''
    return view.alerts.map((alert) => {
      if (alert.id === 'success-rate') return t('Turn success is {value}%, below {threshold}%', { value: rate(alert.value), threshold: alert.threshold })
      if (alert.id === 'tool-failures') return t('Tool failures are {value}%, above {threshold}%', { value: rate(alert.value), threshold: alert.threshold })
      if (alert.id === 'turn-p95') return t('Turn p95 is {value}, above {threshold}', { value: duration(alert.value), threshold: duration(alert.threshold) })
      return t('Model errors are {value}%, above {threshold}%', { value: rate(alert.value), threshold: alert.threshold })
    }).join(' · ')
  })()
  const controls = h('div', { className: 'bt-obs-controls' },
    h(Segmented, { label: t('Time range'), value: hours },
      RANGES.map(([value, label]) => h('button', {
        key: value,
        type: 'button',
        'aria-pressed': hours === value,
        onClick: () => setHours(value),
      }, t(label)))),
    h('select', {
      className: 'bt-select',
      'aria-label': t('Bot'),
      value: botId,
      onChange: event => setBotId(event.target.value),
    },
    h('option', { value: '' }, t('All Bots')),
    roster.bots.map(bot => h('option', { key: bot.id, value: bot.id }, bot.name))),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm',
      disabled: loading,
      onClick: () => void load(),
    }, loading ? t('Loading…') : t('Refresh')),
    h('button', {
      type: 'button',
      className: 'bt-soft bt-soft-sm bt-with-icon',
      onClick: exportData,
    }, h(DownloadIcon), t('Export JSON')))
  if (!view) return [controls, h('div', { key: 'loading', className: 'bt-set-hint' }, t('Reading traces…'))]
  const summary = view.summary
  const traceRows = view.recent.length === 0
    ? h('div', { className: 'bt-obs-empty' }, t('No turns in this range'))
    : view.recent.map(trace => h('button', {
        key: trace.id,
        type: 'button',
        className: 'bt-obs-trace',
        'data-status': trace.status,
        onClick: () => openTrace(trace.id),
      },
      h('span', { className: 'bt-obs-status', 'aria-label': trace.status }),
      h('span', { className: 'bt-obs-trace-main' },
        h('b', null, traceName(trace)),
        h('span', null, [t('Turn {turn}', { turn: trace.turn }), trace.sourceKind, trace.errorCode].filter(Boolean).join(' · '))),
      h('span', { className: 'bt-obs-trace-nums' },
        h('span', null, duration(trace.durationMs)),
        h('span', null, t('{count} tools · {tokens} tokens', { count: trace.toolCalls, tokens: tokenText(trace.tokens) }))),
      h(ChevronRightIcon)))
  const botRows = view.byBot.length === 0
    ? h('div', { className: 'bt-obs-empty' }, t('No turns in this range'))
    : view.byBot.map(item => h('div', { key: item.botId ?? 'other', className: 'bt-obs-bot' },
        h('span', null, item.name),
        h('span', null, t('{turns} turns · {failed} failed', { turns: item.turns, failed: item.failed })),
        h('span', null, duration(item.p95Ms)),
        h('span', null, `${tokenText(item.tokens)} ${t('tokens')}`)))
  const failureRows = view.recentFailures.length === 0 ? null : h('section', { className: 'bt-set-section' },
    h('h3', null, t('Recent failures')),
    h('div', { className: 'bt-set-card bt-obs-failures' },
      view.recentFailures.slice(0, 8).map(trace => h('button', {
        key: trace.id,
        type: 'button',
        className: 'bt-obs-failure',
        onClick: () => openTrace(trace.id),
      },
      h('span', null, traceName(trace)),
      h('span', null, trace.errorCode ?? trace.status),
      h('span', null, when(trace.startedAt))))))
  return [
    controls,
    error ? h('div', { key: 'error', className: 'bt-danger bt-set-hint', role: 'alert' }, error) : null,
    alertText ? h('div', { key: 'alert', className: 'bt-obs-alert', role: 'status' }, h(GaugeIcon), h('span', null, alertText)) : null,
    h('div', { key: 'metrics', className: 'bt-obs-metrics' },
      h(Metric, { label: 'Turns', value: number(summary.turns), detail: t('{count} finished', { count: summary.finished }) }),
      h(Metric, { label: 'Success rate', value: rate(summary.successRate), detail: t('{failed} failures · {stopped} stopped', { failed: summary.failures, stopped: summary.aborted }), tone: summary.successRate < view.thresholds.turnSuccessMin ? 'warn' : 'ok' }),
      h(Metric, { label: 'Turn p95', value: duration(summary.p95Ms), detail: t('Median {value}', { value: duration(summary.p50Ms) }), tone: summary.p95Ms > view.thresholds.p95MsMax ? 'warn' : 'ok' }),
      h(Metric, { label: 'Tokens', value: tokenText(summary.tokens), detail: t('{count} model calls', { count: summary.modelCalls }) })),
    h('section', { key: 'trend', className: 'bt-set-section' },
      h('h3', null, t('Turn volume')),
      h('div', { className: 'bt-set-card bt-obs-chart' },
        h(Trend, { points: view.trend, hours }),
        h('div', { className: 'bt-obs-key' },
          h('span', null, h('i', { className: 'bt-obs-key-turn' }), t('Turns')),
          h('span', null, h('i', { className: 'bt-obs-key-fail' }), t('Failed or stopped'))))),
    h('section', { key: 'traces', className: 'bt-set-section' },
      h('h3', null, t('Recent traces')),
      h('div', { className: 'bt-set-card bt-obs-traces' }, traceRows)),
    detail ? h(TraceDetail, { key: 'detail', detail, onClose: () => setDetail(null) }) : null,
    h('section', { key: 'bots', className: 'bt-set-section' },
      h('h3', null, t('By Bot')),
      h('div', { className: 'bt-set-card bt-obs-bots' }, botRows)),
    failureRows,
    h('section', { key: 'thresholds', className: 'bt-set-section' },
      h('h3', null, t('Alert thresholds')),
      h('div', { className: 'bt-set-card' },
        h(Thresholds, {
          value: view.thresholds,
          run,
          onSave: value => actions.observabilityConfig(value).then(() => load()),
        }))),
  ]
}

export const OBSERVABILITY_CSS = `
.bt-obs-controls{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.bt-obs-controls>.bt-select{width:160px}
.bt-obs-metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px}
.bt-obs-metric{display:flex;flex-direction:column;gap:4px;min-width:0;padding:12px 14px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-obs-metric-label{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-obs-metric b{font-size:24px;line-height:30px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}
.bt-obs-metric-detail{font-size:11px;line-height:15px;color:var(--bt-ink-3);overflow-wrap:anywhere}
.bt-obs-metric[data-tone=warn] b{color:var(--bt-danger)}
.bt-obs-alert{display:flex;align-items:flex-start;gap:8px;padding:9px 12px;border-radius:10px;background:color-mix(in srgb,var(--bt-danger) 9%,transparent);color:var(--bt-danger);font-size:12px;line-height:18px}
.bt-obs-alert svg{flex:none;margin-top:1px}
.bt-obs-chart{gap:14px;min-height:150px}
.bt-obs-trend{display:flex;align-items:flex-end;gap:2px;height:104px;padding-top:8px}
.bt-obs-bar{flex:1;min-width:2px;height:100%;display:flex;align-items:flex-end}
.bt-obs-bar>i{display:block;width:100%;height:var(--h);border-radius:3px 3px 1px 1px;background:color-mix(in srgb,var(--bt-accent) 72%,var(--bt-card));position:relative;overflow:hidden;transition:height .3s ease}
.bt-obs-bar>i::after{content:'';position:absolute;left:0;right:0;bottom:0;height:var(--f);background:var(--bt-danger)}
.bt-obs-trend-foot{display:flex;justify-content:space-between;gap:12px;font-size:10px;line-height:14px;color:var(--bt-ink-3)}
.bt-obs-key{display:flex;gap:14px;font-size:11px;color:var(--bt-ink-3)}
.bt-obs-key>span{display:inline-flex;align-items:center;gap:5px}
.bt-obs-key i{width:7px;height:7px;border-radius:2px}
.bt-obs-key-turn{background:var(--bt-accent)}
.bt-obs-key-fail{background:var(--bt-danger)}
.bt-obs-traces{padding:4px}
.bt-obs-trace,.bt-obs-failure{display:flex;align-items:center;gap:10px;width:100%;min-width:0;border:0;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer;border-radius:8px;transition:background-color .12s ease}
.bt-obs-trace{padding:8px}
.bt-obs-trace:hover,.bt-obs-failure:hover{background:var(--bt-hover)}
.bt-obs-status{flex:none;width:7px;height:7px;border-radius:50%;background:var(--bt-success,#2f9e62)}
.bt-obs-trace[data-status=error] .bt-obs-status,.bt-obs-trace[data-status=failed] .bt-obs-status{background:var(--bt-danger)}
.bt-obs-trace[data-status=aborted] .bt-obs-status,.bt-obs-trace[data-status=blocked] .bt-obs-status,.bt-obs-trace[data-status=interrupted] .bt-obs-status{background:#d7951d}
.bt-obs-trace-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:1px}
.bt-obs-trace-main b{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px;line-height:18px;font-weight:500}
.bt-obs-trace-main span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px;line-height:15px;color:var(--bt-ink-3)}
.bt-obs-trace-nums{flex:none;display:flex;flex-direction:column;align-items:flex-end;gap:1px;font-size:11px;line-height:15px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-obs-trace>svg{flex:none;color:var(--bt-ink-3)}
.bt-obs-detail{display:flex;flex-direction:column;gap:12px;padding:14px;border:1px solid var(--bt-line);border-radius:12px;background:var(--bt-card)}
.bt-obs-detail-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.bt-obs-detail-head>div{display:flex;flex-direction:column;gap:3px;min-width:0}
.bt-obs-detail-head b{font-size:14px;line-height:20px}
.bt-obs-detail-head span{font-size:12px;line-height:16px;color:var(--bt-ink-3)}
.bt-obs-spans{display:flex;flex-direction:column;gap:2px}
.bt-obs-span{display:grid;grid-template-columns:12px minmax(120px,.8fr) minmax(120px,1.4fr) auto auto;align-items:center;gap:8px;min-height:30px;padding:3px 5px;border-radius:6px;font-size:11px;line-height:15px}
.bt-obs-span:hover{background:var(--bt-hover)}
.bt-obs-span-mark{width:6px;height:6px;border-radius:50%;background:var(--bt-success,#2f9e62);margin-left:3px}
.bt-obs-span[data-status=error] .bt-obs-span-mark{background:var(--bt-danger)}
.bt-obs-span[data-status=interrupted] .bt-obs-span-mark{background:#d7951d}
.bt-obs-span-name{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;color:var(--bt-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-obs-span-detail{color:var(--bt-ink-3);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-obs-span-time{color:var(--bt-ink-3);font-variant-numeric:tabular-nums;text-align:right}
.bt-obs-bots,.bt-obs-failures{display:flex;flex-direction:column;gap:2px;padding:4px}
.bt-obs-bot,.bt-obs-failure{display:grid;align-items:center;gap:10px;min-width:0;padding:7px 8px;border-radius:7px;font-size:12px;line-height:16px}
.bt-obs-bot{grid-template-columns:minmax(100px,1fr) minmax(120px,1.2fr) auto auto}
.bt-obs-bot>span:first-child{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bt-obs-bot>span:not(:first-child),.bt-obs-failure>span:not(:first-child){color:var(--bt-ink-3);font-variant-numeric:tabular-nums}
.bt-obs-failure{grid-template-columns:minmax(100px,1fr) auto auto;border:0;background:none;color:var(--bt-ink);font:inherit;text-align:left;cursor:pointer}
.bt-obs-empty{padding:20px 8px;text-align:center;font-size:12px;color:var(--bt-ink-3)}
.bt-obs-thresholds{display:flex;flex-direction:column;gap:12px;padding:2px 4px}
.bt-obs-thresholds summary{cursor:pointer;font-size:13px;font-weight:500}
.bt-obs-threshold-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;padding-top:10px}
.bt-obs-threshold-grid label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--bt-ink-2)}
.bt-obs-threshold-grid input{height:32px;box-sizing:border-box;border:1px solid var(--bt-line);border-radius:7px;background:var(--bt-card);color:var(--bt-ink);padding:0 8px;font:inherit;font-size:12px}
@media (max-width:900px){.bt-obs-metrics{grid-template-columns:repeat(2,minmax(0,1fr))}}
@media (max-width:620px){
  .bt-obs-controls{align-items:stretch}
  .bt-obs-controls>*{min-height:44px}
  .bt-obs-controls>.bt-select{width:100%}
  .bt-obs-trace-nums{display:none}
  .bt-obs-span{grid-template-columns:12px minmax(90px,1fr) auto}
  .bt-obs-span-detail{grid-column:2;grid-row:2}
  .bt-obs-span-time{grid-column:3;grid-row:1}
  .bt-obs-span>.bt-tag{display:none}
  .bt-obs-bot{grid-template-columns:minmax(0,1fr) auto}
  .bt-obs-threshold-grid{grid-template-columns:minmax(0,1fr)}
}
`
