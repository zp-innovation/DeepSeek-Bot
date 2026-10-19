// Observability: local, privacy-preserving traces for turns, model calls, tools,
// approvals, handoffs, automation and integration deliveries. Prompts, tool arguments,
// message bodies and secrets are never written. The JSONL carrier is intentionally
// simple to export into an external collector later.
import { randomUUID } from 'node:crypto'
import { appendFile, mkdir, readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { cleanText } from './diagnostics.js'
import { textOf } from './text.js'
import { output } from './tools.js'

const MAX_TRACES = 5_000
const MAX_AGE_MS = 30 * 24 * 60 * 60_000
const MAX_FILE_BYTES = 8 * 1024 * 1024
const DEFAULT_THRESHOLDS = {
  turnSuccessMin: 90,
  toolFailureMax: 20,
  p95MsMax: 120_000,
  modelErrorMax: 10,
}

const clampInt = (value, min, max, fallback) => {
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= min && number <= max ? number : fallback
}
const duration = (start, end) => Math.max(0, (Number.isFinite(end) ? end : Date.now()) - start)
const percentile = (values, fraction) => {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * fraction) - 1))]
}
const count = value => Number.isSafeInteger(value) && value > 0 ? value : 0
const tokensOf = usage => ({
  input: count(usage?.inputTokens),
  cacheRead: count(usage?.cacheReadTokens),
  cacheWrite: count(usage?.cacheWriteTokens),
  output: count(usage?.outputTokens),
})
const statusOfReason = reason => reason?.kind === 'error' ? 'error'
  : reason?.kind === 'aborted' ? 'aborted'
    : reason?.kind === 'blocked' ? 'blocked' : 'completed'

export function install(rt) {
  const { ctx, home, state } = rt
  const path = join(home, 'observability.jsonl')
  const traces = new Map()
  const spans = new Map()
  const byTrace = new Map()
  const activeTurns = new Map()
  const activeApprovals = new Map()
  const pendingRecords = []
  let loaded = false
  let stopped = false
  let bytes = 0
  let writing = Promise.resolve()
  let readyResolve
  const ready = new Promise(resolve => { readyResolve = resolve })

  const safe = value => cleanText(rt.redactSecrets?.(String(value ?? '')) ?? String(value ?? ''), {
    redact: rt.redactSecrets,
    home,
  }).slice(0, 1_000)
  const safeAttrs = (attrs) => {
    const out = {}
    for (const [key, value] of Object.entries(attrs ?? {})) {
      if (value === undefined || value === null || value === '') continue
      if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
      else if (Array.isArray(value)) out[key] = value.slice(0, 30).map(item => safe(item))
      else out[key] = typeof value === 'string' ? safe(value) : safe(JSON.stringify(value))
    }
    return out
  }

  const applyRecord = (record) => {
    if (record?.kind === 'trace' && typeof record.trace?.id === 'string') {
      traces.set(record.trace.id, record.trace)
    } else if (record?.kind === 'span' && typeof record.span?.id === 'string' && typeof record.span?.traceId === 'string') {
      spans.set(record.span.id, record.span)
      const list = byTrace.get(record.span.traceId) ?? []
      const at = list.findIndex(item => item.id === record.span.id)
      if (at === -1) list.push(record.span)
      else list[at] = record.span
      byTrace.set(record.span.traceId, list)
    }
  }

  const writeRecord = record => {
    if (stopped) return
    writing = writing.then(async () => {
      if (stopped) return
      await mkdir(home, { recursive: true })
      if (bytes > MAX_FILE_BYTES) {
        await rename(path, `${path}.1`).catch(error => {
          if (error?.code !== 'ENOENT') throw error
        })
        bytes = 0
      }
      const line = `${JSON.stringify(record)}\n`
      await appendFile(path, line, 'utf8')
      bytes += Buffer.byteLength(line)
    }).catch(error => rt.warn('ds-bot: observability log not written: %s', error))
  }

  const record = (value) => {
    if (!loaded) {
      pendingRecords.push(value)
      return
    }
    applyRecord(value)
    writeRecord(value)
  }

  const commitTrace = trace => {
    trace.updatedAt = Date.now()
    record({ kind: 'trace', trace: { ...trace, attrs: safeAttrs(trace.attrs) } })
  }
  const commitSpan = span => {
    span.attributes = safeAttrs(span.attributes)
    record({ kind: 'span', span: { ...span } })
  }
  const addSpan = ({ traceId, parentSpanId, kind, name, startedAt, endedAt, status, attributes }) => {
    const span = {
      id: randomUUID(),
      traceId,
      ...(parentSpanId ? { parentSpanId } : {}),
      kind,
      name,
      startedAt,
      endedAt: endedAt ?? startedAt,
      durationMs: duration(startedAt, endedAt ?? startedAt),
      status: status ?? 'ok',
      attributes: attributes ?? {},
    }
    commitSpan(span)
    return span
  }
  const finishSpan = (span, status, attributes = {}) => {
    span.endedAt = Date.now()
    span.durationMs = duration(span.startedAt, span.endedAt)
    span.status = status
    span.attributes = { ...span.attributes, ...attributes }
    commitSpan(span)
  }
  const traceSummary = trace => ({
    id: trace.id,
    kind: trace.kind,
    name: trace.name,
    sessionId: trace.sessionId,
    turn: trace.turn,
    botId: trace.botId ?? trace.attrs?.['ds_bot.eval.bot_id'],
    botName: trace.botName ?? trace.attrs?.['ds_bot.eval.bot_name'],
    roomId: trace.roomId,
    roomName: trace.roomName,
    sourceKind: trace.sourceKind,
    sourceRole: trace.sourceRole,
    startedAt: trace.startedAt,
    endedAt: trace.endedAt,
    durationMs: trace.durationMs,
    status: trace.status,
    errorCode: trace.errorCode,
    errorMessage: trace.errorMessage,
    assistantMessages: trace.assistantMessages ?? 0,
    toolCalls: trace.toolCalls ?? 0,
    toolFailures: trace.toolFailures ?? 0,
    modelCalls: trace.modelCalls ?? 0,
    tokens: trace.tokens ?? 0,
  })
  const trim = () => {
    if (traces.size <= MAX_TRACES) return
    const finished = [...traces.values()]
      .filter(trace => trace.endedAt !== undefined)
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const trace of finished.slice(0, traces.size - MAX_TRACES)) {
      traces.delete(trace.id)
      for (const span of byTrace.get(trace.id) ?? []) spans.delete(span.id)
      byTrace.delete(trace.id)
    }
  }

  const botForSession = sessionId => {
    const botId = rt.selfOf?.(sessionId)
    const agent = rt.agentOf?.(sessionId)
    return rt.botOf?.(botId) ?? rt.evalBotOf?.(sessionId) ?? (agent ? { id: `agent:${agent.id}`, name: agent.name } : undefined)
  }
  const roomForSession = sessionId => {
    const owner = rt.groupOwners?.get(sessionId)
    return rt.roomOf?.(owner?.roomId ?? (rt.roomOf?.(sessionId) ? sessionId : undefined))
  }

  const beginTurn = (sessionId, turn, startedAt) => {
    const previous = activeTurns.get(sessionId)
    if (previous !== undefined) endTurn(sessionId, { kind: 'aborted' }, startedAt)
    const bot = botForSession(sessionId)
    const room = roomForSession(sessionId)
    const trace = {
      id: randomUUID(),
      kind: 'turn',
      name: 'agent.turn',
      sessionId,
      turn,
      ...(bot ? { botId: bot.id, botName: bot.name } : {}),
      ...(room ? { roomId: room.id, roomName: room.name } : {}),
      startedAt,
      status: 'running',
      assistantMessages: 0,
      toolCalls: 0,
      toolFailures: 0,
      modelCalls: 0,
      tokens: 0,
      attrs: {},
    }
    const rootSpan = addSpan({
      traceId: trace.id,
      kind: 'agent',
      name: 'agent.turn',
      startedAt,
      status: 'running',
      attributes: {
        'gen_ai.operation.name': 'invoke_agent',
        ...(bot ? { 'ds_bot.bot.id': bot.id, 'ds_bot.bot.name': bot.name } : {}),
        'ds_bot.session.id': sessionId,
        'ds_bot.turn': turn,
      },
    })
    activeTurns.set(sessionId, { trace, rootSpan, toolSpans: new Map(), modelSpans: new Set() })
    commitTrace(trace)
  }

  const ensureTurn = (sessionId, turn, at = Date.now()) => {
    let active = activeTurns.get(sessionId)
    if (active === undefined) {
      beginTurn(sessionId, Number.isSafeInteger(turn) ? turn : -1, at)
      active = activeTurns.get(sessionId)
    }
    return active
  }

  function endTurn(sessionId, reason, endedAt = Date.now()) {
    const active = activeTurns.get(sessionId)
    if (active === undefined) return
    activeTurns.delete(sessionId)
    const { trace, rootSpan, toolSpans } = active
    for (const span of toolSpans.values()) finishSpan(span, 'aborted', { 'ds_bot.aborted': true })
    const failure = reason?.kind === 'error' ? reason.error : undefined
    const code = typeof failure?.code === 'string' ? safe(failure.code).slice(0, 80) : undefined
    const message = code === 'AUTH' ? undefined : failure?.message ? safe(failure.message).slice(0, 500) : undefined
    trace.endedAt = endedAt
    trace.durationMs = duration(trace.startedAt, endedAt)
    trace.status = statusOfReason(reason)
    if (code) trace.errorCode = code
    if (message) trace.errorMessage = message
    rootSpan.endedAt = endedAt
    rootSpan.durationMs = trace.durationMs
    rootSpan.status = trace.status
    commitSpan(rootSpan)
    commitTrace(trace)
    trim()
  }

  const auxTrace = ({ name, sessionId, startedAt, status = 'ok', attributes = {} }) => {
    const trace = {
      id: randomUUID(),
      kind: 'event',
      name,
      ...(sessionId ? { sessionId } : {}),
      startedAt,
      endedAt: startedAt,
      durationMs: 0,
      status,
      assistantMessages: 0,
      toolCalls: 0,
      toolFailures: 0,
      modelCalls: 0,
      tokens: 0,
      attrs: attributes,
    }
    commitTrace(trace)
    return trace
  }

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    const at = Number.isFinite(event.time) ? event.time : Date.now()
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      beginTurn(sessionId, Number.isSafeInteger(data.turn) ? data.turn : -1, at)
      return
    }
    if (event.type === 'user/message') {
      const source = data.source ?? {}
      const active = ensureTurn(sessionId, Number.isSafeInteger(data.turn) ? data.turn : -1, at)
      active.trace.sourceKind = typeof source.kind === 'string' ? source.kind : 'unknown'
      active.trace.sourceRole = typeof source.role === 'string' ? source.role : undefined
      active.trace.attrs = {
        ...active.trace.attrs,
        'ds_bot.source.kind': active.trace.sourceKind,
        ...(active.trace.sourceRole ? { 'ds_bot.source.role': active.trace.sourceRole } : {}),
        'ds_bot.message.characters': textOf(data.content).length,
        ...(source.summary ? { 'ds_bot.source.summary': source.summary } : {}),
        ...(source.provider ? { 'ds_bot.integration.provider': source.provider } : {}),
        ...(source.event ? { 'ds_bot.integration.event': source.event } : {}),
        ...(source.ruleName ? { 'ds_bot.automation.rule': source.ruleName } : {}),
      }
      if (source.kind === 'bot' || source.kind === 'integration' || source.kind === 'automation') {
        addSpan({
          traceId: active.trace.id,
          parentSpanId: active.rootSpan.id,
          kind: 'event',
          name: source.kind === 'bot' ? 'handoff.message' : `${source.kind}.delivery`,
          startedAt: at,
          attributes: {
            'ds_bot.source.kind': source.kind,
            ...(source.role ? { 'ds_bot.source.role': source.role } : {}),
            ...(source.exchangeId ? { 'ds_bot.exchange.id': source.exchangeId } : {}),
            ...(source.provider ? { 'ds_bot.integration.provider': source.provider } : {}),
            ...(source.ruleId ? { 'ds_bot.automation.rule_id': source.ruleId } : {}),
          },
        })
      }
      commitTrace(active.trace)
      return
    }
    if (event.type === 'assistant/message') {
      const active = ensureTurn(sessionId, Number.isSafeInteger(data.turn) ? data.turn : -1, at)
      const content = data.message?.content
      const text = textOf(content)
      const calls = Array.isArray(content) ? content.filter(block => block?.type === 'tool-call').length : 0
      active.trace.assistantMessages += 1
      const usage = tokensOf(data.usage)
      const tokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output
      addSpan({
        traceId: active.trace.id,
        parentSpanId: active.rootSpan.id,
        kind: 'assistant',
        name: 'assistant.message',
        startedAt: at,
        attributes: {
          'ds_bot.text.characters': text.length,
          'ds_bot.tool_calls.in_message': calls,
          ...(tokens > 0 ? { 'gen_ai.usage.total_tokens': tokens } : {}),
        },
      })
      commitTrace(active.trace)
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const active = ensureTurn(sessionId, Number.isSafeInteger(data.turn) ? data.turn : -1, at)
      const callId = String(data.callId ?? data.subCallId ?? randomUUID())
      const name = String(data.name ?? 'tool')
      const span = addSpan({
        traceId: active.trace.id,
        parentSpanId: active.rootSpan.id,
        kind: 'tool',
        name: `tool.${name}`,
        startedAt: at,
        status: 'running',
        attributes: {
          'gen_ai.operation.name': 'execute_tool',
          'gen_ai.tool.name': name,
          'ds_bot.tool.arguments.bytes': Buffer.byteLength(String(data.arguments ?? '')),
        },
      })
      active.trace.toolCalls += 1
      active.toolSpans.set(callId, span)
      commitTrace(active.trace)
      return
    }
    if (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') {
      const active = activeTurns.get(sessionId)
      if (active === undefined) return
      const callId = String(data.callId ?? data.subCallId ?? '')
      const span = active.toolSpans.get(callId)
      if (span === undefined) return
      active.toolSpans.delete(callId)
      const failed = data.isError === true || data.error !== undefined || data.status === 'error'
      if (failed) active.trace.toolFailures += 1
      finishSpan(span, failed ? 'error' : 'ok', {
        ...(data.error?.code ? { 'error.code': data.error.code } : {}),
        ...(typeof data.error?.message === 'string' && data.error.code !== 'AUTH' ? { 'error.message': data.error.message } : {}),
      })
      commitTrace(active.trace)
      return
    }
    if (event.type === 'turn/end') endTurn(sessionId, data.reason, at)
  })

  // Model spans include auxiliary calls that have no turn: checkpoints, handoffs,
  // titles, memory reviews and the context steward.
  ctx.on('llm/stream', (options, next) => {
    const startedAt = Date.now()
    const sessionId = options.sessionId
    const active = typeof sessionId === 'string' ? activeTurns.get(sessionId) : undefined
    const detached = active === undefined && typeof sessionId === 'string'
      ? auxTrace({ name: 'model.auxiliary', sessionId, startedAt, status: 'running', attributes: { 'gen_ai.operation.name': 'chat' } })
      : undefined
    let firstTokenMs
    let usage
    let status = 'ok'
    let failure
    let errorCode
    return (async function* observed() {
      try {
        for await (const chunk of next()) {
          if (firstTokenMs === undefined && (chunk?.type === 'text-delta' || chunk?.type === 'block-start')) firstTokenMs = duration(startedAt, Date.now())
          if (chunk?.type === 'usage') usage = chunk.usage
          if (chunk?.type === 'finish' && chunk.reason?.kind === 'error') {
            status = 'error'
            failure = chunk.reason.error
            errorCode = failure?.code
          }
          yield chunk
        }
      } catch (error) {
        status = 'error'
        failure = error
        errorCode = error?.code ?? error?.name
        throw error
      } finally {
        const endedAt = Date.now()
        const current = typeof sessionId === 'string' ? activeTurns.get(sessionId) : undefined
        const traceId = current?.trace.id ?? active?.trace.id ?? detached?.id
        const parentSpanId = current?.rootSpan.id ?? active?.rootSpan.id
        if (traceId !== undefined) {
          const counts = tokensOf(usage)
          const total = counts.input + counts.cacheRead + counts.cacheWrite + counts.output
          addSpan({
            traceId,
            ...(parentSpanId ? { parentSpanId } : {}),
            kind: 'model',
            name: 'model.request',
            startedAt,
            endedAt,
            status,
            attributes: {
              'gen_ai.operation.name': 'chat',
              ...(options.provider ? { 'gen_ai.provider.name': options.provider } : {}),
              ...(options.model ? { 'gen_ai.request.model': options.model } : {}),
              ...(options.purpose ? { 'ds_bot.model.purpose': options.purpose } : {}),
              ...(firstTokenMs === undefined ? {} : { 'ds_bot.model.first_token_ms': firstTokenMs }),
              ...(total > 0 ? {
                'gen_ai.usage.input_tokens': counts.input + counts.cacheWrite,
                'gen_ai.usage.cache_read_tokens': counts.cacheRead,
                'gen_ai.usage.output_tokens': counts.output,
                'gen_ai.usage.total_tokens': total,
              } : {}),
              ...(errorCode ? { 'error.code': safe(errorCode) } : {}),
              ...(failure?.message && errorCode !== 'AUTH' ? { 'error.message': safe(failure.message) } : {}),
            },
          })
          if (current !== undefined) {
            current.trace.modelCalls += 1
            current.trace.tokens += total
            commitTrace(current.trace)
          } else if (detached !== undefined) {
            detached.endedAt = endedAt
            detached.durationMs = duration(startedAt, endedAt)
            detached.status = status
            detached.modelCalls = 1
            detached.tokens = total
            if (errorCode) detached.errorCode = safe(errorCode)
            if (failure?.message && errorCode !== 'AUTH') detached.errorMessage = safe(failure.message)
            commitTrace(detached)
          }
        }
      }
    })()
  })

  const approvalStarted = entry => {
    const sessionId = entry?.sessionId
    if (typeof sessionId !== 'string') return
    const active = activeTurns.get(sessionId)
    if (active === undefined) return
    const span = addSpan({
      traceId: active.trace.id,
      parentSpanId: active.rootSpan.id,
      kind: 'approval',
      name: 'approval.wait',
      startedAt: entry.at ?? Date.now(),
      status: 'running',
      attributes: {
        'ds_bot.approval.id': entry.id,
        'ds_bot.tool.name': entry.tool,
        'ds_bot.approval.reason.characters': entry.reason?.length ?? 0,
        ...(entry.roomId ? { 'ds_bot.room.id': entry.roomId } : {}),
      },
    })
    activeApprovals.set(entry.id, span)
  }
  const approvalFinished = (id, outcome) => {
    const span = activeApprovals.get(id)
    if (span === undefined) return
    activeApprovals.delete(id)
    finishSpan(span, outcome === 'rejected' || outcome === 'cancelled' ? 'error' : 'ok', {
      'ds_bot.approval.outcome': outcome ?? 'unknown',
    })
  }

  const thresholds = () => {
    state.observability ??= {}
    const current = state.observability.thresholds ?? {}
    return {
      turnSuccessMin: clampInt(current.turnSuccessMin, 0, 100, DEFAULT_THRESHOLDS.turnSuccessMin),
      toolFailureMax: clampInt(current.toolFailureMax, 0, 100, DEFAULT_THRESHOLDS.toolFailureMax),
      p95MsMax: clampInt(current.p95MsMax, 1_000, 3_600_000, DEFAULT_THRESHOLDS.p95MsMax),
      modelErrorMax: clampInt(current.modelErrorMax, 0, 100, DEFAULT_THRESHOLDS.modelErrorMax),
    }
  }

  function overview({ hours = 24, botId } = {}) {
    const range = clampInt(hours, 1, 24 * 30, 24)
    const now = Date.now()
    const from = now - range * 3_600_000
    const selected = [...traces.values()].filter(trace => trace.startedAt >= from && (botId === undefined || botId === '' || trace.botId === botId))
    const turns = selected.filter(trace => trace.kind === 'turn')
    const finished = turns.filter(trace => trace.endedAt !== undefined)
    const successes = finished.filter(trace => trace.status === 'completed').length
    const failures = finished.filter(trace => trace.status === 'error' || trace.status === 'interrupted').length
    const aborted = finished.filter(trace => trace.status === 'aborted' || trace.status === 'blocked').length
    const durations = finished.map(trace => trace.durationMs ?? 0)
    const traceIds = new Set(selected.map(trace => trace.id))
    const selectedSpans = [...spans.values()].filter(span => traceIds.has(span.traceId))
    const tools = selectedSpans.filter(span => span.kind === 'tool')
    const toolFailures = tools.filter(span => span.status === 'error').length
    const models = selectedSpans.filter(span => span.kind === 'model')
    const modelFailures = models.filter(span => span.status === 'error').length
    const totalTurns = turns.length
    const successRate = finished.length === 0 ? 100 : (successes / finished.length) * 100
    const toolFailureRate = tools.length === 0 ? 0 : (toolFailures / tools.length) * 100
    const modelErrorRate = models.length === 0 ? 0 : (modelFailures / models.length) * 100
    const p95Ms = percentile(durations, 0.95)
    const config = thresholds()
    const alerts = []
    if (finished.length > 0 && successRate < config.turnSuccessMin) alerts.push({ id: 'success-rate', level: 'error', value: successRate, threshold: config.turnSuccessMin })
    if (tools.length > 0 && toolFailureRate > config.toolFailureMax) alerts.push({ id: 'tool-failures', level: 'warn', value: toolFailureRate, threshold: config.toolFailureMax })
    if (finished.length > 0 && p95Ms > config.p95MsMax) alerts.push({ id: 'turn-p95', level: 'warn', value: p95Ms, threshold: config.p95MsMax })
    if (models.length > 0 && modelErrorRate > config.modelErrorMax) alerts.push({ id: 'model-errors', level: 'error', value: modelErrorRate, threshold: config.modelErrorMax })

    const buckets = Math.min(48, Math.max(1, range))
    const bucketMs = range * 3_600_000 / buckets
    const trend = Array.from({ length: buckets }, (_, index) => ({
      at: from + index * bucketMs,
      turns: 0,
      failed: 0,
      p95Ms: 0,
    }))
    for (const trace of turns) {
      const index = Math.min(buckets - 1, Math.max(0, Math.floor((trace.startedAt - from) / bucketMs)))
      const bucket = trend[index]
      bucket.turns += 1
      if (['error', 'aborted', 'blocked', 'interrupted'].includes(trace.status)) bucket.failed += 1
      bucket.p95Ms = Math.max(bucket.p95Ms, trace.durationMs ?? 0)
    }
    const byBot = new Map()
    for (const trace of turns) {
      const key = trace.botId ?? 'unowned'
      const item = byBot.get(key) ?? { botId: trace.botId, name: trace.botName ?? 'Other', turns: 0, failed: 0, p95Ms: 0, tokens: 0 }
      item.turns += 1
      if (['error', 'aborted', 'blocked', 'interrupted'].includes(trace.status)) item.failed += 1
      item.p95Ms = Math.max(item.p95Ms, trace.durationMs ?? 0)
      item.tokens += trace.tokens ?? 0
      byBot.set(key, item)
    }
    const recentFailures = finished
      .filter(trace => trace.status !== 'completed')
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 20)
      .map(traceSummary)
    const recent = selected
      .filter(trace => trace.kind === 'turn')
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 100)
      .map(traceSummary)
    return {
      available: true,
      now,
      rangeHours: range,
      thresholds: config,
      alerts,
      summary: {
        turns: totalTurns,
        finished: finished.length,
        successes,
        failures,
        aborted,
        successRate,
        p50Ms: percentile(durations, 0.5),
        p95Ms,
        toolCalls: tools.length,
        toolFailures,
        toolFailureRate,
        modelCalls: models.length,
        modelFailures,
        modelErrorRate,
        tokens: selected.reduce((sum, trace) => sum + (trace.tokens ?? 0), 0),
      },
      trend,
      byBot: [...byBot.values()].sort((a, b) => b.turns - a.turns),
      recent,
      recentFailures,
    }
  }

  function traceDetail(id) {
    const trace = traces.get(String(id ?? ''))
    if (trace === undefined) return undefined
    return {
      trace: traceSummary(trace),
      spans: [...(byTrace.get(trace.id) ?? [])].sort((a, b) => a.startedAt - b.startedAt || a.durationMs - b.durationMs),
    }
  }

  async function saveThresholds(body = {}) {
    await rt.load()
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw new Error(readOnly)
    state.observability ??= {}
    state.observability.thresholds = {
      turnSuccessMin: clampInt(body.turnSuccessMin, 0, 100, DEFAULT_THRESHOLDS.turnSuccessMin),
      toolFailureMax: clampInt(body.toolFailureMax, 0, 100, DEFAULT_THRESHOLDS.toolFailureMax),
      p95MsMax: clampInt(body.p95MsMax, 1_000, 3_600_000, DEFAULT_THRESHOLDS.p95MsMax),
      modelErrorMax: clampInt(body.modelErrorMax, 0, 100, DEFAULT_THRESHOLDS.modelErrorMax),
    }
    await rt.save()
    return thresholds()
  }

  function exportData() {
    return {
      exportedAt: new Date().toISOString(),
      resource: { service: { name: 'ds-bot' } },
      records: [
        ...[...traces.values()].sort((a, b) => a.startedAt - b.startedAt).map(trace => ({ kind: 'trace', trace })),
        ...[...spans.values()].sort((a, b) => a.startedAt - b.startedAt).map(span => ({ kind: 'span', span })),
      ],
    }
  }

  async function endpoint(name, body = {}) {
    if (name === 'observability') return overview(body)
    if (name === 'observability-trace') {
      const detail = traceDetail(body.id)
      if (detail === undefined) throw Object.assign(new Error('No such trace'), { code: 'bot/not-found' })
      return detail
    }
    if (name === 'observability-config') return saveThresholds(body)
    if (name === 'observability-export') return exportData()
    throw Object.assign(new Error('Unknown observability operation'), { code: 'bot/not-found' })
  }

  ctx.tools.register(defineTool({
    name: 'observability_overview',
    description: 'Main Bot only. Read recent turn, model, tool and approval health without prompt text, tool arguments or secrets.',
    parameters: {
      hours: { type: 'integer', description: 'Look back this many hours; defaults to 24, maximum 720' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await rt.load()
      const bot = rt.botOf(rt.selfOf?.(exec.agent?.id))
      if (bot === undefined) return 'Only Bots on the team can use observability_overview.'
      if (!rt.isMain(bot.id)) return 'Only a Main Bot can read observability_overview.'
      const view = overview({ hours: args.hours })
      return [
        `Observability · last ${view.rangeHours}h`,
        `Turns: ${view.summary.turns}; success ${view.summary.successRate.toFixed(1)}%; p95 ${view.summary.p95Ms} ms; tokens ${view.summary.tokens}`,
        `Tools: ${view.summary.toolCalls}; failures ${view.summary.toolFailureRate.toFixed(1)}%`,
        `Model calls: ${view.summary.modelCalls}; errors ${view.summary.modelErrorRate.toFixed(1)}%`,
        view.alerts.length === 0 ? 'No threshold alerts.' : `Alerts: ${view.alerts.map(alert => alert.id).join(', ')}`,
        ...(view.recentFailures.length === 0 ? [] : ['', 'Recent failures:', ...view.recentFailures.slice(0, 8).map(trace => `- ${trace.startedAt} · ${trace.botName ?? trace.sessionId} · turn ${trace.turn} · ${trace.status}${trace.errorCode ? ` · ${trace.errorCode}` : ''}`)]),
      ].join('\n')
    },
  }))

  ctx.effect(() => {
    void (async () => {
      let contents = ''
      try {
        contents = await readFile(path, 'utf8')
        bytes = Buffer.byteLength(contents)
      } catch (error) {
        if (error?.code !== 'ENOENT') rt.warn('ds-bot: observability history not read: %s', error)
      }
      for (const line of contents.split('\n')) {
        if (line === '') continue
        try { applyRecord(JSON.parse(line)) } catch {}
      }
      const now = Date.now()
      for (const trace of traces.values()) {
        if (trace.status === 'running') {
          trace.status = 'interrupted'
          trace.errorCode = 'RESTART'
          trace.errorMessage = 'DS Bot restarted while this turn was running'
          trace.endedAt = trace.endedAt ?? now
          trace.durationMs = duration(trace.startedAt, trace.endedAt)
        }
      }
      for (const span of spans.values()) {
        if (span.status !== 'running') continue
        span.status = 'interrupted'
        span.endedAt = span.endedAt ?? now
        span.durationMs = duration(span.startedAt, span.endedAt)
        span.attributes = { ...span.attributes, 'ds_bot.interrupted': true }
      }
      for (const [id, trace] of traces) if (trace.startedAt < now - MAX_AGE_MS) {
        traces.delete(id)
        for (const span of byTrace.get(id) ?? []) spans.delete(span.id)
        byTrace.delete(id)
      }
      loaded = true
      for (const item of pendingRecords.splice(0)) {
        applyRecord(item)
        writeRecord(item)
      }
      readyResolve()
    })().catch(error => {
      rt.warn('ds-bot: observability could not start: %s', error)
      loaded = true
      for (const item of pendingRecords.splice(0)) {
        applyRecord(item)
        writeRecord(item)
      }
      readyResolve()
    })
    return async () => {
      for (const sessionId of activeTurns.keys()) endTurn(sessionId, { kind: 'aborted' })
      stopped = true
      await writing
    }
  }, 'ds-bot: observability')

  Object.assign(rt, {
    observabilityEndpoint: endpoint,
    observabilityView: overview,
    observabilityTrace: traceDetail,
    observabilityExport: exportData,
    observabilityReady: ready,
    observabilityApprovalStarted: approvalStarted,
    observabilityApprovalFinished: approvalFinished,
    observabilityTagTurn: (sessionId, attributes) => {
      const active = activeTurns.get(sessionId)
      if (active === undefined) return
      active.trace.attrs = { ...active.trace.attrs, ...attributes }
      commitTrace(active.trace)
    },
  })
}
