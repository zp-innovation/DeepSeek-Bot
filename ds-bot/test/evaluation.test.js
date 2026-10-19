import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { TEAM_TOOLS } from '../src/host/constants.js'
import { install } from '../src/host/evaluation.js'
import { fakeContext } from './fake-ctx.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async check => {
  for (const end = Date.now() + 2_000; Date.now() < end;) {
    if (check()) return
    await tick()
  }
  throw new Error('condition did not settle')
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'ds-bot-evaluation-'))
  const state = {
    bots: { chief: { id: 'chief', name: 'Chief', role: 'Engineer', instructions: 'Review carefully.', capabilities: ['review-skill'] } },
    capabilities: { items: { 'review-skill': { name: 'review-skill', kind: 'skill' } } },
    evaluations: { suites: {}, runs: [] },
  }
  const ctx = fakeContext()
  const events = []
  const archived = []
  const permissions = []
  const models = []
  let made = 0
  let mode = 'pass'
  const agents = new Map()
  ctx.sessions = { flush: async () => {} }
  ctx.tools.schemas = () => [...TEAM_TOOLS, 'read'].map(name => ({ name }))
  ctx.workspaceRegistry = { archiveSession: async (id, options) => { archived.push({ id, options }) } }
  ctx.sessionController = {
    async prompt(request, signal) {
      signal?.throwIfAborted()
      const sessionId = request.sessionId
      const text = request.content[0].text
      setImmediate(() => {
        emit(sessionId, { type: 'turn/start', time: Date.now(), data: { turn: 1 } })
        emit(sessionId, {
          type: 'tool/call',
          time: Date.now(),
          data: { callId: 'call-1', turn: 1, name: text.includes('forbidden') ? 'shell' : 'read', arguments: '{}' },
        })
        emit(sessionId, { type: 'tool/result', time: Date.now(), data: { callId: 'call-1', isError: false } })
        emit(sessionId, {
          type: 'assistant/message',
          time: Date.now(),
          data: {
            turn: 1,
            message: { content: [{ type: 'text', text: mode === 'pass' ? 'expected answer' : 'wrong answer' }] },
            usage: { inputTokens: 4, outputTokens: 2 },
          },
        })
        emit(sessionId, { type: 'turn/end', time: Date.now(), data: { reason: { kind: 'completed' } } })
      })
      return { accepted: true }
    },
  }
  function emit(sessionId, event) {
    events.push({ sessionId, event })
    for (const listener of ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
  }
  const rt = {
    ctx,
    home,
    state,
    load: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    warn: () => {},
    redactSecrets: text => String(text).replaceAll('secret-value', '[secret:KEY]'),
    botOf: id => state.bots[id],
    selfOf: id => (id === 'chief' ? 'chief' : undefined),
    isMain: id => id === 'chief',
    permissionCatalog: () => ({ options: [{ value: 'read-only', name: 'Read only' }] }),
    async createSession() {
      made += 1
      const id = `eval-${made}`
      const agent = {
        id,
        session: { id },
        ctx: { tools: { restrict: request => { agent.restricted = request } } },
      }
      agents.set(id, agent)
      return id
    },
    async resolveAgent(id) {
      return agents.get(id)
    },
    desiredModel: async () => 'deepseek/deepseek-flash',
    selectSessionModel: async (id, route) => { models.push({ id, route }) },
    applyPermission: async (bot, id) => { permissions.push({ bot, id }) },
    prepareCapabilitiesForEval: async (agent, bot) => { agent.capabilities = bot.capabilities },
    observabilityTagTurn: () => {},
  }
  install(rt)
  return {
    home,
    state,
    ctx,
    rt,
    archived,
    permissions,
    models,
    agents,
    setMode: value => { mode = value },
  }
}

const suite = {
  name: 'Review behavior',
  description: 'Checks the review answer',
  targetBotId: 'chief',
  cases: [{
    name: 'Finds the expected answer',
    prompt: 'Review this change.',
    contains: 'expected',
    requiredTools: ['read'],
    forbiddenTools: ['shell'],
    maxDurationMs: 10_000,
    maxTokens: 20,
  }],
}

test('evaluation runs in a read-only isolated Session, denies team tools, archives, and compares regressions', async (t) => {
  const env = setup()
  t.after(() => rmSync(env.home, { recursive: true, force: true, maxRetries: 5 }))
  const saved = await env.rt.evaluationEndpoint('eval-save', suite)
  assert.equal(saved.targetName, 'Chief')
  assert.equal(env.ctx.sections.has('eval-target'), true)

  const first = await env.rt.evaluationEndpoint('eval-run', { id: saved.id })
  assert.equal(first.status, 'running')
  await until(() => env.rt.evaluationView().runs[0]?.status !== 'running')
  const passed = env.rt.evaluationView().runs[0]
  assert.equal(passed.status, 'completed')
  assert.equal(passed.results[0].status, 'passed')
  assert.equal(passed.summary.passRate, 100)
  assert.equal(passed.results[0].tokens, 6)
  assert.equal(env.archived.length, 1)
  assert.deepEqual(env.models[0], { id: 'eval-1', route: { provider: 'deepseek', model: 'deepseek-flash' } })
  assert.equal(env.permissions[0].bot.permission, 'read-only')
  const restricted = env.agents.get('eval-1').restricted.deny
  assert.ok(restricted.includes('create_bot'))
  assert.ok(restricted.includes('message_bot'))
  assert.ok(!restricted.includes('read'))

  env.setMode('fail')
  const second = await env.rt.evaluationEndpoint('eval-run', { id: saved.id })
  await until(() => env.rt.evaluationView().runs.find(run => run.id === second.id)?.status !== 'running')
  const failed = env.rt.evaluationView().runs.find(run => run.id === second.id)
  assert.equal(failed.results[0].status, 'failed')
  assert.equal(failed.comparison.regressions[0], 'Finds the expected answer')
  assert.equal(failed.comparison.passDelta, -1)
  assert.match(env.rt.evaluationView().runs[0].results[0].output, /wrong answer/)
  const listed = await env.ctx.registeredTools.get('eval_list').execute({}, { agent: { id: 'chief' } })
  assert.match(listed, /Review behavior/)
  assert.match(listed, /completed/)
})

test('suite validation rejects bad regular expressions and missing target Bots', async (t) => {
  const env = setup()
  t.after(() => rmSync(env.home, { recursive: true, force: true, maxRetries: 5 }))
  await assert.rejects(env.rt.evaluationEndpoint('eval-save', {
    ...suite,
    cases: [{ ...suite.cases[0], regex: '[' }],
  }), /valid regular expression/)
  await assert.rejects(env.rt.evaluationEndpoint('eval-save', {
    ...suite,
    targetBotId: 'missing',
  }), /target Bot/)
})
