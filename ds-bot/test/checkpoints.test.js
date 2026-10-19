import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install, latestCompletedTurn } from '../src/host/checkpoints.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (check) => {
  const end = Date.now() + 2000
  while (!check()) {
    if (Date.now() > end) throw new Error('condition did not settle')
    await tick()
  }
}

function session(id = 's1', events = []) {
  return {
    id,
    header: { id, cwd: 'C:\\work\\repo' },
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'deepseek', model: 'v4' } }),
    deriveMessages: () => [],
  }
}

function setup({ events = [], checkpoints = [] } = {}) {
  const ctx = fakeContext({
    services: {
      workingDirectory: { get: current => current.header.cwd },
    },
  })
  const source = session('s1', events)
  const sessions = new Map([['s1', source]])
  const state = {
    bots: {
      b: {
        id: 'b',
        name: 'Builder',
        sessionId: 's1',
        segments: [],
        checkpoints,
      },
    },
  }
  const forks = []
  const applied = []
  Object.assign(ctx, {
    sessionController: {
      fork: async (request) => {
        forks.push(request)
        const child = session('f1', [])
        sessions.set(child.id, child)
        return { sessionId: child.id }
      },
    },
    sessionTitle: { rename: async () => {} },
    workspaceRegistry: { archiveSession: async () => {} },
  })
  const rt = {
    ctx,
    state,
    config: {},
    warn() {},
    load: async () => {},
    save: async () => {},
    readOnly: () => undefined,
    botOf: id => state.bots[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    chatOwners: new Map([['s1', 'b']]),
    groupOwners: new Map(),
    pastOwners: new Map(),
    isBotSession: id => id === 's1' || id === 'f1',
    resolveAgent: async id => ({ session: sessions.get(id), status: 'idle' }),
    applyPermission: async (_bot, id) => applied.push(['permission', id]),
    applyModel: async (_bot, options) => applied.push(['model', options]),
    ensureCapabilities: async id => applied.push(['capabilities', id]),
  }
  install(rt)
  const tool = (name, args = {}) => ctx.registeredTools.get(name).execute(args, {
    agent: { id: 's1', session: source },
    signal: new AbortController().signal,
  })
  const turnEnd = async (event = { type: 'turn/end', seq: events.at(-1)?.seq ?? 0, time: 1, data: { reason: { kind: 'stop' } } }) => {
    for (const listener of ctx.listeners.get('session/event') ?? []) await listener(source, event)
  }
  return { ctx, rt, state, source, sessions, forks, applied, tool, turnEnd }
}

test('latestCompletedTurn finds the last closed turn', () => {
  const events = [
    { type: 'turn/start', seq: 0 },
    { type: 'user/message', seq: 1 },
    { type: 'turn/end', seq: 2 },
    { type: 'turn/start', seq: 3 },
  ]
  assert.deepEqual(latestCompletedTurn(session('s1', events)), { seq: 2, turn: 1, time: undefined })
})

test('checkpoint_create saves the latest completed turn and checkpoint_list reads it', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1 },
    { type: 'user/message', seq: 1, time: 2 },
    { type: 'assistant/message', seq: 2, time: 3 },
    { type: 'turn/end', seq: 3, time: 4 },
    { type: 'turn/start', seq: 4, time: 5 },
  ]
  const env = setup({ events })
  const made = await env.tool('checkpoint_create', { label: 'Before refactor' })
  assert.match(made, /Checkpoint saved: Before refactor/)
  assert.match(made, /Conversation only/)
  assert.equal(env.state.bots.b.checkpoints.length, 1)
  assert.equal(env.state.bots.b.checkpoints[0].seq, 3)
  const listed = await env.tool('checkpoint_list')
  assert.match(listed, /Before refactor/)
  assert.match(listed, /turn 1 · seq 3/)
})

test('an ordinary completed turn is checkpointed automatically', async () => {
  const events = [
    { type: 'turn/start', seq: 0, time: 1 },
    { type: 'turn/end', seq: 1, time: 2 },
  ]
  const env = setup({ events })
  await env.turnEnd({ type: 'turn/end', seq: 1, time: 2, data: { reason: { kind: 'stop' } } })
  await until(() => env.state.bots.b.checkpoints.length === 1)
  assert.equal(env.state.bots.b.checkpoints[0].source, 'auto')
  assert.equal(env.state.bots.b.checkpoints[0].seq, 1)
})

test('time_travel forks the checkpoint and switches after the current turn ends', async () => {
  const checkpoint = {
    id: 'checkpoint-one',
    createdAt: 1,
    label: 'Green tests',
    sessionId: 's1',
    seq: 7,
    turn: 2,
    source: 'manual',
    cwd: 'C:\\work\\repo',
  }
  const events = [
    { type: 'turn/start', seq: 8, time: 8 },
    { type: 'turn/end', seq: 9, time: 9 },
  ]
  const env = setup({ events, checkpoints: [checkpoint] })
  const prepared = await env.tool('time_travel', { checkpoint: 'Green tests' })
  assert.match(prepared, /Branch prepared/)
  assert.deepEqual(env.forks, [{ sessionId: 's1', atSeq: 7 }])
  assert.equal(env.state.bots.b.pendingBranch.forkSessionId, 'f1')
  env.ctx.sessionTitle.rename = () => {}
  await env.turnEnd({ type: 'turn/end', seq: 9, time: 9, data: { reason: { kind: 'stop' } } })
  await until(() => env.state.bots.b.sessionId === 'f1')
  await until(() => env.applied.length === 3)
  assert.deepEqual(env.state.bots.b.segments.at(-1), {
    sessionId: 's1',
    endedAt: env.state.bots.b.segments.at(-1).endedAt,
    reason: 'time-travel',
    checkpointId: 'checkpoint-one',
  })
  assert.equal(env.state.bots.b.pendingBranch, undefined)
  assert.equal(env.rt.chatOwners.get('f1'), 'b')
  assert.equal(env.rt.pastOwners.get('s1').botId, 'b')
  assert.deepEqual(env.applied.map(([kind]) => kind), ['permission', 'model', 'capabilities'])
})
