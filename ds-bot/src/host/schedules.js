// Scheduled tasks over DSH's durable schedule service. This module adds a team
// catalog, in-place edits, delivery history, Bot tools, and crash-safe movement of a
// task when a Bot conversation continues in a fresh Session.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const MAX_TITLE = 120
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const MAX_PROMPT = 30_000

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })

// What a group sees of a due reminder: DSH frames it for one Session's model
// ("[SCHEDULE REMINDER]" with JSON fields); the group gets each prompt as one line.
export function reminderText(text) {
  const prompts = []
  const one = /^reminder_prompt_json: (.*)$/m.exec(text)
  const batch = /^reminders_json: (.*)$/m.exec(text)
  try {
    if (one) prompts.push(JSON.parse(one[1]))
    if (batch) for (const entry of JSON.parse(batch[1])) prompts.push(entry.reminder_prompt)
  } catch {
    return text
  }
  const lines = prompts.filter(prompt => typeof prompt === 'string' && prompt.trim() !== '')
  return lines.length === 0 ? text : lines.map(prompt => `[Scheduled task] ${prompt}`).join('\n')
}

const recordKeys = ['id', 'kind', 'title', 'prompt', 'scheduledAt', 'afterSeconds', 'everySeconds', 'time', 'timeZone', 'weekdays', 'expression']
export const scheduleRecordOf = (value) => Object.fromEntries(recordKeys
  .filter(key => value?.[key] !== undefined)
  .map(key => [key, Array.isArray(value[key]) ? [...value[key]] : value[key]]))

// The create request that gives a stored record its timing again, for a move.
function requestOf(record) {
  const base = { title: record.title, prompt: record.prompt }
  if (record.kind === 'after' || record.kind === 'at') return { ...base, at: record.scheduledAt }
  if (record.kind === 'every') return { ...base, every_seconds: record.everySeconds }
  if (record.kind === 'daily') return { ...base, daily: { time: record.time, time_zone: record.timeZone } }
  if (record.kind === 'weekly') return { ...base, weekly: { time: record.time, time_zone: record.timeZone, weekdays: record.weekdays } }
  if (record.kind === 'cron') return { ...base, cron: { expression: record.expression, time_zone: record.timeZone } }
  return null
}

export function scheduleSelectorOf(when) {
  const zone = typeof when?.timeZone === 'string' && when.timeZone !== '' ? when.timeZone : 'UTC'
  switch (when?.kind) {
    case 'after': {
      const seconds = Number(when.seconds)
      if (!Number.isSafeInteger(seconds) || seconds <= 0) throw invalid('Delay must be a positive number of seconds')
      return { after_seconds: seconds }
    }
    case 'at': {
      const at = new Date(String(when.at ?? ''))
      if (Number.isNaN(at.getTime())) throw invalid('Pick a date and time')
      if (at.getTime() <= Date.now()) throw invalid('Pick a time in the future')
      return { at: at.toISOString() }
    }
    case 'daily':
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      return { daily: { time: `${when.time}:00`, time_zone: zone } }
    case 'weekly': {
      if (!TIME.test(String(when.time))) throw invalid('Pick a time of day')
      const weekdays = [...new Set((Array.isArray(when.weekdays) ? when.weekdays : []).map(Number))]
        .filter(day => Number.isInteger(day) && day >= 1 && day <= 7).sort()
      if (weekdays.length === 0) throw invalid('Pick at least one day')
      return { weekly: { time: `${when.time}:00`, time_zone: zone, weekdays } }
    }
    case 'every': {
      const seconds = Number(when.seconds ?? (when.minutes === undefined ? NaN : Number(when.minutes) * 60))
      if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 7 * 24 * 60 * 60) {
        throw invalid('Repeat every 1 minute to 7 days')
      }
      return { every_seconds: seconds }
    }
    case 'cron': {
      const expression = String(when.expression ?? '').trim()
      if (expression === '') throw invalid('Enter a five-field cron expression')
      return { cron: { expression, time_zone: zone } }
    }
    default:
      throw invalid('Pick when it runs')
  }
}

export function scheduleTimingChangeOf(when) {
  const selector = scheduleSelectorOf(when)
  if (selector.at !== undefined) return { kind: 'at', at: selector.at }
  if (selector.every_seconds !== undefined) return { kind: 'every', every_seconds: selector.every_seconds }
  if (selector.daily !== undefined) return { kind: 'daily', daily: selector.daily }
  if (selector.weekly !== undefined) return { kind: 'weekly', weekly: selector.weekly }
  if (selector.cron !== undefined) return { kind: 'cron', cron: selector.cron }
  throw invalid('A saved task needs a new timing')
}

const ruleIdentity = value => ({
  title: String(value.title ?? '').trim(),
  prompt: String(value.prompt ?? '').trim(),
  ...(value.kind === 'after' || value.kind === 'at'
    ? { kind: 'once', scheduledAt: value.scheduledAt ?? value.at }
    : value.kind === 'every' || value.every_seconds !== undefined
      ? { kind: 'every', everySeconds: value.everySeconds ?? value.every_seconds }
      : value.kind === 'daily' || value.daily !== undefined
        ? { kind: 'daily', time: value.time ?? value.daily?.time, timeZone: value.timeZone ?? value.daily?.time_zone }
        : value.kind === 'weekly' || value.weekly !== undefined
          ? {
              kind: 'weekly',
              time: value.time ?? value.weekly?.time,
              timeZone: value.timeZone ?? value.weekly?.time_zone,
              weekdays: value.weekdays ?? value.weekly?.weekdays,
            }
          : { kind: 'cron', expression: value.expression ?? value.cron?.expression, timeZone: value.timeZone ?? value.cron?.time_zone }),
})
const fingerprint = value => JSON.stringify(ruleIdentity(value))

const timingText = (record) => {
  if (record.kind === 'after' || record.kind === 'at') return `once at ${record.scheduledAt}`
  if (record.kind === 'every') return `every ${record.everySeconds}s`
  if (record.kind === 'daily') return `daily ${record.time} ${record.timeZone}`
  if (record.kind === 'weekly') return `weekly ${record.weekdays?.join(',')} ${record.time} ${record.timeZone}`
  if (record.kind === 'cron') return `cron ${record.expression} ${record.timeZone}`
  return record.kind
}

export function install(rt) {
  const { ctx, state } = rt
  let service = null
  let moveChain = Promise.resolve()
  let recovering = null

  const attach = (sub) => {
    const own = sub.schedule
    service = own
    sub.effect(() => () => { if (service === own) service = null }, 'ds-bot: schedule service')
  }
  if (typeof ctx.inject === 'function') ctx.inject(['schedule'], attach)
  else if (ctx.get?.('schedule') !== undefined) attach({ schedule: ctx.get('schedule'), effect: (execute, label) => ctx.effect(execute, label) })

  const ownerOf = (sessionId) => {
    const chat = rt.chatOwners.get(sessionId)
    if (chat !== undefined) return { botId: chat }
    if (rt.roomOf(sessionId) !== undefined) return { roomId: sessionId }
    return rt.groupOwners.get(sessionId) ?? rt.pastOwners.get(sessionId)
  }
  const known = owner => owner !== undefined && (owner.botId === undefined
    ? state.rooms[owner.roomId] !== undefined
    : state.bots[owner.botId] !== undefined)
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const requireService = () => {
    if (service === null) throw invalid('Automation tasks are off in DSH')
    return service
  }
  const scheduleMoves = () => {
    state.scheduleMoves ??= {}
    return state.scheduleMoves
  }

  async function catalogFor(sessionId) {
    return (await requireService().catalog()).filter(task => task.sessionId === sessionId)
  }

  async function targetHas(sessionId, expected) {
    const wanted = fingerprint(expected)
    return (await catalogFor(sessionId)).find(task => fingerprint(task) === wanted)
  }

  async function recoverOne(move) {
    const target = await targetHas(move.toId, move.request)
    const sourceCatalog = await catalogFor(move.fromId)
    const source = sourceCatalog.find(task => task.id === move.recordId)
    if (target !== undefined) {
      if (source !== undefined) await requireService().delete({ sessionId: move.fromId, id: source.id })
      return
    }
    // A one-shot that already delivered from the old part must not be armed again.
    if (source !== undefined && source.status !== 'active') return
    if (source !== undefined) await requireService().create(move.toId, move.request)
    if (source !== undefined) await requireService().delete({ sessionId: move.fromId, id: source.id })
  }

  async function recoverMoves() {
    if (service === null || rt.readOnly() !== undefined) return
    const moves = scheduleMoves()
    let changed = false
    for (const move of Object.values(moves)) {
      try {
        await recoverOne(move)
        delete moves[move.recordId]
        changed = true
      } catch (error) {
        rt.warn('ds-bot: scheduled task %s could not finish moving: %s', move.title ?? move.recordId, error?.message ?? error)
      }
    }
    if (changed) await rt.save()
  }
  const recover = () => {
    recovering ??= rt.load().then(recoverMoves).finally(() => { recovering = null })
    return recovering
  }

  async function schedulesView() {
    if (service === null) return { available: false, tasks: [] }
    const tasks = []
    for (const entry of await service.catalog()) {
      const owner = ownerOf(entry.sessionId)
      if (!known(owner)) continue
      tasks.push({ ...entry, ...owner })
    }
    return { available: true, tasks }
  }

  const endpoints = {
    schedules: async () => {
      if (service !== null) await recover()
      return schedulesView()
    },
    async 'schedule-create'(body) {
      writeCheck()
      const scheduler = requireService()
      await recover()
      const bot = state.bots[body.target]
      const room = state.rooms[body.target]
      if (bot === undefined && room === undefined) throw invalid('No such Bot or group chat')
      const title = String(body.title ?? '').trim()
      const prompt = String(body.prompt ?? '').trim()
      if (title === '') throw invalid('Give the task a name')
      if (title.length > MAX_TITLE) throw invalid(`Keep the name under ${MAX_TITLE} characters`)
      if (prompt === '') throw invalid('Say what the Bot should do')
      if (prompt.length > MAX_PROMPT) throw invalid(`Keep the instructions under ${MAX_PROMPT} characters`)
      await scheduler.create(bot ? rt.chatOf(bot.id) : room.id, { title, prompt, ...scheduleSelectorOf(body.when) })
      return schedulesView()
    },
    async 'schedule-update'(body) {
      writeCheck()
      const scheduler = requireService()
      await recover()
      const expected = scheduleRecordOf(body.expected)
      if (expected.id === undefined || expected.kind === undefined) throw invalid('No such task')
      const result = await scheduler.update({
        sessionId: body.sessionId,
        id: expected.id,
        expected,
        ...(body.title === undefined ? {} : { title: String(body.title).trim() }),
        ...(body.prompt === undefined ? {} : { prompt: String(body.prompt).trim() }),
        ...(body.when === undefined ? {} : { change: scheduleTimingChangeOf(body.when) }),
      })
      if (result.record === undefined) throw invalid(result.code === 'schedule_conflict'
        ? 'This task changed since the form opened; reload and try again'
        : result.code === 'schedule_ended' ? 'This task has already finished' : 'No such task')
      return schedulesView()
    },
    async 'schedule-delete'(body) {
      writeCheck()
      const scheduler = requireService()
      await recover()
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      await scheduler.delete({ sessionId: body.sessionId, id: body.id })
      return schedulesView()
    },
    async 'schedule-history'(body) {
      const scheduler = requireService()
      if (ownerOf(body.sessionId) === undefined) throw invalid('No such task')
      return scheduler.history({
        sessionId: body.sessionId,
        id: body.id,
        limit: Math.max(1, Math.min(100, Number(body.limit ?? 20))),
        ...(body.before === undefined ? {} : { before: body.before }),
      })
    },
  }

  // A fresh part takes over the earlier part's active tasks. The pending move is
  // written before the target task exists, so a crash between create and delete can
  // be recovered without arming a second copy.
  async function moveSchedules(fromId, toId) {
    if (service === null || fromId === toId) return
    const work = moveChain.then(async () => {
      await rt.load()
      if (rt.readOnly() !== undefined) return
      await recover()
      const scheduler = requireService()
      let records
      try {
        records = await scheduler.list({ sessionId: fromId })
      } catch (error) {
        rt.warn('ds-bot: tasks of %s not moved: %s', fromId, error?.message ?? error)
        return
      }
      for (const record of records) {
        const request = requestOf(record)
        if (request === null || (request.at !== undefined && Date.parse(request.at) <= Date.now())) continue
        const moves = scheduleMoves()
        moves[record.id] = {
          recordId: record.id,
          fromId,
          toId,
          title: record.title,
          request,
          createdAt: Date.now(),
        }
        try {
          await rt.save()
          if (await targetHas(toId, request) === undefined) await scheduler.create(toId, request)
          await scheduler.delete({ sessionId: fromId, id: record.id })
          delete moves[record.id]
          await rt.save()
        } catch (error) {
          rt.warn('ds-bot: task %s stayed with the earlier part pending recovery: %s', record.title, error?.message ?? error)
        }
      }
    }).catch(error => rt.warn('ds-bot: scheduled task move failed: %s', error))
    moveChain = work
    return work
  }

  const callerTarget = (exec) => {
    const sessionId = exec.agent?.session?.id ?? exec.agent?.id
    const group = rt.groupOwners.get(sessionId)
    if (group !== undefined) return { sessionId: group.roomId, owner: { roomId: group.roomId }, botId: group.botId }
    const botId = rt.chatOwners.get(sessionId)
    if (botId !== undefined) return { sessionId: rt.chatOf(botId), owner: { botId }, botId }
    return undefined
  }
  const timingArgs = args => {
    const selectors = ['after_seconds', 'at', 'every_seconds', 'daily', 'weekly', 'cron'].filter(key => args[key] !== undefined)
    if (selectors.length !== 1) throw new Error('Supply exactly one timing selector.')
    return Object.fromEntries(selectors.map(key => [key, args[key]]))
  }

  ctx.tools.register(defineTool({
    name: 'schedule_task_create',
    description: 'Create a durable scheduled task for this Bot chat or the group chat this turn belongs to. Supply exactly one timing selector.',
    parameters: {
      title: { type: 'string', required: true, description: 'Short task name, at most 120 characters' },
      prompt: { type: 'string', required: true, description: 'What the Bot or group should do when it runs' },
      after_seconds: { type: 'integer', description: 'One-shot delay in seconds' },
      at: { type: 'string', description: 'Future ISO date and time' },
      every_seconds: { type: 'integer', description: 'Fixed interval, at least 60 seconds' },
      daily: { type: 'object', additionalProperties: false, properties: { time: { type: 'string', required: true }, time_zone: { type: 'string', required: true } } },
      weekly: { type: 'object', additionalProperties: false, properties: { time: { type: 'string', required: true }, time_zone: { type: 'string', required: true }, weekdays: { type: 'array', items: { type: 'integer' }, required: true } } },
      cron: { type: 'object', additionalProperties: false, properties: { expression: { type: 'string', required: true }, time_zone: { type: 'string', required: true } } },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const target = callerTarget(exec)
      if (target === undefined) return 'schedule_task_create is available only in a Bot or group chat.'
      const scheduler = requireService()
      try {
        const record = await scheduler.create(target.sessionId, {
          title: args.title,
          prompt: args.prompt,
          ...timingArgs(args),
        }, exec.signal)
        return `Created scheduled task ${record.id}: ${record.title} (${timingText(record)}).`
      } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'schedule_task_update',
    description: 'Edit one active scheduled task in this Bot chat or group chat. Omitted fields keep their value.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id from automation_list' },
      title: { type: 'string', description: 'New short task name' },
      prompt: { type: 'string', description: 'New instructions' },
      at: { type: 'string', description: 'New future ISO date and time' },
      every_seconds: { type: 'integer', description: 'New fixed interval' },
      daily: { type: 'object', additionalProperties: false, properties: { time: { type: 'string', required: true }, time_zone: { type: 'string', required: true } } },
      weekly: { type: 'object', additionalProperties: false, properties: { time: { type: 'string', required: true }, time_zone: { type: 'string', required: true }, weekdays: { type: 'array', items: { type: 'integer' }, required: true } } },
      cron: { type: 'object', additionalProperties: false, properties: { expression: { type: 'string', required: true }, time_zone: { type: 'string', required: true } } },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const target = callerTarget(exec)
      if (target === undefined) return 'schedule_task_update is available only in a Bot or group chat.'
      const scheduler = requireService()
      try {
        const expected = (await scheduler.list({ sessionId: target.sessionId })).find(record => record.id === args.id)
        if (expected === undefined) return `No active scheduled task ${args.id}.`
        const selectors = ['at', 'every_seconds', 'daily', 'weekly', 'cron'].filter(key => args[key] !== undefined)
        if (selectors.length > 1) return 'Supply at most one new timing selector.'
        const change = selectors.length === 0 ? undefined : selectors[0] === 'at'
          ? { kind: 'at', at: args.at }
          : selectors[0] === 'every_seconds'
            ? { kind: 'every', every_seconds: args.every_seconds }
            : { kind: selectors[0], [selectors[0]]: args[selectors[0]] }
        const result = await scheduler.update({
          sessionId: target.sessionId,
          id: args.id,
          expected,
          ...(args.title === undefined ? {} : { title: args.title }),
          ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
          ...(change === undefined ? {} : { change }),
        }, exec.signal)
        if (result.record === undefined) return `Task was not updated: ${result.code}.`
        return `Updated scheduled task ${result.record.id}: ${result.record.title} (${timingText(result.record)}).`
      } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'schedule_task_delete',
    description: 'Delete a scheduled task from this Bot chat or group chat.',
    parameters: { id: { type: 'string', required: true, description: 'Task id from automation_list' } },
    output,
    async execute(args, exec) {
      await rt.load()
      const target = callerTarget(exec)
      if (target === undefined) return 'schedule_task_delete is available only in a Bot or group chat.'
      try {
        const result = await requireService().delete({ sessionId: target.sessionId, id: args.id }, exec.signal)
        return result.deleted ? `Deleted scheduled task ${args.id}.` : `No scheduled task ${args.id}.`
      } catch (error) { return error.message }
    },
  }))
  ctx.tools.register(defineTool({
    name: 'schedule_task_history',
    description: 'Read saved delivery receipts for one scheduled task. A receipt means the message entered the Session inbox, not that the model finished the work.',
    parameters: {
      id: { type: 'string', required: true, description: 'Task id from automation_list' },
      limit: { type: 'integer', description: 'Number of deliveries, 1 to 100; defaults to 20' },
      before: { type: 'string', description: 'Message cursor from the previous page' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const target = callerTarget(exec)
      if (target === undefined) return 'schedule_task_history is available only in a Bot or group chat.'
      try {
        const history = await requireService().history({
          sessionId: target.sessionId,
          id: args.id,
          limit: Number(args.limit ?? 20),
          ...(args.before === undefined ? {} : { before: args.before }),
        })
        if (history.records === undefined) return `Delivery history is unavailable: ${history.code}.`
        const retention = `Retention: ${history.retention.records} records / ${history.retention.days} days.`
        if (history.records.length === 0) return `No saved deliveries.\n${retention}`
        return [
          retention,
          ...history.records.map(record => `${record.deliveredAt} · ${record.scheduledAt}${record.prompt ? ` · ${record.prompt.slice(0, 160)}` : ''}`),
        ].join('\n')
      } catch (error) { return error.message }
    },
  }))

  ctx.effect(() => {
    const timer = setTimeout(() => { void recover() }, 1_000)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'ds-bot: recover scheduled task moves')

  Object.assign(rt, {
    scheduleEndpoint: (endpoint, body) => endpoints[endpoint](body ?? {}),
    moveSchedules,
    scheduleCatalog: async () => schedulesView(),
    scheduleRecordOf,
    callerScheduleTarget: callerTarget,
  })
}
