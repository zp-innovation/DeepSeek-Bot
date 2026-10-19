import assert from 'node:assert/strict'
import { test } from 'node:test'
import { install } from '../src/host/automations.js'
import { fakeContext } from './fake-ctx.js'

const tick = () => new Promise(resolve => setImmediate(resolve))
const until = async (check) => {
  for (const end = Date.now() + 2000; Date.now() < end;) {
    if (check()) return
    await tick()
  }
  throw new Error('condition did not settle')
}

function setup() {
  const ctx = fakeContext()
  const state = {
    bots: {
      chief: { id: 'chief', name: 'Chief', sessionId: 'chief' },
      coder: { id: 'coder', name: 'Coder', sessionId: 'coder' },
    },
    rooms: { room: { id: 'room', name: 'Build', members: ['chief', 'coder'] } },
    automations: { items: {}, runs: [] },
    scheduleMoves: {},
  }
  const delivered = []
  const sessions = {
    chief: { id: 'chief' },
    coder: { id: 'coder' },
    room: { id: 'room' },
  }
  let revision = 0
  const rt = {
    ctx,
    state,
    config: {},
    load: async () => {},
    save: async () => { revision += 1; return revision },
    readOnly: () => undefined,
    warn() {},
    isMain: id => id === 'chief',
    botOf: id => state.bots[id],
    roomOf: id => state.rooms[id],
    chatOf: id => state.bots[id]?.sessionId ?? id,
    selfOf: id => sessions[id]?.botId ?? (state.bots[id] ? id : id === 'group-coder' ? 'coder' : undefined),
    findBot: ref => Object.values(state.bots).find(bot => bot.name.toLowerCase() === String(ref).toLowerCase()),
    findRooms: ref => Object.values(state.rooms).filter(room => room.name.toLowerCase() === String(ref).toLowerCase()),
    ensureCapabilities: async () => {},
    resolveAgent: async sessionId => ({
      session: sessions[sessionId],
      followup(message) { delivered.push({ sessionId, message }) },
    }),
    redactSecrets: value => value,
    scheduleCatalog: async () => ({ available: false, tasks: [] }),
    groupOwners: new Map(),
  }
  sessions.chief.botId = 'chief'
  sessions.coder.botId = 'coder'
  ctx.sessions = { flush: async () => {} }
  install(rt)
  return { ctx, rt, state, delivered, sessions }
}

const rule = (overrides = {}) => ({
  name: 'Tell Chief',
  triggerKind: 'turn_failed',
  sourceBot: 'Coder',
  contains: 'push',
  targetKind: 'bot',
  target: 'Chief',
  prompt: '{{bot}} had {{status}}: {{text}}',
  cooldownSeconds: 0,
  enabled: true,
  ...overrides,
})

const emit = (env, sessionId, event) => {
  for (const listener of env.ctx.listeners.get('session/event') ?? []) listener({ id: sessionId }, event)
}

test('event automation templates are validated and rendered once', async () => {
  const env = setup()
  await assert.rejects(env.rt.automationSave(rule({ prompt: 'Unknown {{password}}' }), { ui: true }), /Unknown automation token/)
  const saved = await env.rt.automationSave(rule(), { ui: true })
  assert.equal(saved.name, 'Tell Chief')
  assert.equal(saved.sourceBotName, 'Coder')
  emit(env, 'coder', { type: 'turn/end', seq: 7, data: { reason: { kind: 'error', error: { code: 'PUSH', message: 'push failed' } } } })
  await until(() => env.delivered.length === 1)
  const text = env.delivered[0].message.content[0].text
  assert.match(text, /\[Automation · Tell Chief\]/)
  assert.match(text, /Coder had error: PUSH: push failed/)
  assert.equal(env.delivered[0].message.source.kind, 'automation')
  assert.equal(env.delivered[0].message.source.eventKey, 'coder:7')
})

test('duplicate events, cooldowns and self-target cascades are suppressed', async () => {
  const env = setup()
  await env.rt.automationSave(rule(), { ui: true })
  emit(env, 'coder', { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'push failed' } } } })
  await until(() => env.delivered.length === 1)
  emit(env, 'coder', { type: 'turn/end', seq: 1, data: { reason: { kind: 'error', error: { message: 'push failed' } } } })
  await tick()
  assert.equal(env.delivered.length, 1)

  const [item] = Object.values(env.state.automations.items)
  await env.rt.automationSave({
    id: item.id,
    name: 'Self loop',
    triggerKind: 'turn_completed',
    sourceBot: 'Coder',
    targetKind: 'bot',
    target: 'Coder',
    prompt: 'Again',
    cooldownSeconds: 0,
    enabled: true,
  }, { ui: true })
  emit(env, 'coder', {
    type: 'user/message',
    seq: 2,
    data: { source: { kind: 'automation', automationDepth: 1 }, content: [{ type: 'text', text: 'wake' }] },
  })
  emit(env, 'coder', { type: 'turn/end', seq: 3, data: { reason: { kind: 'completed' } } })
  await tick()
  assert.equal(env.delivered.length, 1)
})

test('only Main Bots can change rules through Bot tools', async () => {
  const env = setup()
  const create = env.ctx.registeredTools.get('automation_rule_create')
  const denied = await create.execute(rule(), { agent: { id: 'coder' } })
  assert.match(denied, /Only a Main Bot/)
  const made = await create.execute(rule(), { agent: { id: 'chief' } })
  assert.match(made, /Created automation/)
  const list = await env.ctx.registeredTools.get('automation_list').execute({}, { agent: { id: 'coder' } })
  assert.match(list, /Tell Chief/)
  const remove = env.ctx.registeredTools.get('automation_rule_delete')
  assert.match(await remove.execute({ id: Object.values(env.state.automations.items)[0].id }, { agent: { id: 'coder' } }), /Only a Main Bot/)
})

test('approval events can wake a group with the event text', async () => {
  const env = setup()
  await env.rt.automationSave(rule({
    name: 'Approval watch',
    triggerKind: 'approval_requested',
    contains: 'shell',
    targetKind: 'room',
    target: 'Build',
    prompt: 'Approval needed: {{text}}',
    cooldownSeconds: 0,
  }), { ui: true })
  await env.rt.automationEvent({
    kind: 'approval_requested',
    sessionId: 'coder',
    sourceBotId: 'coder',
    roomId: 'room',
    text: 'shell: escalate sandbox',
    status: 'waiting',
    eventKey: 'approval:a1',
  })
  await until(() => env.delivered.length === 1)
  assert.equal(env.delivered[0].sessionId, 'room')
  assert.match(env.delivered[0].message.content[0].text, /Approval needed: shell: escalate sandbox/)
})
