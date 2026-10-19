// Event automations turn a small, explicit set of team events into one Bot or group
// prompt. They do not execute tools directly: the resulting turn keeps the target
// Bot's normal permissions, sandbox and approval boundary.
import { randomUUID } from 'node:crypto'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { reminderText } from './schedules.js'
import { textOf } from './text.js'
import { output } from './tools.js'

const TRIGGERS = new Set([
  'turn_completed',
  'turn_failed',
  'turn_aborted',
  'approval_requested',
  'schedule_delivered',
  'background_job',
  'user_message',
])
const TOKENS = new Set(['rule', 'event', 'status', 'bot', 'room', 'text', 'time', 'id'])
const MAX_RULES = 100
const MAX_RUNS = 300
const MAX_RECENT_KEYS = 100
const MAX_RULES_PER_EVENT = 5
const MAX_NAME = 80
const MAX_PROMPT = 20_000
const MAX_TEXT = 4_000
const MAX_COOLDOWN = 7 * 24 * 60 * 60

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const trimmed = (value, label, max, required = false) => {
  const text = String(value ?? '').trim()
  if (required && text === '') throw invalid(`${label} is required`)
  if (text.length > max) throw invalid(`${label} is longer than ${max} characters`)
  return text
}
const cooldown = value => {
  const seconds = Number(value ?? 60)
  if (!Number.isSafeInteger(seconds) || seconds < 0 || seconds > MAX_COOLDOWN) {
    throw invalid('Cooldown must be 0 seconds to 7 days')
  }
  return seconds
}
const templateTokens = (template) => {
  for (const match of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = match[1].trim()
    if (!TOKENS.has(name)) throw invalid(`Unknown automation token "{{${name}}}"`)
  }
  const rest = template.replace(/\{\{[^{}]*\}\}/g, '')
  if (rest.includes('{{') || rest.includes('}}')) throw invalid('Automation prompt has an unclosed token')
  return template
}
const render = (template, values) => String(template).replace(/\{\{\s*([a-z]+)\s*\}\}/g, (_match, name) => String(values[name] ?? ''))
const clip = value => String(value ?? '').replace(/\r\n/g, '\n').slice(0, MAX_TEXT)

export function install(rt) {
  const { ctx, state } = rt
  const tracked = new Map()
  const lastAssistant = new Map()
  let chain = Promise.resolve()
  let stopped = false

  const library = () => state.automations.items
  const ensureLibrary = () => {
    state.automations ??= { items: {}, runs: [] }
    state.automations.items ??= {}
    state.automations.runs ??= []
    return library()
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const sameName = (name, exceptId) => Object.values(library())
    .some(item => item.id !== exceptId && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())
  const botNamed = ref => typeof ref === 'string' && ref.trim() !== '' ? rt.findBot(ref) : undefined
  const roomNamed = ref => {
    if (typeof ref !== 'string' || ref.trim() === '') return undefined
    const matches = rt.findRooms(ref)
    if (matches.length > 1) throw invalid(`More than one group chat is named ${ref}`)
    return matches[0]
  }
  const resolveTarget = (kind, ref) => {
    if (kind === 'bot') {
      const bot = botNamed(ref)
      if (bot === undefined) throw invalid(`No Bot named ${ref}`)
      return { kind: 'bot', id: bot.id }
    }
    if (kind === 'room') {
      const room = roomNamed(ref)
      if (room === undefined) throw invalid(`No group chat named ${ref}`)
      return { kind: 'room', id: room.id }
    }
    throw invalid('Choose a Bot or group chat target')
  }
  const targetExists = target => target?.kind === 'bot' ? state.bots[target.id] !== undefined
    : target?.kind === 'room' ? state.rooms[target.id] !== undefined : false
  const viewRule = rule => {
    const { recentEventKeys, ...rest } = rule
    return {
      ...rest,
      targetName: targetLabel(rule.target),
      sourceBotName: rule.trigger.sourceBotId ? state.bots[rule.trigger.sourceBotId]?.name ?? 'Missing Bot' : undefined,
    }
  }
  const viewRuns = () => [...state.automations.runs].slice(-100).reverse().map(run => ({ ...run }))
  const automationView = () => ({
    available: true,
    rules: Object.values(library()).map(viewRule).sort((a, b) => a.name.localeCompare(b.name)),
    runs: viewRuns(),
  })
  function targetLabel(target) {
    return target?.kind === 'bot' ? state.bots[target.id]?.name
      : target?.kind === 'room' ? state.rooms[target.id]?.name
        : undefined
  }

  const itemInput = (body, { botId, ui }) => {
    const id = body.id ?? body.originalId
    const previous = id ? library()[id] : undefined
    if (id && previous === undefined) throw invalid('No such automation')
    if (!ui && !rt.isMain(botId)) throw new Error('Only a Main Bot can change event automations')
    const name = trimmed(body.name, 'Automation name', MAX_NAME, true)
    if (sameName(name, id)) throw invalid(`An automation is already named ${name}`)
    const triggerKind = String(body.triggerKind ?? '')
    if (!TRIGGERS.has(triggerKind)) throw invalid('Choose an event trigger')
    const source = typeof body.sourceBot === 'string' && body.sourceBot.trim() !== '' ? botNamed(body.sourceBot.trim()) : undefined
    if (body.sourceBot && source === undefined) throw invalid(`No Bot named ${body.sourceBot}`)
    const target = resolveTarget(body.targetKind, body.target)
    const prompt = trimmed(body.prompt, 'Automation prompt', MAX_PROMPT, true)
    templateTokens(prompt)
    const now = Date.now()
    return {
      id: previous?.id ?? randomUUID(),
      name,
      trigger: {
        kind: triggerKind,
        ...(source === undefined ? {} : { sourceBotId: source.id }),
        ...(body.contains === undefined || String(body.contains).trim() === '' ? {} : { contains: trimmed(body.contains, 'Text filter', 200) }),
      },
      target,
      prompt,
      cooldownSeconds: cooldown(body.cooldownSeconds),
      enabled: body.enabled !== false,
      createdBy: previous?.createdBy ?? (ui ? null : botId),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      revision: previous === undefined ? 1 : (previous.revision ?? 1) + 1,
      runCount: previous?.runCount ?? 0,
      recentEventKeys: [...(previous?.recentEventKeys ?? [])],
      ...(previous?.lastRunAt === undefined ? {} : { lastRunAt: previous.lastRunAt }),
      ...(previous?.lastStatus === undefined ? {} : { lastStatus: previous.lastStatus }),
      ...(previous?.lastError === undefined ? {} : { lastError: previous.lastError }),
    }
  }
  const automationSave = async (body, options = {}) => {
    await rt.load()
    writeCheck()
    const items = ensureLibrary()
    if (Object.keys(items).length >= MAX_RULES && !body.id && !body.originalId) throw invalid(`A team can have at most ${MAX_RULES} event automations`)
    const item = itemInput(body ?? {}, options)
    items[item.id] = item
    await rt.save()
    return viewRule(item)
  }
  const automationDelete = async (id, { botId, ui } = {}) => {
    await rt.load()
    writeCheck()
    const item = ensureLibrary()[String(id ?? '')]
    if (!item) throw invalid('No such automation')
    if (!ui && !rt.isMain(botId)) throw new Error('Only a Main Bot can change event automations')
    delete library()[item.id]
    state.automations.runs = state.automations.runs.filter(run => run.ruleId !== item.id)
    await rt.save()
    return true
  }
  async function automationEndpoint(endpoint, body = {}) {
    if (endpoint === 'automation-save') return automationSave(body, { ui: true })
    if (endpoint === 'automation-delete') return automationDelete(body.id, { ui: true })
    if (endpoint === 'automation-toggle') {
      await rt.load()
      writeCheck()
      const item = ensureLibrary()[String(body.id ?? '')]
      if (!item) throw invalid('No such automation')
      item.enabled = body.enabled !== false
      item.updatedAt = Date.now()
      item.revision = (item.revision ?? 1) + 1
      await rt.save()
      return viewRule(item)
    }
    throw invalid('Unknown automation operation')
  }

  const valuesFor = event => ({
    rule: event.ruleName,
    event: event.kind,
    status: event.status ?? '',
    bot: event.sourceBotName ?? '',
    room: event.roomName ?? '',
    text: clip(event.text),
    time: new Date().toISOString(),
    id: event.ruleId,
  })

  async function deliver(event) {
    const target = event.target
    const sessionId = target.kind === 'bot' ? rt.chatOf(target.id) : target.id
    if (target.kind === 'bot') await rt.ensureCapabilities(sessionId)
    const agent = await rt.resolveAgent(sessionId)
    const text = [
      `[Automation · ${event.ruleName}]`,
      `Event: ${event.kind}${event.status ? ` (${event.status})` : ''}`,
      '',
      render(event.prompt, valuesFor(event)),
    ].join('\n')
    agent.followup(createUserMessage({
      content: [{ type: 'text', text }],
      source: {
        kind: 'automation',
        form: 'trigger',
        ruleId: event.ruleId,
        ruleName: event.ruleName,
        eventKind: event.kind,
        eventKey: event.eventKey,
        automationDepth: event.depth + 1,
      },
    }))
    await ctx.sessions.flush(agent.session)
  }

  async function runEvent(input) {
    if (stopped || rt.readOnly() !== undefined) return
    await rt.load()
    const rules = Object.values(ensureLibrary())
      .filter(rule => rule.enabled && rule.trigger.kind === input.kind)
      .sort((a, b) => a.createdAt - b.createdAt)
    let accepted = 0
    for (const rule of rules) {
      if (accepted >= MAX_RULES_PER_EVENT) break
      if (!targetExists(rule.target)) continue
      if (rule.trigger.sourceBotId !== undefined && rule.trigger.sourceBotId !== input.sourceBotId) continue
      if (rule.trigger.contains !== undefined && !String(input.text ?? '').toLowerCase().includes(rule.trigger.contains.toLowerCase())) continue
      if (rule.recentEventKeys?.includes(input.eventKey)) continue
      if (rule.lastRunAt !== undefined && Date.now() - rule.lastRunAt < rule.cooldownSeconds * 1_000) continue
      const sameTarget = rule.target.kind === 'bot'
        ? rule.target.id === input.sourceBotId
        : state.rooms[rule.target.id]?.members.includes(input.sourceBotId) === true
      if ((input.depth ?? 0) > 0 && sameTarget) continue
      if ((input.depth ?? 0) >= 3) continue
      accepted += 1
      const run = {
        id: randomUUID(),
        ruleId: rule.id,
        ruleName: rule.name,
        eventKind: input.kind,
        eventKey: input.eventKey,
        target: targetLabel(rule.target),
        startedAt: Date.now(),
        status: 'running',
        depth: input.depth ?? 0,
      }
      rule.recentEventKeys = [...(rule.recentEventKeys ?? []), input.eventKey].slice(-MAX_RECENT_KEYS)
      rule.runCount = (rule.runCount ?? 0) + 1
      rule.lastRunAt = run.startedAt
      rule.lastStatus = 'running'
      delete rule.lastError
      state.automations.runs.push(run)
      state.automations.runs = state.automations.runs.slice(-MAX_RUNS)
      try {
        await rt.save()
        await deliver({
          ...input,
          ...rule,
          ruleId: rule.id,
          ruleName: rule.name,
          target: rule.target,
          depth: input.depth ?? 0,
          sourceBotName: input.sourceBotId ? state.bots[input.sourceBotId]?.name : input.sourceBotName,
          roomName: input.roomId ? state.rooms[input.roomId]?.name : input.roomName,
        })
        run.status = 'delivered'
        run.finishedAt = Date.now()
        rule.lastStatus = 'delivered'
      } catch (error) {
        run.status = 'failed'
        run.finishedAt = Date.now()
        run.error = rt.redactSecrets?.(String(error?.message ?? error)) ?? String(error?.message ?? error)
        rule.lastStatus = 'failed'
        rule.lastError = run.error.slice(0, 500)
      }
      try { await rt.save() } catch (error) { rt.warn('ds-bot: automation result save failed: %s', error) }
    }
  }

  const enqueue = input => {
    const work = chain.then(() => runEvent(input)).catch(error => rt.warn('ds-bot: automation %s failed: %s', input.kind, error))
    chain = work
    return work
  }

  rt.automationEvent = input => enqueue({
    kind: input.kind,
    sessionId: input.sessionId,
    sourceBotId: input.sourceBotId,
    roomId: input.roomId,
    sourceBotName: input.sourceBotId ? state.bots[input.sourceBotId]?.name : undefined,
    roomName: input.roomId ? state.rooms[input.roomId]?.name : undefined,
    text: clip(input.text),
    status: input.status,
    eventKey: input.eventKey,
    depth: input.depth ?? 0,
  })

  ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (typeof sessionId !== 'string') return
    if (event.type === 'assistant/message') {
      const text = textOf(event.data?.message?.content)
      if (text !== '') lastAssistant.set(sessionId, text)
      return
    }
    if (event.type === 'user/message') {
      const source = event.data?.source
      const text = textOf(event.data?.content)
      tracked.set(sessionId, { source, depth: Number(source?.automationDepth ?? 0) })
      const base = {
        sessionId,
        sourceBotId: rt.selfOf(sessionId) ?? (rt.roomOf(sessionId) === undefined ? undefined : rt.groupOwners.get(sessionId)?.botId),
        roomId: rt.groupOwners.get(sessionId)?.roomId,
        text,
        eventKey: `${sessionId}:${event.seq ?? `${event.type}:${Date.now()}`}:${source?.kind ?? 'unknown'}`,
        depth: Number(source?.automationDepth ?? 0),
      }
      if (source?.kind === 'user') enqueue({ ...base, kind: 'user_message', status: 'received' })
      else if (source?.kind === 'schedule') enqueue({ ...base, kind: 'schedule_delivered', text: reminderText(text), status: 'delivered' })
      else if (source?.kind === 'tool-jobs') enqueue({ ...base, kind: 'background_job', status: source.form ?? 'finished' })
      return
    }
    if (event.type !== 'turn/end') return
    const reason = event.data?.reason
    const kind = reason?.kind === 'error' ? 'turn_failed'
      : reason?.kind === 'aborted' ? 'turn_aborted'
        : reason?.kind === 'completed' ? 'turn_completed' : undefined
    if (kind === undefined) return
    const trackedInput = tracked.get(sessionId)
    const failure = reason?.kind === 'error'
      ? [reason.error?.code, reason.error?.message].filter(Boolean).join(': ')
      : lastAssistant.get(sessionId)
    enqueue({
      kind,
      sessionId,
      sourceBotId: rt.selfOf(sessionId) ?? trackedInput?.source?.senderSessionId,
      roomId: rt.groupOwners.get(sessionId)?.roomId,
      text: clip(failure ?? ''),
      status: reason?.kind,
      eventKey: `${sessionId}:${event.seq ?? `${event.data?.turn}:turn_end`}`,
      depth: trackedInput?.depth ?? 0,
    })
    lastAssistant.delete(sessionId)
  })

  const visibleRule = (rule, botId) => rt.isMain(botId)
    || rule.trigger.sourceBotId === botId
    || (rule.target.kind === 'bot' && rule.target.id === botId)
    || (rule.target.kind === 'room' && state.rooms[rule.target.id]?.members.includes(botId))
  const callerBot = exec => rt.botOf(rt.selfOf(exec.agent?.id))
  ctx.tools.register(defineTool({
    name: 'automation_list',
    description: 'List scheduled tasks and event automations visible to this Bot. Read-only.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      if (!bot) return 'Only Bots on the team can use automation_list.'
      const lines = ['Scheduled tasks:']
      const schedules = await rt.scheduleCatalog()
      const tasks = (schedules.tasks ?? []).filter(task => rt.isMain(bot.id)
        || task.botId === bot.id
        || (task.roomId && state.rooms[task.roomId]?.members.includes(bot.id)))
      if (schedules.available === false) lines.push('- The DSH schedule service is off.')
      else if (tasks.length === 0) lines.push('- None.')
      else lines.push(...tasks.map(task => `- ${task.id} · ${task.title} · ${task.kind} · ${task.status}${task.lastDelivery ? ` · last ${task.lastDelivery.deliveredAt}` : ''}`))
      lines.push('', 'Event automations:')
      const rules = Object.values(ensureLibrary()).filter(rule => visibleRule(rule, bot.id))
      if (rules.length === 0) lines.push('- None.')
      else lines.push(...rules.map(rule => `- ${rule.id} · ${rule.name} · ${rule.trigger.kind} → ${targetLabel(rule.target)} · ${rule.enabled ? 'enabled' : 'disabled'} · ${rule.lastStatus ?? 'never run'}`))
      return lines.join('\n')
    },
  }))
  const ruleTool = (name, { create }) => defineTool({
    name,
    description: `${create ? 'Create' : 'Update'} an event automation. Only a Main Bot can change rules. A rule sends a prompt to one Bot or group; it does not grant permissions.`,
    parameters: {
      ...(create ? {} : { id: { type: 'string', required: true, description: 'Rule id from automation_list' } }),
      name: { type: 'string', ...(create ? { required: true } : {}), description: 'Rule name' },
      triggerKind: { type: 'string', ...(create ? { required: true } : {}), enum: [...TRIGGERS], description: 'Event to watch' },
      sourceBot: { type: 'string', description: 'Optional Bot name whose events should trigger this rule' },
      targetKind: { type: 'string', ...(create ? { required: true } : {}), enum: ['bot', 'room'], description: 'Target kind' },
      target: { type: 'string', ...(create ? { required: true } : {}), description: 'Exact Bot or group chat name' },
      prompt: { type: 'string', ...(create ? { required: true } : {}), description: 'Prompt template for the target' },
      contains: { type: 'string', description: 'Only run when event text contains this text' },
      cooldownSeconds: { type: 'integer', description: 'Minimum seconds between runs; defaults to 60' },
      enabled: { type: 'boolean', description: 'Whether the rule is enabled' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      if (!bot) return `Only Bots on the team can use ${name}.`
      if (!rt.isMain(bot.id)) return `Only a Main Bot can use ${name}.`
      try {
        const previous = create ? undefined : ensureLibrary()[args.id]
        if (!create && previous === undefined) return `No automation ${args.id}.`
        const saved = await automationSave({
          ...args,
          ...(previous === undefined ? {} : {
            id: previous.id,
            name: args.name ?? previous.name,
            triggerKind: args.triggerKind ?? previous.trigger.kind,
            sourceBot: args.sourceBot ?? (previous.trigger.sourceBotId ? state.bots[previous.trigger.sourceBotId]?.name : ''),
            targetKind: args.targetKind ?? previous.target.kind,
            target: args.target ?? targetLabel(previous.target),
            prompt: args.prompt ?? previous.prompt,
            contains: args.contains ?? previous.trigger.contains,
            cooldownSeconds: args.cooldownSeconds ?? previous.cooldownSeconds,
            enabled: args.enabled ?? previous.enabled,
          }),
        }, { botId: bot.id })
        return `${create ? 'Created' : 'Updated'} automation ${saved.name} (${saved.id}).`
      } catch (error) { return error.message }
    },
  })
  ctx.tools.register(ruleTool('automation_rule_create', { create: true }))
  ctx.tools.register(ruleTool('automation_rule_update', { create: false }))
  ctx.tools.register(defineTool({
    name: 'automation_rule_delete',
    description: 'Delete an event automation. Only a Main Bot can change rules.',
    parameters: { id: { type: 'string', required: true, description: 'Rule id from automation_list' } },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = callerBot(exec)
      if (!bot) return 'Only Bots on the team can use automation_rule_delete.'
      if (!rt.isMain(bot.id)) return 'Only a Main Bot can use automation_rule_delete.'
      try {
        await automationDelete(args.id, { botId: bot.id })
        return `Deleted automation ${args.id}.`
      } catch (error) { return error.message }
    },
  }))

  ctx.systemPrompt.section({
    name: 'bot-automations',
    order: 646,
    text: context => rt.selfOf(context?.agent?.id) === undefined ? '' : [
      '# Scheduled tasks and automations',
      '- Use schedule_task_create/update/delete/history for durable tasks in this Bot chat or the group chat this turn belongs to. automation_list shows both schedules and event rules.',
      '- Event rules are managed by Main Bots or the user. A rule produces a prompt turn only; it never grants shell, network, sandbox, approval or Git permissions.',
      '- Never create event loops. A rule targeting its own event source is suppressed for cascades, and automation depth is capped.',
    ].join('\n'),
  })

  ctx.effect(() => {
    void rt.load().then(async () => {
      if (rt.readOnly() !== undefined) return
      let changed = false
      for (const run of state.automations.runs) {
        if (run.status !== 'running') continue
        run.status = 'interrupted'
        run.finishedAt = Date.now()
        run.error = 'The Host restarted before the delivery result was saved.'
        changed = true
        const rule = library()[run.ruleId]
        if (rule?.lastStatus === 'running') rule.lastStatus = 'interrupted'
      }
      if (changed) await rt.save()
    }).catch(error => rt.warn('ds-bot: automation recovery failed: %s', error))
    return () => { stopped = true }
  }, 'ds-bot: event automations')

  const cleanupRules = predicate => {
    let changed = false
    for (const rule of Object.values(ensureLibrary())) {
      if (!predicate(rule)) continue
      delete library()[rule.id]
      changed = true
    }
    if (changed) state.automations.runs = state.automations.runs
      .filter(run => library()[run.ruleId] !== undefined)
    return changed
  }

  Object.assign(rt, {
    automationSave,
    automationDelete,
    automationEndpoint,
    automationView,
    cleanupBotAutomations: botId => cleanupRules(rule =>
      rule.trigger.sourceBotId === botId || (rule.target.kind === 'bot' && rule.target.id === botId)),
    cleanupRoomAutomations: roomId => cleanupRules(rule => rule.target.kind === 'room' && rule.target.id === roomId),
  })
}
