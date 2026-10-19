// Checkpoints and time travel over DSH Session forks. A checkpoint is a durable
// conversation cursor at a completed turn; time travel opens a new branch from that
// exact cursor after the current turn ends. Files and running processes are not
// rewound, so the model must not claim otherwise.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const CHECKPOINT_LIMIT = 50
const AUTO_KEEP = 30
const LABEL_MAX = 120
const RECOVER_DELAY_MS = 3_000

const cleanLabel = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, LABEL_MAX)

export const latestCompletedTurn = (session) => {
  const events = session?.snapshotEvents?.() ?? []
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type !== 'turn/end') continue
    return {
      seq: event.seq,
      turn: events.slice(0, index + 1).filter(item => item.type === 'turn/end').length,
      time: event.time,
    }
  }
  return undefined
}

export function install(rt) {
  const { ctx, state } = rt
  const finalizing = new Set()

  const ownBot = exec => {
    const sessionId = exec.agent?.session?.header?.id ?? exec.agent?.id
    return rt.botOf(rt.chatOwners.get(sessionId))
  }

  const checkpointsOf = bot => {
    if (!Array.isArray(bot.checkpoints)) bot.checkpoints = []
    return bot.checkpoints
  }

  const checkpointAt = (bot, session, boundary, { label, source }) => {
    const id = `checkpoint-${randomUUID()}`
    const cwd = ctx.get?.('workingDirectory')?.get?.(session) ?? session.header?.cwd
    const entry = {
      id,
      createdAt: Date.now(),
      label: cleanLabel(label) || `Checkpoint at turn ${boundary.turn}`,
      sessionId: session.id,
      seq: boundary.seq,
      turn: boundary.turn,
      source,
      ...(cwd === undefined ? {} : { cwd }),
    }
    const list = checkpointsOf(bot)
    const duplicate = list.find(item => item.sessionId === entry.sessionId && item.seq === entry.seq)
    if (duplicate !== undefined) {
      if (source === 'manual') {
        duplicate.label = entry.label
        duplicate.source = 'manual'
        duplicate.createdAt = entry.createdAt
      }
      return duplicate
    }
    list.push(entry)
    const automatic = list.filter(item => item.source === 'auto').slice(-AUTO_KEEP)
    const manual = list.filter(item => item.source !== 'auto')
    const kept = new Set([...automatic, ...manual].map(item => item.id))
    bot.checkpoints = list.filter(item => kept.has(item.id)).slice(-CHECKPOINT_LIMIT)
    return entry
  }

  const remember = async (bot, session, boundary, options) => {
    const entry = checkpointAt(bot, session, boundary, options)
    await rt.save()
    return entry
  }

  const abandon = async (bot, pending, reason) => {
    if (bot.pendingBranch?.forkSessionId === pending.forkSessionId) delete bot.pendingBranch
    await rt.save().catch(error => rt.warn('ds-bot: clearing an abandoned time-travel branch for %s failed: %s', bot.name, error))
    await ctx.workspaceRegistry.archiveSession(pending.forkSessionId, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: abandoned time-travel branch %s for %s was not archived: %s', pending.forkSessionId, bot.name, error))
    rt.warn?.('ds-bot: time travel for %s was not opened: %s', bot.name, reason)
  }

  async function finishBranch(botId) {
    const bot = rt.botOf(botId)
    const pending = bot?.pendingBranch
    if (bot === undefined || pending === undefined || finalizing.has(botId)) return
    if (rt.chatOf(bot.id) !== pending.fromSessionId) {
      await abandon(bot, pending, 'the Bot conversation changed before the turn ended')
      return
    }
    finalizing.add(botId)
    const previousSession = rt.chatOf(bot.id)
    const previousSessionField = bot.sessionId
    const previousSegments = bot.segments
    const segments = [...(bot.segments ?? []), {
      sessionId: previousSession,
      endedAt: Date.now(),
      reason: 'time-travel',
      checkpointId: pending.checkpointId,
    }]
    bot.segments = segments
    bot.sessionId = pending.forkSessionId
    delete bot.pendingBranch
    rt.chatOwners.delete(previousSession)
    rt.chatOwners.set(bot.sessionId, bot.id)
    rt.pastOwners.set(previousSession, { botId: bot.id })
    try {
      await rt.save()
    } catch (error) {
      if (previousSessionField === undefined) delete bot.sessionId
      else bot.sessionId = previousSessionField
      bot.segments = previousSegments
      bot.pendingBranch = pending
      rt.chatOwners.delete(pending.forkSessionId)
      rt.chatOwners.set(previousSession, bot.id)
      rt.pastOwners.delete(previousSession)
      throw error
    } finally {
      finalizing.delete(botId)
    }
    const agent = await rt.resolveAgent(bot.sessionId)
    await Promise.resolve(ctx.sessionTitle.rename(agent.session, bot.name))
      .catch(error => rt.warn('ds-bot: time-travel branch for %s was not renamed: %s', bot.name, error))
    await rt.applyPermission(bot, bot.sessionId)
      .catch(error => rt.warn('ds-bot: permission for the time-travel branch of %s was not applied: %s', bot.name, error))
    await rt.applyModel(bot, { force: true })
      .catch(error => rt.warn('ds-bot: model for the time-travel branch of %s was not applied: %s', bot.name, error))
    await rt.ensureCapabilities(bot.sessionId)
      .catch(error => rt.warn('ds-bot: capabilities for the time-travel branch of %s were not mounted: %s', bot.name, error))
  }

  const scheduleFinish = (botId) => {
    void finishBranch(botId).catch(error => rt.warn('ds-bot: time-travel branch for %s was not opened: %s', rt.botOf(botId)?.name ?? botId, error))
  }

  ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    const botId = rt.chatOwners.get(session?.id)
    const bot = rt.botOf(botId)
    if (bot === undefined || rt.chatOf(bot.id) !== session.id) return
    if (bot.pendingBranch?.fromSessionId === session.id) {
      scheduleFinish(bot.id)
      return
    }
    if (rt.readOnly() !== undefined || event.data?.reason?.kind === 'aborted') return
    const boundary = latestCompletedTurn(session)
    if (boundary === undefined) return
    void remember(bot, session, boundary, { label: `Turn ${boundary.turn}`, source: 'auto' })
      .catch(error => rt.warn('ds-bot: automatic checkpoint for %s failed: %s', bot.name, error))
  })

  ctx.tools.register(defineTool({
    name: 'checkpoint_create',
    description: 'Save the latest completed turn of this Bot conversation as a named checkpoint. Conversation only: files, terminal processes and Git state are not snapshotted or rewound.',
    parameters: {
      label: { type: 'string', description: 'Short checkpoint label' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = ownBot(exec)
      if (bot === undefined) throw new Error('checkpoint_create is available only in a Bot\'s own chat')
      const session = exec.agent.session
      const boundary = latestCompletedTurn(session)
      if (boundary === undefined) throw new Error('Finish at least one turn before creating a checkpoint')
      const entry = await remember(bot, session, boundary, {
        label: cleanLabel(args.label) || `Checkpoint at turn ${boundary.turn}`,
        source: 'manual',
      })
      return [
        `Checkpoint saved: ${entry.label}`,
        `ID: ${entry.id}`,
        `Turn: ${entry.turn}`,
        `Event seq: ${entry.seq}`,
        'Conversation only; files and processes were not changed.',
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'checkpoint_list',
    description: 'List saved conversation checkpoints for this Bot, newest first. Read-only.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const bot = ownBot(exec)
      if (bot === undefined) throw new Error('checkpoint_list is available only in a Bot\'s own chat')
      const list = [...checkpointsOf(bot)].sort((a, b) => b.createdAt - a.createdAt)
      if (list.length === 0) return 'No checkpoints yet.'
      return list.map(item => [
        `${item.id} · turn ${item.turn} · seq ${item.seq}`,
        item.label,
        item.source === 'auto' ? 'automatic' : 'saved',
      ].join(' · ')).join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'time_travel',
    description: 'Open a new conversation branch from a saved checkpoint. Uses DSH Session fork and switches to the branch after this turn ends. Files and processes are not rewound. Use only when the user explicitly asks to go back.',
    parameters: {
      checkpoint: { type: 'string', required: true, description: 'Checkpoint ID from checkpoint_list, or its exact label' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const bot = ownBot(exec)
      if (bot === undefined) throw new Error('time_travel is available only in a Bot\'s own chat')
      if (bot.pendingBranch !== undefined) throw new Error('Another time-travel branch is already waiting for this turn to end')
      const wanted = String(args.checkpoint ?? '').trim()
      const matches = checkpointsOf(bot).filter(item => item.id === wanted || item.label === wanted)
      if (matches.length === 0) throw new Error(`Unknown checkpoint: ${wanted}`)
      if (matches.length > 1) throw new Error(`More than one checkpoint is called "${wanted}"; use its ID`)
      const checkpoint = matches[0]
      const fromSessionId = rt.chatOf(bot.id)
      let forked
      try {
        forked = await ctx.sessionController.fork({ sessionId: checkpoint.sessionId, atSeq: checkpoint.seq })
      } catch (error) {
        throw new Error(`Could not open checkpoint ${checkpoint.id}: ${error?.message ?? error}`)
      }
      bot.pendingBranch = {
        checkpointId: checkpoint.id,
        fromSessionId,
        forkSessionId: forked.sessionId,
        createdAt: Date.now(),
      }
      try {
        await rt.save()
      } catch (error) {
        delete bot.pendingBranch
        await ctx.workspaceRegistry.archiveSession(forked.sessionId, { stopActivity: true }).catch(() => {})
        throw error
      }
      return [
        `Branch prepared from ${checkpoint.label} (turn ${checkpoint.turn}).`,
        `New Session: ${forked.sessionId}`,
        'It will become this Bot\'s current conversation when this turn ends.',
        'Files, terminal processes and Git state are not rewound.',
      ].join('\n')
    },
  }))

  ctx.systemPrompt.section({
    name: 'bot-checkpoints',
    order: 649,
    text: context => {
      const id = context?.agent?.id
      return rt.isBotSession(id) ? [
        '# Checkpoints and time travel',
        '- checkpoint_create saves the latest completed conversation turn; checkpoint_list reads saved branches. Automatic checkpoints are kept after ordinary completed turns.',
        '- time_travel uses DSH Session fork and only runs when the user explicitly asks to go back. It opens a new conversation branch after the current turn and never rewrites the old branch.',
        '- Checkpoints do not roll back files, Git, terminal processes or background jobs. Use execution_status and a worktree when file isolation matters; verify the actual files before claiming a restore.',
      ].join('\n') : ''
    },
  })

  ctx.effect(() => {
    const timer = setTimeout(() => {
      void (async () => {
        await rt.load()
        if (rt.readOnly() !== undefined) return
        for (const bot of Object.values(state.bots)) {
          const pending = bot.pendingBranch
          if (pending === undefined) continue
          if (rt.chatOf(bot.id) !== pending.fromSessionId) {
            await abandon(bot, pending, 'the Bot conversation changed while DS Bot was away')
            continue
          }
          const agent = await rt.resolveAgent(pending.fromSessionId).catch(() => undefined)
          if (agent?.status === 'running') continue
          scheduleFinish(bot.id)
        }
      })().catch(error => rt.warn('ds-bot: recovering time-travel branches failed: %s', error))
    }, RECOVER_DELAY_MS)
    timer.unref?.()
    return () => clearTimeout(timer)
  }, 'ds-bot: recover time-travel branches')
}
