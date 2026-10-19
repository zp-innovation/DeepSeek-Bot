// Scenario evaluation: user-defined cases run in isolated read-only Sessions against a
// target Bot's model and skills. Each case starts with a fresh Session, team tools are
// denied, and the Session is archived afterward. Results compare with the previous run.
import { randomUUID } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { TEAM_TOOLS } from './constants.js'
import { cleanText } from './diagnostics.js'
import { splitRef, textOf } from './text.js'
import { output } from './tools.js'

const MAX_SUITES = 30
const MAX_CASES = 20
const MAX_RUNS = 20
const MAX_PROMPT = 20_000
const MAX_OUTPUT = 4_000
const CASE_TIMEOUT_DEFAULT = 180_000
const CASE_TIMEOUT_MAX = 15 * 60_000
const EVAL_DENY = [
  ...TEAM_TOOLS,
  'ask_user_question',
  'create_goal',
  'update_goal',
  'get_goal',
  'schedule_create',
  'schedule_list',
  'schedule_update',
  'schedule_delete',
]

const invalid = message => Object.assign(new Error(message), { code: 'bot/invalid' })
const text = (value, label, max, required = false) => {
  const result = String(value ?? '').trim()
  if (required && result === '') throw invalid(`${label} is required`)
  if (result.length > max) throw invalid(`${label} is longer than ${max} characters`)
  return result
}
const list = (value, label, maxItems = 30) => {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[\n,]/)
  const out = []
  for (const item of raw) {
    const value = String(item ?? '').trim()
    if (value === '') continue
    if (value.length > 120) throw invalid(`${label} entries can have at most 120 characters`)
    if (!out.includes(value)) out.push(value)
    if (out.length > maxItems) throw invalid(`${label} can hold at most ${maxItems} entries`)
  }
  return out
}
const regexOf = (value, label) => {
  const source = String(value ?? '').trim()
  if (source === '') return undefined
  try {
    new RegExp(source)
  } catch {
    throw invalid(`${label} is not a valid regular expression`)
  }
  return source
}
const percent = (pass, total) => total === 0 ? 0 : (pass / total) * 100
const excerpt = value => value.length > MAX_OUTPUT ? `${value.slice(0, MAX_OUTPUT)}…` : value

export function install(rt) {
  const { ctx, state } = rt
  const evalTargets = new Map()
  const collectors = new Map()
  let current

  const library = () => {
    state.evaluations ??= { suites: {}, runs: [] }
    state.evaluations.suites ??= {}
    state.evaluations.runs ??= []
    return state.evaluations
  }
  const writeCheck = () => {
    const readOnly = rt.readOnly?.()
    if (readOnly !== undefined) throw new Error(readOnly)
  }
  const safe = value => cleanText(rt.redactSecrets?.(String(value ?? '')) ?? String(value ?? ''), {
    redact: rt.redactSecrets,
    home: rt.home,
  })
  const viewSuite = suite => ({
    ...suite,
    targetName: rt.botOf(suite.targetBotId)?.name ?? 'Missing Bot',
    cases: suite.cases.map(item => ({ ...item })),
  })
  const viewRun = run => ({
    ...run,
    comparison: run.comparison ? { ...run.comparison } : undefined,
    results: (run.results ?? []).map(result => ({
      ...result,
      checks: (result.checks ?? []).map(check => ({ ...check })),
    })),
  })
  const view = () => {
    const data = library()
    return {
      available: true,
      running: current?.runId ?? null,
      suites: Object.values(data.suites).map(viewSuite).sort((a, b) => a.name.localeCompare(b.name)),
      runs: [...data.runs].slice(-MAX_RUNS).reverse().map(viewRun),
    }
  }

  function caseInput(input, index) {
    const item = input ?? {}
    const name = text(item.name, `Case ${index + 1} name`, 80, true)
    const prompt = text(item.prompt, `Case ${index + 1} prompt`, MAX_PROMPT, true)
    const maxDurationMs = Number(item.maxDurationMs ?? (item.timeoutSeconds ? Number(item.timeoutSeconds) * 1_000 : 0))
    const maxTokens = Number(item.maxTokens ?? 0)
    return {
      id: typeof item.id === 'string' && item.id !== '' ? item.id : randomUUID(),
      name,
      prompt,
      contains: text(item.contains, `Case ${index + 1} contains`, 2_000),
      notContains: text(item.notContains, `Case ${index + 1} must not contain`, 2_000),
      regex: regexOf(item.regex, `Case ${index + 1} regular expression`),
      notRegex: regexOf(item.notRegex, `Case ${index + 1} forbidden regular expression`),
      requiredTools: list(item.requiredTools, `Case ${index + 1} required tools`),
      forbiddenTools: list(item.forbiddenTools, `Case ${index + 1} forbidden tools`),
      maxDurationMs: Number.isSafeInteger(maxDurationMs) && maxDurationMs > 0 ? Math.min(maxDurationMs, CASE_TIMEOUT_MAX) : undefined,
      maxTokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? maxTokens : undefined,
    }
  }

  function suiteInput(body = {}) {
    const data = library()
    const previous = body.id ? data.suites[String(body.id)] : undefined
    if (body.id && previous === undefined) throw invalid('No such evaluation suite')
    if (!previous && Object.keys(data.suites).length >= MAX_SUITES) throw invalid(`A team can have at most ${MAX_SUITES} evaluation suites`)
    const name = text(body.name ?? previous?.name, 'Suite name', 80, true)
    if (Object.values(data.suites).some(item => item.id !== previous?.id && item.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
      throw invalid(`An evaluation suite is already named ${name}`)
    }
    const bot = rt.botOf(String(body.targetBotId ?? previous?.targetBotId ?? ''))
    if (bot === undefined) throw invalid('Choose a target Bot')
    const rawCases = Array.isArray(body.cases) ? body.cases : previous?.cases
    if (!Array.isArray(rawCases) || rawCases.length === 0) throw invalid('Add at least one evaluation case')
    if (rawCases.length > MAX_CASES) throw invalid(`A suite can hold at most ${MAX_CASES} cases`)
    const now = Date.now()
    return {
      id: previous?.id ?? randomUUID(),
      name,
      description: text(body.description ?? previous?.description, 'Suite description', 1_000),
      targetBotId: bot.id,
      cases: rawCases.map(caseInput),
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      revision: previous === undefined ? 1 : (previous.revision ?? 1) + 1,
    }
  }

  async function saveSuite(body) {
    await rt.load()
    writeCheck()
    const item = suiteInput(body)
    library().suites[item.id] = item
    await rt.save()
    return viewSuite(item)
  }

  async function deleteSuite(id) {
    await rt.load()
    writeCheck()
    if (current?.suiteId === id) throw invalid('Stop the running evaluation before deleting its suite')
    const item = library().suites[String(id ?? '')]
    if (item === undefined) throw invalid('No such evaluation suite')
    delete library().suites[item.id]
    await rt.save()
    return true
  }

  function safePermission() {
    const catalog = rt.permissionCatalog?.()
    const readOnly = catalog?.options?.find(option => option.value === 'read-only' || option.value === 'readonly')
    if (readOnly === undefined) throw new Error('Evaluation needs a read-only permission preset on this DSH')
    return readOnly.value
  }

  function collectorFor(sessionId) {
    return new Promise(resolve => {
      collectors.set(sessionId, {
        texts: [],
        tools: [],
        toolErrors: 0,
        tokens: 0,
        reason: undefined,
        resolve,
      })
    })
  }

  ctx.on('session/event', (session, event) => {
    const collector = collectors.get(session?.id)
    if (collector === undefined) return
    const data = event.data ?? {}
    if (event.type === 'turn/start') {
      const target = evalTargets.get(session.id)
      rt.observabilityTagTurn?.(session.id, {
        'ds_bot.eval.run_id': collector.runId,
        'ds_bot.eval.case_id': collector.caseId,
        ...(target ? {
          'ds_bot.eval.bot_id': target.id,
          'ds_bot.eval.bot_name': target.name,
        } : {}),
      })
      return
    }
    if (event.type === 'assistant/message') {
      const value = textOf(data.message?.content)
      if (value !== '') collector.texts.push(value)
      const usage = data.usage
      collector.tokens += (usage?.inputTokens ?? 0) + (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0) + (usage?.outputTokens ?? 0)
      return
    }
    if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
      const name = String(data.name ?? '')
      if (name !== '' && !collector.tools.includes(name)) collector.tools.push(name)
      return
    }
    if (event.type === 'tool/result' && (data.isError === true || data.error !== undefined)) collector.toolErrors += 1
    if (event.type !== 'turn/end') return
    collectors.delete(session.id)
    collector.reason = data.reason
    collector.resolve(collector)
  })

  async function archive(sessionId) {
    evalTargets.delete(sessionId)
    await ctx.workspaceRegistry.archiveSession(sessionId, { stopActivity: true })
      .catch(error => rt.warn('ds-bot: evaluation Session %s not archived: %s', sessionId, error))
  }

  function checksFor(item, collected, reason, durationMs) {
    const outputText = collected.texts.join('\n\n').trim()
    const checks = []
    const check = (id, passed, detail) => checks.push({ id, passed, ...(detail ? { detail: safe(detail).slice(0, 300) } : {}) })
    check('completed', reason?.kind === 'completed', reason?.kind ? `Ended as ${reason.kind}` : 'No turn end')
    check('no-tool-errors', collected.toolErrors === 0, collected.toolErrors > 0 ? `${collected.toolErrors} tool calls failed` : undefined)
    if (item.contains) check('contains', outputText.includes(item.contains), `Expected ${JSON.stringify(item.contains)}`)
    if (item.notContains) check('not-contains', !outputText.includes(item.notContains), `Must not contain ${JSON.stringify(item.notContains)}`)
    if (item.regex) check('regex', new RegExp(item.regex).test(outputText), `Expected /${item.regex}/`)
    if (item.notRegex) check('not-regex', !new RegExp(item.notRegex).test(outputText), `Must not match /${item.notRegex}/`)
    const missing = item.requiredTools.filter(name => !collected.tools.includes(name))
    const forbidden = item.forbiddenTools.filter(name => collected.tools.includes(name))
    if (item.requiredTools.length > 0) check('required-tools', missing.length === 0, missing.length > 0 ? `Missing ${missing.join(', ')}` : undefined)
    if (item.forbiddenTools.length > 0) check('forbidden-tools', forbidden.length === 0, forbidden.length > 0 ? `Used ${forbidden.join(', ')}` : undefined)
    if (item.maxDurationMs) check('duration', durationMs <= item.maxDurationMs, `${durationMs} ms > ${item.maxDurationMs} ms`)
    if (item.maxTokens) check('tokens', collected.tokens <= item.maxTokens, `${collected.tokens} > ${item.maxTokens}`)
    return { checks, outputText }
  }

  async function runCase(run, suite, bot, item, runController) {
    const startedAt = Date.now()
    let sessionId
    let controller
    try {
      writeCheck()
      sessionId = await rt.createSession(`Eval · ${suite.name} · ${item.name}`.slice(0, 80))
      const agent = await rt.resolveAgent(sessionId)
      evalTargets.set(sessionId, bot)
      const ref = await rt.desiredModel(bot)
      const route = ref ? splitRef(ref) : undefined
      const reasoningEffort = ref ? await rt.desiredEffort?.(bot, ref) : undefined
      if (route) await rt.selectSessionModel(sessionId, {
        ...route,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
      await rt.applyPermission({ ...bot, permission: safePermission() }, sessionId)
      await rt.prepareCapabilitiesForEval?.(agent, bot)
      const served = new Set(ctx.tools.schemas(agent).map(schema => schema.name))
      const deny = [...new Set(EVAL_DENY)].filter(name => served.has(name))
      if (deny.length > 0) {
        if (typeof agent.ctx?.tools?.restrict !== 'function') throw new Error('This DSH cannot isolate team tools for evaluation')
        agent.ctx.tools.restrict({ deny })
      }
      const collectedPromise = collectorFor(sessionId)
      const collector = collectors.get(sessionId)
      collector.runId = run.id
      collector.caseId = item.id
      controller = new AbortController()
      const timeoutMs = item.maxDurationMs ?? CASE_TIMEOUT_DEFAULT
      const timer = setTimeout(() => {
        controller.abort()
        agent.cancel({ kind: 'user' })
      }, timeoutMs)
      const onRunAbort = () => {
        controller.abort()
        agent.cancel({ kind: 'user' })
      }
      runController.signal.addEventListener('abort', onRunAbort, { once: true })
      try {
        await ctx.sessionController.prompt({
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: item.prompt }],
        }, controller.signal)
        await ctx.sessions.flush(agent.session)
        const collected = await Promise.race([
          collectedPromise,
          new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({
            texts: collector.texts,
            tools: collector.tools,
            toolErrors: collector.toolErrors,
            tokens: collector.tokens,
            reason: { kind: 'aborted' },
          }), { once: true })),
        ])
        const durationMs = Date.now() - startedAt
        const { checks, outputText } = checksFor(item, collected, collected.reason, durationMs)
        return {
          caseId: item.id,
          name: item.name,
          status: checks.every(check => check.passed) ? 'passed' : 'failed',
          startedAt,
          durationMs,
          tokens: collected.tokens,
          tools: collected.tools,
          toolErrors: collected.toolErrors,
          checks,
          output: excerpt(safe(outputText)),
          ...(collected.reason?.kind === 'error' ? { error: safe(collected.reason.error?.message ?? collected.reason.error?.code ?? 'Model call failed') } : {}),
        }
      } finally {
        clearTimeout(timer)
        runController.signal.removeEventListener('abort', onRunAbort)
      }
    } catch (error) {
      return {
        caseId: item.id,
        name: item.name,
        status: 'failed',
        startedAt,
        durationMs: Date.now() - startedAt,
        tokens: 0,
        tools: [],
        toolErrors: 0,
        checks: [{ id: 'completed', passed: false, detail: safe(error?.message ?? error).slice(0, 300) }],
        output: '',
        error: safe(error?.message ?? error),
      }
    } finally {
      collectors.delete(sessionId)
      if (sessionId !== undefined) await archive(sessionId)
    }
  }

  function comparisonFor(run, previous) {
    if (previous === undefined) return undefined
    const before = new Map((previous.results ?? []).map(result => [result.caseId, result]))
    const regressions = []
    const improvements = []
    for (const result of run.results) {
      const old = before.get(result.caseId)
      if (old?.status === 'passed' && result.status === 'failed') regressions.push(result.name)
      if (old?.status === 'failed' && result.status === 'passed') improvements.push(result.name)
    }
    return {
      baselineRunId: previous.id,
      passDelta: run.summary.passed - previous.summary.passed,
      durationDeltaMs: run.summary.durationMs - previous.summary.durationMs,
      tokenDelta: run.summary.tokens - previous.summary.tokens,
      regressions,
      improvements,
    }
  }

  async function executeRun(run, suite) {
    const bot = rt.botOf(suite.targetBotId)
    if (bot === undefined) {
      run.status = 'failed'
      run.finishedAt = Date.now()
      run.error = 'The target Bot was deleted'
      await rt.save().catch(() => {})
      return
    }
    const previous = [...library().runs].reverse().find(item => item.id !== run.id && item.suiteId === suite.id && item.status === 'completed')
    const controller = new AbortController()
    current = { runId: run.id, suiteId: suite.id, controller }
    try {
      for (const [index, item] of suite.cases.entries()) {
        if (controller.signal.aborted) break
        run.currentCase = item.name
        run.results.push(await runCase(run, suite, bot, item, controller))
        run.progress = { done: index + 1, total: suite.cases.length }
        const passed = run.results.filter(result => result.status === 'passed').length
        run.summary = {
          passed,
          failed: run.results.length - passed,
          passRate: percent(passed, run.results.length),
          durationMs: Date.now() - run.startedAt,
          tokens: run.results.reduce((sum, result) => sum + (result.tokens ?? 0), 0),
        }
        await rt.save().catch(error => rt.warn('ds-bot: evaluation progress not saved: %s', error))
      }
      run.finishedAt = Date.now()
      run.status = controller.signal.aborted ? 'cancelled' : 'completed'
      delete run.currentCase
      run.summary.durationMs = run.finishedAt - run.startedAt
      run.comparison = comparisonFor(run, previous)
    } catch (error) {
      run.finishedAt = Date.now()
      run.status = 'failed'
      run.error = safe(error?.message ?? error)
    } finally {
      current = undefined
      await rt.save().catch(error => rt.warn('ds-bot: evaluation result not saved: %s', error))
    }
  }

  async function startRun(id) {
    await rt.load()
    writeCheck()
    if (current !== undefined) throw invalid('An evaluation is already running')
    const suite = library().suites[String(id ?? '')]
    if (suite === undefined) throw invalid('No such evaluation suite')
    if (rt.botOf(suite.targetBotId) === undefined) throw invalid('The target Bot no longer exists')
    safePermission()
    const now = Date.now()
    const run = {
      id: randomUUID(),
      suiteId: suite.id,
      suiteName: suite.name,
      botId: suite.targetBotId,
      botName: rt.botOf(suite.targetBotId).name,
      startedAt: now,
      status: 'running',
      results: [],
      progress: { done: 0, total: suite.cases.length },
      summary: { passed: 0, failed: 0, passRate: 0, durationMs: 0, tokens: 0 },
    }
    library().runs.push(run)
    state.evaluations.runs = library().runs.slice(-MAX_RUNS)
    await rt.save()
    void executeRun(run, suite)
    return viewRun(run)
  }

  function cancelRun() {
    if (current === undefined) throw invalid('No evaluation is running')
    current.controller.abort()
    return true
  }

  async function endpoint(name, body = {}) {
    if (name === 'evaluations') return view()
    if (name === 'eval-save') return saveSuite(body)
    if (name === 'eval-delete') return deleteSuite(body.id)
    if (name === 'eval-run') return startRun(body.id)
    if (name === 'eval-cancel') return cancelRun()
    if (name === 'eval-run-detail') {
      const run = library().runs.find(item => item.id === body.id)
      if (run === undefined) throw Object.assign(new Error('No such evaluation run'), { code: 'bot/not-found' })
      return viewRun(run)
    }
    throw Object.assign(new Error('Unknown evaluation operation'), { code: 'bot/not-found' })
  }

  ctx.effect(() => ctx.systemPrompt.section({
    name: 'eval-target',
    order: 641,
    interpolate: false,
    text: context => {
      const bot = evalTargets.get(context?.agent?.id)
      if (bot === undefined) return ''
      return [
        '# Evaluation target',
        `You are being evaluated as ${bot.name}${bot.role ? `, ${bot.role}` : ''}.`,
        bot.instructions ? `\n${bot.instructions}` : '',
        '',
        'This is an isolated, read-only evaluation Session. Team-management, user-question, goal and scheduler tools are unavailable. Answer the evaluation prompt directly and do not claim work you did not perform.',
      ].join('\n')
    },
  }), 'ds-bot: evaluation identity')

  ctx.tools.register(defineTool({
    name: 'eval_list',
    description: 'Main Bot only. List evaluation suites and recent pass rates. Prompt text and output excerpts are available in Settings → Evaluation.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const bot = rt.botOf(rt.selfOf?.(exec.agent?.id))
      if (bot === undefined) return 'Only Bots on the team can use eval_list.'
      if (!rt.isMain(bot.id)) return 'Only a Main Bot can read eval_list.'
      const value = view()
      const lines = ['Evaluation suites:']
      if (value.suites.length === 0) lines.push('- None.')
      else lines.push(...value.suites.map(suite => `- ${suite.name} → ${suite.targetName} · ${suite.cases.length} cases`))
      lines.push('', 'Recent runs:')
      if (value.runs.length === 0) lines.push('- None.')
      else lines.push(...value.runs.slice(0, 8).map(run => `- ${run.suiteName} · ${run.status} · ${run.summary?.passRate?.toFixed?.(1) ?? 0}% · ${new Date(run.startedAt).toISOString()}`))
      return lines.join('\n')
    },
  }))

  ctx.effect(() => {
    void (async () => {
      await rt.load()
      if (rt.readOnly?.() !== undefined) return
      let changed = false
      for (const run of library().runs) {
        if (run.status !== 'running') continue
        run.status = 'interrupted'
        run.finishedAt = Date.now()
        run.error = 'DS Bot restarted while this evaluation was running'
        for (const result of run.results ?? []) if (result.status === 'running') result.status = 'failed'
        changed = true
      }
      if (changed) await rt.save()
    })().catch(error => rt.warn('ds-bot: evaluation recovery failed: %s', error))
    return () => {
      current?.controller.abort()
    }
  }, 'ds-bot: evaluation recovery')

  Object.assign(rt, {
    evaluationEndpoint: endpoint,
    evaluationView: view,
    evalBotOf: sessionId => evalTargets.get(sessionId),
    evalRunning: () => current !== undefined,
    evalStop: cancelRun,
  })
}
