import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createRuntime } from '../index.js'
import { fakeContext } from './fake-ctx.js'
import { reminderText, scheduleRecordOf } from '../src/host/schedules.js'

const TEAM = {
  version: 1,
  mainBotIds: ['m1'],
  revision: 1,
  bots: {
    m1: { id: 'm1', sessionId: 'm1', name: 'Chief', role: 'Chief of Staff', instructions: '', createdAt: 1 },
    w1: { id: 'w1', sessionId: 'w2', name: 'Writer', role: '', instructions: '', createdAt: 2, segments: [{ sessionId: 'w1', endedAt: 3 }] },
  },
  rooms: { g1: { id: 'g1', name: 'Launch', named: true, members: ['m1', 'w1'], sessions: { w1: 'room-writer' }, admin: 'm1', mode: 'admin', notice: '', createdAt: 4 } },
  exchanges: [],
  exchangeTurns: {},
  questions: {},
}

// An in-memory stand-in for DSH's schedule service.
function scheduleService() {
  const tasks = new Map()
  let next = 1
  return {
    tasks,
    async create(sessionId, request) {
      const id = `schedule-${next++}`
      const kind = Object.keys(request).find(key => !['title', 'prompt'].includes(key))
      const timing = request[kind]
      const record = {
        id,
        kind,
        title: request.title,
        prompt: request.prompt,
        timing,
        scheduledAt: request.at ?? '2030-01-01T01:00:00.000Z',
        ...(request.every_seconds === undefined ? {} : { everySeconds: request.every_seconds }),
        ...(timing?.time === undefined ? {} : { time: timing.time, timeZone: timing.time_zone }),
        ...(timing?.weekdays === undefined ? {} : { weekdays: timing.weekdays }),
        ...(timing?.expression === undefined ? {} : { expression: timing.expression, timeZone: timing.time_zone }),
      }
      tasks.set(id, { sessionId, record, status: 'active' })
      return record
    },
    async list({ sessionId }) { return [...tasks.values()].filter(task => task.sessionId === sessionId && task.status === 'active').map(task => task.record) },
    async catalog() { return [...tasks.values()].map(task => ({ ...task.record, sessionId: task.sessionId, status: task.status })) },
    async update(request) {
      const task = tasks.get(request.id)
      if (task?.sessionId !== request.sessionId) return { id: request.id, updated: false, code: 'schedule_not_found' }
      if (task.status !== 'active') return { id: request.id, updated: false, code: 'schedule_ended' }
      if (JSON.stringify(scheduleRecordOf(task.record)) !== JSON.stringify(request.expected)) return { id: request.id, updated: false, code: 'schedule_conflict' }
      const kind = request.change?.kind ?? task.record.kind
      const timing = request.change?.[kind]
      task.record = {
        ...task.record,
        title: request.title ?? task.record.title,
        prompt: request.prompt ?? task.record.prompt,
        kind,
        ...(kind === 'cron' ? { expression: timing.expression, timeZone: timing.time_zone } : {}),
        ...(kind === 'every' ? { everySeconds: request.change.every_seconds } : {}),
      }
      return { id: task.record.id, updated: true, record: task.record }
    },
    async history({ sessionId, id, limit }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, code: 'schedule_not_found' }
      return {
        id,
        records: [{ scheduledAt: '2030-01-01T01:00:00.000Z', deliveredAt: '2030-01-01T01:00:01.000Z', messageId: 'm1', prompt: 'Hello' }].slice(0, limit),
        earlierRecordsUnavailable: false,
        earlierRecordsPruned: false,
        retention: { days: 30, records: 200 },
      }
    },
    async delete({ sessionId, id }) {
      if (tasks.get(id)?.sessionId !== sessionId) return { id, deleted: false, code: 'schedule_not_found' }
      tasks.delete(id)
      return { id, deleted: true }
    },
  }
}

function setup(services = {}) {
  const home = mkdtempSync(join(tmpdir(), 'dsb-schedules-'))
  writeFileSync(join(home, 'state.json'), JSON.stringify(TEAM))
  const ctx = fakeContext({ services })
  const register = ctx.connection.fetch.register
  ctx.connection.fetch.register = (route) => { ctx.route = route; return register(route) }
  const rt = createRuntime(ctx, { home })
  const call = async (endpoint, payload) => (await ctx.route.fetch(new Request('http://localhost/api/bot', { method: 'POST', body: JSON.stringify({ endpoint, payload }) }))).json()
  return { ctx, home, rt, call }
}

test('without the schedule service the page says so and creating is refused', async (t) => {
  const { ctx, home, call } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  assert.deepEqual((await call('schedules', {})).value, { available: false, tasks: [] })
  const refused = await call('schedule-create', { target: 'm1', title: 'Briefing', prompt: 'Sum up', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(refused.ok, false)
  assert.match(refused.error.message, /Automation tasks are off/)
})

test('state migration adds event automation storage and schedule move intents', async (t) => {
  const { ctx, home, rt } = setup()
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  await rt.load()
  assert.deepEqual(rt.state.automations, { items: {}, runs: [] })
  assert.deepEqual(rt.state.scheduleMoves, {})
})

test('tasks are created on the Bot’s current part, listed by Bot, and deleted', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const daily = await call('schedule-create', { target: 'w1', title: ' Briefing ', prompt: 'Sum up the day', when: { kind: 'daily', time: '09:00', timeZone: 'Asia/Shanghai' } })
  assert.equal(daily.ok, true, JSON.stringify(daily))
  const [created] = [...schedule.tasks.values()]
  assert.equal(created.sessionId, 'w2')
  assert.deepEqual(created.record.timing, { time: '09:00:00', time_zone: 'Asia/Shanghai' })
  assert.equal(created.record.title, 'Briefing')

  await schedule.create('w1', { title: 'Old part', prompt: 'x', every_seconds: 3600 })
  await schedule.create('outside', { title: 'Not ours', prompt: 'x', every_seconds: 3600 })
  const listed = (await call('schedules', {})).value
  assert.equal(listed.available, true)
  assert.deepEqual(listed.tasks.map(task => [task.title, task.botId]), [['Briefing', 'w1'], ['Old part', 'w1']])

  const weekly = await call('schedule-create', { target: 'm1', title: 'Week', prompt: 'Plan', when: { kind: 'weekly', time: '18:30', timeZone: 'UTC', weekdays: [5, 1, 1, 9] } })
  assert.equal(weekly.ok, true)
  assert.deepEqual([...schedule.tasks.values()].at(-1).record.timing, { time: '18:30:00', time_zone: 'UTC', weekdays: [1, 5] })
  const every = await call('schedule-create', { target: 'm1', title: 'Ping', prompt: 'Check', when: { kind: 'every', minutes: 30 } })
  assert.equal([...schedule.tasks.values()].at(-1).record.timing, 1800, JSON.stringify(every))

  for (const [when, message] of [
    [{ kind: 'at', at: '2000-01-01T00:00:00Z' }, /future/],
    [{ kind: 'weekly', time: '09:00', weekdays: [] }, /at least one day/],
    [{ kind: 'daily', time: '9am' }, /time of day/],
    [{ kind: 'every', minutes: 0 }, /1 minute to 7 days/],
  ]) {
    const refused = await call('schedule-create', { target: 'm1', title: 'x', prompt: 'y', when })
    assert.match(refused.error.message, message)
  }
  assert.match((await call('schedule-create', { target: 'm1', title: '', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /name/)

  const removed = await call('schedule-delete', { sessionId: 'w2', id: created.record.id })
  assert.deepEqual(removed.value.tasks.map(task => task.title), ['Old part', 'Week', 'Ping'])
  assert.match((await call('schedule-delete', { sessionId: 'outside', id: 'schedule-3' })).error.message, /No such task/)
})

test('a group chat task lives on the group Session and lists under the group', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const made = await call('schedule-create', { target: 'g1', title: 'Standup', prompt: 'Where are we?', when: { kind: 'daily', time: '10:00', timeZone: 'UTC' } })
  assert.equal(made.ok, true, JSON.stringify(made))
  assert.equal([...schedule.tasks.values()][0].sessionId, 'g1')
  assert.deepEqual(made.value.tasks.map(task => [task.title, task.roomId, task.botId]), [['Standup', 'g1', undefined]])
  assert.match((await call('schedule-create', { target: 'nobody', title: 'x', prompt: 'y', when: { kind: 'every', minutes: 5 } })).error.message, /No such Bot or group chat/)
})

test('one-shot delays, cron edits and delivery history are available', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, call } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const delayed = await call('schedule-create', {
    target: 'w1',
    title: 'Delayed check',
    prompt: 'Check once',
    when: { kind: 'after', seconds: 600 },
  })
  assert.equal(delayed.ok, true, JSON.stringify(delayed))
  assert.equal([...schedule.tasks.values()].at(-1).record.timing, 600)

  const cron = await call('schedule-create', {
    target: 'm1',
    title: 'Weekday deploy',
    prompt: 'Check deploy',
    when: { kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'Asia/Shanghai' },
  })
  assert.equal(cron.ok, true, JSON.stringify(cron))
  const created = [...schedule.tasks.values()].at(-1)
  assert.deepEqual(created.record.timing, { expression: '*/15 9-17 * * 1-5', time_zone: 'Asia/Shanghai' })

  const listed = (await call('schedules', {})).value.tasks[0]
  const updated = await call('schedule-update', {
    sessionId: listed.sessionId,
    id: listed.id,
    expected: listed,
    title: 'Updated check',
    prompt: 'Run every hour',
    when: { kind: 'every', seconds: 3600 },
  })
  assert.equal(updated.ok, true, JSON.stringify(updated))
  assert.equal(updated.value.tasks[0].title, 'Updated check')
  assert.equal(updated.value.tasks[0].kind, 'every')

  const history = await call('schedule-history', { sessionId: listed.sessionId, id: listed.id, limit: 5 })
  assert.equal(history.ok, true, JSON.stringify(history))
  assert.equal(history.value.records[0].messageId, 'm1')
})

test('moving tasks is idempotent when the target task already exists', async (t) => {
  const schedule = scheduleService()
  const { ctx, home, rt } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const source = await schedule.create('w1', { title: 'Move me', prompt: 'Do it', daily: { time: '09:00:00', time_zone: 'UTC' } })
  await schedule.create('w2', { title: 'Move me', prompt: 'Do it', daily: { time: '09:00:00', time_zone: 'UTC' } })
  await rt.moveSchedules('w1', 'w2')
  assert.equal([...schedule.tasks.values()].filter(task => task.sessionId === 'w1').length, 0)
  assert.equal([...schedule.tasks.values()].filter(task => task.sessionId === 'w2' && task.record.title === 'Move me').length, 1)
  assert.deepEqual(rt.state.scheduleMoves, {})
  assert.equal(source.title, 'Move me')
})

test('Bot schedule tools bind own chat tasks to its current part and group tasks to the group relay', async (t) => {
  const schedule = scheduleService()
  const { ctx, home } = setup({ schedule })
  t.after(async () => { await ctx.dispose(); rmSync(home, { recursive: true, force: true, maxRetries: 5 }) })
  const create = ctx.registeredTools.get('schedule_task_create')
  const own = await create.execute({
    title: 'Own task',
    prompt: 'Check own',
    every_seconds: 3600,
  }, { agent: { id: 'w2', session: { id: 'w2' } } })
  assert.match(own, /Created scheduled task/)
  const group = await create.execute({
    title: 'Group task',
    prompt: 'Check group',
    every_seconds: 3600,
  }, { agent: { id: 'room-writer', session: { id: 'room-writer' } } })
  assert.match(group, /Created scheduled task/)
  assert.deepEqual([...schedule.tasks.values()].map(task => task.sessionId), ['w2', 'g1'])
})

test('a due reminder reaches a group as its prompts', () => {
  const one = ['[SCHEDULE REMINDER]', 'framing', 'schedule_id_json: "s1"', 'occurrence_at: 2030-01-01T00:00:00Z', 'reminder_prompt_json: "Where are we?"'].join('\n')
  assert.equal(reminderText(one), '[Scheduled task] Where are we?')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'framing', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', reminder_prompt: 'One' }, { schedule_id: 'b', reminder_prompt: 'Two' }])}`].join('\n')
  assert.equal(reminderText(batch), '[Scheduled task] One\n[Scheduled task] Two')
  assert.equal(reminderText('plain text'), 'plain text')
})
