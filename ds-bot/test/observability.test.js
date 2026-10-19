import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { install } from '../src/host/observability.js'
import { fakeContext } from './fake-ctx.js'

const setup = ({ home: providedHome } = {}) => {
  const home = providedHome ?? mkdtempSync(join(tmpdir(), 'ds-bot-observability-'))
  const state = {
    bots: { chief: { id: 'chief', name: 'Chief' } },
    rooms: { room: { id: 'room', name: 'Build', members: ['chief'] } },
    observability: {},
  }
  const ctx = fakeContext()
  const groupOwners = new Map([['group-chief', { botId: 'chief', roomId: 'room' }]])
  const rt = {
    ctx,
    home,
    state,
    load: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    warn: () => {},
    redactSecrets: text => String(text).replaceAll('sk-secret-value', '[secret:KEY]'),
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    selfOf: id => groupOwners.get(id)?.botId ?? (state.bots[id] ? id : undefined),
    isMain: () => true,
    groupOwners,
  }
  install(rt)
  return { home, state, ctx, rt }
}

const emit = (env, sessionId, event) => {
  for (const listener of env.ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
}

test('turn, model, tool, approval and handoff spans feed health metrics without storing prompts', async (t) => {
  const env = setup()
  t.after(() => rmSync(env.home, { recursive: true, force: true, maxRetries: 5 }))
  await env.rt.observabilityReady
  const now = Date.now() - 10
  emit(env, 'chief', { type: 'turn/start', time: now, data: { turn: 1 } })
  emit(env, 'chief', {
    type: 'user/message',
    time: now + 1,
    data: {
      source: { kind: 'bot', role: 'request', exchangeId: 'exchange-1', summary: 'handoff summary' },
      content: [{ type: 'text', text: 'PROMPT TEXT MUST NOT BE STORED sk-secret-value' }],
    },
  })
  env.rt.observabilityTagTurn('chief', { 'ds_bot.eval.run': 'eval-1' })
  const stream = env.ctx.listeners.get('llm/stream')[0]
  const iterable = stream({ sessionId: 'chief', provider: 'deepseek', model: 'deepseek-flash' }, async function* () {
    yield { type: 'text-delta', text: 'hello' }
    yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 3, cacheWriteTokens: 1, outputTokens: 4 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  for await (const chunk of iterable) assert.ok(chunk)
  emit(env, 'chief', {
    type: 'tool/call',
    time: now + 2,
    data: { callId: 'call-1', turn: 1, name: 'read', arguments: JSON.stringify({ path: 'secret.txt' }) },
  })
  env.rt.observabilityApprovalStarted({ id: 'approval-1', sessionId: 'chief', tool: 'shell', reason: 'run tests', at: now + 3 })
  env.rt.observabilityApprovalFinished('approval-1', 'allowed-once')
  emit(env, 'chief', { type: 'tool/result', time: now + 4, data: { callId: 'call-1', isError: false } })
  emit(env, 'chief', {
    type: 'assistant/message',
    time: now + 5,
    data: { turn: 1, message: { content: [{ type: 'text', text: 'done' }] }, usage: { inputTokens: 5, outputTokens: 2 } },
  })
  emit(env, 'chief', { type: 'turn/end', time: now + 20, data: { reason: { kind: 'completed' } } })

  const view = env.rt.observabilityView({ hours: 24 })
  assert.equal(view.summary.turns, 1)
  assert.equal(view.summary.successes, 1)
  assert.equal(view.summary.toolCalls, 1)
  assert.equal(view.summary.toolFailures, 0)
  assert.equal(view.summary.modelCalls, 1)
  assert.equal(view.summary.tokens, 18)
  assert.equal(view.summary.p95Ms, 20)
  assert.equal(view.alerts.length, 0)
  const [recent] = view.recent
  assert.equal(recent.sourceKind, 'bot')
  const detail = env.rt.observabilityTrace(recent.id)
  assert.ok(detail.spans.some(span => span.kind === 'model'))
  assert.ok(detail.spans.some(span => span.kind === 'tool' && span.name === 'tool.read'))
  assert.ok(detail.spans.some(span => span.kind === 'approval' && span.status === 'ok'))
  assert.ok(detail.spans.some(span => span.kind === 'event' && span.name === 'handoff.message'))
  assert.equal(detail.trace.botName, 'Chief')
  const tool = env.ctx.registeredTools.get('observability_overview')
  const report = await tool.execute({ hours: 24 }, { agent: { id: 'chief' } })
  assert.match(report, /Turns: 1/)
  assert.match(report, /No threshold alerts/)

  const exported = env.rt.observabilityExport()
  assert.ok(exported.records.length > 5)
  assert.ok(!JSON.stringify(exported).includes('PROMPT TEXT MUST NOT BE STORED'))
  assert.ok(!JSON.stringify(exported).includes('secret.txt'))
  assert.ok(!JSON.stringify(exported).includes('sk-secret-value'))
  await env.ctx.dispose()
  assert.ok(!readFileSync(join(env.home, 'observability.jsonl'), 'utf8').includes('PROMPT TEXT MUST NOT BE STORED'))
})

test('a stale running trace and span become interrupted after restart', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-observability-restart-'))
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5 }))
  const old = Date.now() - 1_000
  writeFileSync(join(home, 'observability.jsonl'), [
    JSON.stringify({
      kind: 'trace',
      trace: {
        id: 'trace-old', kind: 'turn', name: 'agent.turn', sessionId: 'chief', turn: 2,
        botId: 'chief', botName: 'Chief', startedAt: old, status: 'running',
        assistantMessages: 0, toolCalls: 1, toolFailures: 0, modelCalls: 0, tokens: 0, attrs: {},
      },
    }),
    JSON.stringify({
      kind: 'span',
      span: {
        id: 'span-old', traceId: 'trace-old', kind: 'tool', name: 'tool.shell',
        startedAt: old, endedAt: old, durationMs: 0, status: 'running', attributes: {},
      },
    }),
  ].join('\n'))
  const env = setup({ home })
  await env.rt.observabilityReady
  const view = env.rt.observabilityView({ hours: 24 })
  assert.equal(view.recent[0].status, 'interrupted')
  const detail = env.rt.observabilityTrace('trace-old')
  assert.equal(detail.spans[0].status, 'interrupted')
  assert.equal(detail.spans[0].attributes['ds_bot.interrupted'], true)
  await env.ctx.dispose()
})

test('thresholds are validated and surfaced as alerts', async (t) => {
  const env = setup()
  t.after(() => rmSync(env.home, { recursive: true, force: true, maxRetries: 5 }))
  await env.rt.observabilityReady
  const now = Date.now() - 5
  emit(env, 'chief', { type: 'turn/start', time: now, data: { turn: 3 } })
  emit(env, 'chief', { type: 'turn/end', time: now + 200_000, data: { reason: { kind: 'error', error: { code: 'AUTH', message: 'sk-secret-value' } } } })
  await env.rt.observabilityEndpoint('observability-config', {
    turnSuccessMin: 99,
    p95MsMax: 1_000,
    modelErrorMax: 5,
    toolFailureMax: 10,
  })
  const view = env.rt.observabilityView({ hours: 24 })
  assert.equal(view.thresholds.turnSuccessMin, 99)
  assert.ok(view.alerts.some(alert => alert.id === 'success-rate'))
  assert.ok(view.alerts.some(alert => alert.id === 'turn-p95'))
  assert.equal(view.recentFailures[0].errorCode, 'AUTH')
  assert.equal(view.recentFailures[0].errorMessage, undefined)
  await env.ctx.dispose()
})
