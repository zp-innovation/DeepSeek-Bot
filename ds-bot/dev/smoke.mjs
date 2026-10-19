// API-level smoke test of the Bot team on a mock bench (dev/bench.sh). It drives the main
// flows through POST /api/bot, waits for the team to go quiet after each step, and checks
// the saved state and the mock model's log. Run it on a freshly reset bench whose check
// line is low enough for a few long replies to cross it, yet well above the ~16k tokens
// of system prompt and tools, so a condensed part can fall back below it:
//
//   CONTEXT_WINDOW=100000 CHECK_RATIO=0.45 dev/bench.sh smoke 3096 8796 reset && node dev/smoke.mjs smoke 3096
//
// `--out <file>` writes a normalized transcript (names instead of ids, sorted where the
// order depends on timing), so two runs, before and after a refactor, can be diffed.
import { execFileSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [name, port, ...rest] = process.argv.slice(2)
if (!name || !port) {
  console.error('usage: node dev/smoke.mjs <bench-name> <web-port> [--out <file>]')
  process.exit(2)
}
const outFile = rest[0] === '--out' ? rest[1] : undefined
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const HOME = join(ROOT, `.dsh-test-${name}`)
const BASE = `http://127.0.0.1:${port}`
const QUIET_MS = 2500
const STEP_TIMEOUT_MS = 120_000

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const mockLog = () => {
  try {
    return readFileSync(join(HOME, 'mock.jsonl'), 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

async function login() {
  const log = readFileSync(join(HOME, 'web.log'), 'utf8')
  const url = log.match(new RegExp(`http://127\\.0\\.0\\.1:${port}/\\?token=[^\\s]+`))?.[0]
  if (!url) throw new Error('no login URL in web.log')
  const response = await fetch(url, { redirect: 'manual' })
  const cookies = response.headers.getSetCookie().map(cookie => cookie.split(';')[0])
  if (cookies.length === 0) throw new Error(`login returned no cookie (${response.status})`)
  return cookies.join('; ')
}

const cookie = await login()
async function api(endpoint, payload = {}) {
  const response = await fetch(`${BASE}/api/bot`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ endpoint, payload }),
  })
  const result = await response.json()
  if (!result.ok) throw new Error(`${endpoint}: ${result.error?.message ?? JSON.stringify(result)}`)
  return result.value
}

const state = () => readJson(join(HOME, 'bot', 'state.json'))
const botNamed = wanted => Object.values(state().bots).find(bot => bot.name === wanted)
const roomNamed = wanted => Object.values(state().rooms).find(room => room.name === wanted)

// Quiet: no Bot shows an activity and the mock has taken no call for QUIET_MS. Deliveries
// start a moment after a turn ends, so activity alone is not enough.
async function settle() {
  const deadline = Date.now() + STEP_TIMEOUT_MS
  let calls = mockLog().length
  let since = Date.now()
  while (Date.now() < deadline) {
    await sleep(400)
    const { activity = {} } = await api('state')
    const now = mockLog().length
    if (now !== calls || Object.keys(activity).length > 0) {
      calls = now
      since = Date.now()
    } else if (Date.now() - since >= QUIET_MS) {
      return
    }
  }
  throw new Error('the team did not go quiet')
}

// Ids differ between runs, so the transcript names Bots, groups and Sessions by owner.
function normalized() {
  const current = state()
  const nameOf = id => current.bots[id]?.name ?? current.rooms[id]?.name ?? (id ? 'unknown' : null)
  const sessionOwner = (sessionId) => {
    for (const bot of Object.values(current.bots)) {
      if (bot.id === sessionId || bot.sessionId === sessionId || (bot.segments ?? []).some(part => part.sessionId === sessionId)) return bot.name
    }
    for (const room of Object.values(current.rooms)) {
      if (room.id === sessionId) return `group ${room.name}`
      for (const [botId, groupSession] of Object.entries(room.sessions ?? {})) {
        if (groupSession === sessionId) return `${nameOf(botId)} in ${room.name}`
      }
    }
    return 'unknown'
  }
  const sorted = list => [...list].sort()
  return {
    bots: Object.values(current.bots).map(bot => ({
      name: bot.name,
      role: bot.role,
      model: bot.model ?? null,
      main: current.mainBotIds.includes(bot.id),
      pinned: bot.pinned === true,
      hidden: bot.hidden === true,
      parts: 1 + (bot.segments ?? []).length,
      createdBy: nameOf(bot.createdBy),
    })).sort((a, b) => a.name.localeCompare(b.name)),
    rooms: Object.values(current.rooms).map(room => ({
      name: room.name,
      members: sorted(room.members.map(nameOf)),
      admin: nameOf(room.admin),
      mode: room.mode,
      notice: room.notice,
      log: sorted((room.log ?? []).map(line => `${line.kind ?? 'say'} ${line.who}: ${String(line.text).slice(0, 48)}`)),
      groupSessions: sorted(Object.keys(room.sessions ?? {}).map(nameOf)),
    })),
    exchanges: sorted(current.exchanges.map(entry => `${entry.role} ${nameOf(entry.from) ?? 'You'} -> ${nameOf(entry.to)}: ${entry.text.slice(0, 40)}`)),
    questions: sorted(Object.keys(current.questions ?? {}).map(sessionOwner)),
  }
}

// What the mock said during a step, without timing-dependent order, clock times or filler
// length.
const said = calls => calls.flatMap(call => (call.out ?? []).map(block => (block.type === 'tool_use'
  ? `tool ${block.name} ${JSON.stringify(block.input).slice(0, 60)}`
  : block.type === 'text' ? `text ${block.text.replace(/…\(\d+\)$/, '…').replace(/\d\d-\d\d \d\d:\d\d/g, 'MM-DD hh:mm').slice(0, 60)}` : block.type))).sort()

const transcript = []
const failures = []
async function step(title, run, check) {
  const before = mockLog().length
  const started = Date.now()
  let value
  try {
    value = await run()
    await settle()
  } catch (error) {
    failures.push(`${title}: ${error.message}`)
    console.log(`FAIL ${title}: ${error.message}`)
    return undefined
  }
  const calls = mockLog().slice(before)
  const problem = (() => {
    try { return check?.(value, calls) } catch (error) { return error.message }
  })()
  transcript.push({ step: title, said: said(calls), state: normalized() })
  if (problem) {
    failures.push(`${title}: ${problem}`)
    console.log(`FAIL ${title}: ${problem}`)
  } else {
    console.log(`ok   ${title} (${((Date.now() - started) / 1000).toFixed(1)} s, ${calls.length} model calls)`)
  }
  return value
}
const expect = (condition, message) => (condition ? undefined : message)
const saidText = (calls, pattern) => calls.some(call => (call.out ?? []).some(block => block.type === 'text' && pattern.test(block.text)))

const send = (sessionId, text) => api('send', { sessionId, text })
const chief = () => botNamed('Chief')

let models = []
await step('bootstrap: Chief waits for a model', () => api('state'), (value, calls) => {
  const current = state()
  const bots = Object.values(current.bots)
  models = value.models ?? []
  return expect(bots.length === 1 && bots[0].name === 'Chief' && current.mainBotIds[0] === bots[0].id, 'expected one Main Bot named Chief')
    ?? expect(bots[0].model === undefined && bots[0].kickoff !== undefined, 'Chief should hold its greeting until a model is picked')
    ?? expect(value.bots[0].waiting === true, 'the view should show Chief as waiting')
    ?? expect(calls.length === 0, `Chief called the model ${calls.length} times before it had one`)
    ?? expect(models.length > 0, 'no models listed for the model card')
})

await step('user picks a model; Chief greets and asks in its reply', () => api('update-bot', { id: chief().id, model: models.at(-1).ref }), (_value, calls) => {
  const current = state()
  return expect(chief().model === models.at(-1).ref, `Chief runs on ${chief().model}`)
    ?? expect(chief().kickoff === undefined, 'the greeting is still held')
    ?? expect(!current.questions?.[chief().sessionId ?? chief().id], 'the greeting should not leave a question card')
    ?? expect(saidText(calls, /先让团队帮你做哪块/), 'expected Chief to ask in its reply')
})

await step('Chief creates Writer, who replies', () => send(chief().id, '创建一个叫Writer的bot'), () => {
  const writer = botNamed('Writer')
  if (!writer) return 'no Writer'
  const kinds = state().exchanges.filter(entry => [entry.from, entry.to].includes(writer.id)).map(entry => entry.role)
  return expect(writer.createdBy === chief().id, 'Writer should be created by Chief')
    ?? expect(kinds.includes('request') && kinds.includes('reply'), `expected a request and a reply, got ${kinds}`)
})

// The mock calls dsh's ask_user_question for 阻塞提问 whenever the request offers it.
await step('a Bot is not offered dsh\'s blocking question tool', () => send(botNamed('Writer').id, '阻塞提问'), (_value, calls) => {
  const asked = calls.some(call => (call.out ?? []).some(block => block.type === 'tool_use' && block.name === 'ask_user_question'))
  return expect(!asked, 'Writer called ask_user_question')
    ?? expect(saidText(calls, /^收到：阻塞提问/), 'expected Writer to answer in its reply')
})

await step('user creates Coder, who keeps the default model', () => api('create-bot', { name: 'Coder', role: 'Engineer', instructions: 'Write code.' }), (bot) => {
  const coder = botNamed('Coder')
  return expect(coder && coder.id === bot.id && coder.role === 'Engineer', 'Coder not saved as asked')
    ?? expect(typeof coder.model === 'string' && coder.model.includes('/'), `Coder has no model of its own: ${coder.model}`)
    ?? expect(!Object.values(state().bots).some(entry => 'lab' in entry), 'a Bot still has a lab')
})

await step('Coder sets persistent shell state', () => send(botNamed('Coder').id, '持久终端 设置'), (_value, calls) => {
  return expect(saidText(calls, /^持久终端状态已设置/), 'the persistent shell did not accept the marker')
})

await step('Coder reads persistent shell state in a later call', () => send(botNamed('Coder').id, '持久终端 读取'), (_value, calls) => {
  return expect(saidText(calls, /^持久终端状态还在/), 'the persistent shell lost its environment')
})

await step('Chief creates a group', () => send(chief().id, '建群 研发群: Writer, Coder'), () => {
  const room = roomNamed('研发群')
  if (!room) return 'no group 研发群'
  const names = room.members.map(id => state().bots[id]?.name).sort()
  return expect(names.includes('Writer') && names.includes('Coder'), `members ${names}`)
})

await step('user talks in the group', () => send(roomNamed('研发群').id, '大家好'), () => {
  const log = roomNamed('研发群').log ?? []
  return expect(log.some(line => line.who === 'User' && line.text === '大家好'), 'no user line')
    ?? expect(log.some(line => line.who !== 'User' && line.kind === undefined), 'no Bot answered')
})

await step('admin calls everyone', () => send(roomNamed('研发群').id, '讨论'), () => {
  const log = roomNamed('研发群').log ?? []
  const at = log.findLastIndex(line => line.who === 'User' && line.text === '讨论')
  const answers = log.slice(at + 1).filter(line => line.who !== 'User' && line.kind === undefined)
  return expect(answers.length >= 2, `expected at least two answers, got ${answers.length}`)
})

await step('Chief posts to the group', () => send(chief().id, '群发 研发群: 今天下午开会'), () => {
  const log = roomNamed('研发群').log ?? []
  return expect(log.some(line => line.who === 'Chief' && line.text.includes('今天下午开会')), 'post missing from the group log')
})

await step('Chief sets the group notice', () => send(chief().id, '改群 研发群 公告: 周五交付'), () => expect(roomNamed('研发群').notice === '周五交付', 'notice not set'))

await step('Chief reads the group', () => send(chief().id, '看群 研发群'), (_value, calls) => expect(saidText(calls, /^群里最近/), 'no read_group_chat answer'))

for (const round of [1, 2, 3]) {
  await step(`Writer writes long reply ${round}`, () => send(botNamed('Writer').id, `长文 30 第${round}篇`), round < 3 ? undefined : () => {
    const writer = botNamed('Writer')
    return expect((writer.segments ?? []).length >= 1 && writer.sessionId !== writer.id, 'Writer did not switch to a new part')
  })
}

await step('Writer searches its own chat across parts', () => send(botNamed('Writer').id, '查记录 长文'), (_value, calls) => expect(saidText(calls, /共 \d+ 段/), 'read_own_chat did not span parts'))

// `earlier` pages backwards from the part the chat shows now.
await step('earlier part pages load', () => api('earlier', { sessionId: botNamed('Writer').sessionId }), page => expect(Array.isArray(page?.items) && page.items.some(item => item.kind === 'user'), `no user lines in the part before (${JSON.stringify(page).slice(0, 80)})`))

// Work still under way (the mock steward reads 阶段未完 in the latest user message): the
// part is condensed in place with DS Bot's checkpoint, not switched, and the condensed
// messages stay searchable. Then work that reaches a stopping point switches again.
const writerParts = () => (botNamed('Writer').segments ?? []).length
const partsBeforeWork = writerParts()
const workMark = mockLog().length
for (const round of [1, 2, 3]) {
  await step(`Writer keeps working ${round}`, () => send(botNamed('Writer').id, `长文 30 阶段未完 第${round}节`))
}
await step('Writer condensed in place, not switched', () => api('state'), () => {
  const calls = mockLog().slice(workMark)
  return expect(saidText(calls, /"action":"compact"/), 'the steward did not say compact')
    ?? expect(saidText(calls, /checkpoint 提示词/), 'no checkpoint was written')
    ?? expect(!saidText(calls, /backend 提示词/), 'the backend\'s own summary ran for a Bot')
    ?? expect(writerParts() === partsBeforeWork, `Writer switched (${partsBeforeWork} -> ${writerParts()} earlier parts)`)
})
await step('Writer finds a condensed message', () => send(botNamed('Writer').id, '查记录 阶段未完 第1节'), (_value, calls) => expect(saidText(calls, /聊过 [1-9]\d* 条.*第1节/), 'read_own_chat lost the condensed message'))
const wrapMark = mockLog().length
for (const round of [1, 2, 3, 4]) {
  await step(`Writer wraps up ${round}`, () => send(botNamed('Writer').id, `长文 30 收尾 第${round}节`), round < 4 ? undefined : () => {
    const calls = mockLog().slice(wrapMark)
    return expect(saidText(calls, /"action":"switch"/), 'the steward did not say switch')
      ?? expect(writerParts() > partsBeforeWork, 'Writer did not move on after the work was done')
  })
}

await step('exchange log between Chief and Writer', () => api('exchange', { a: chief().id, b: botNamed('Writer').id }), entries => expect(entries.length >= 2, `got ${entries.length}`))

// Writer hands Chief's work on to Coder and waits, and the team view shows it; Coder's
// result goes up to Chief with Writer's answer.
await step('Writer waits for the work it handed on, then answers with it', async () => {
  await send(chief().id, '转告 Writer: 转告 Coder: 慢慢做 3')
  const writer = botNamed('Writer').id
  for (const deadline = Date.now() + STEP_TIMEOUT_MS; Date.now() < deadline; await sleep(200)) {
    const { activity = {}, work = {} } = await api('state')
    if (activity[writer] === 'waiting') return work.waiting?.[writer]
  }
  return undefined
}, (waiting, calls) => expect(waiting?.bots?.includes(botNamed('Coder').id) && waiting.for.includes(chief().id), `Writer did not show that it waits for Coder (${JSON.stringify(waiting)})`)
  ?? expect(saidText(calls, /^Coder 交回了，我把结果交给 Chief/), 'Writer did not go on when Coder answered')
  ?? expect(state().exchanges.some(entry => entry.role === 'reply' && entry.from === botNamed('Writer').id && entry.text.includes('[Handed back to Writer for this work]')), 'Chief did not get Coder\'s result with Writer\'s answer'))

await step('update Writer', () => api('update-bot', { id: botNamed('Writer').id, role: 'Copywriter', instructions: 'Write the copy.' }), () => {
  const writer = botNamed('Writer')
  return expect(writer.role === 'Copywriter' && writer.instructions === 'Write the copy.', 'update not saved')
})

// dsh keeps each Session under a folder named after its cwd. A change of working folder
// moves the Bot's own chat on to a fresh part made there; the fresh part then stays put.
// The native realpath is the one DS Bot saves; on Windows the JS one keeps 8.3 short names.
const project = realpathSync.native(mkdtempSync(join(tmpdir(), 'ds-bot-smoke-folder-')))
execFileSync('git', ['init'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['config', 'user.name', 'DS Bot Smoke'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['config', 'user.email', 'smoke@example.invalid'], { cwd: project, stdio: 'ignore' })
writeFileSync(join(project, 'README.md'), 'initial\n')
execFileSync('git', ['add', '--', 'README.md'], { cwd: project, stdio: 'ignore' })
execFileSync('git', ['commit', '-m', 'initial'], { cwd: project, stdio: 'ignore' })
const folderOf = sessionId => readdirSync(join(HOME, 'sessions')).find(dir => existsSync(join(HOME, 'sessions', dir, sessionId)))
const coderParts = () => (botNamed('Coder').segments ?? []).length
const partsBeforeFolder = coderParts()
await step('Coder works in a folder of its own', () => api('update-bot', { id: botNamed('Coder').id, workDir: project }), () => {
  const coder = botNamed('Coder')
  return expect(coder.workDir === project, `folder not saved (${coder.workDir})`)
    ?? expect(coderParts() === partsBeforeFolder + 1, `Coder has ${coderParts()} earlier parts, not ${partsBeforeFolder + 1}`)
    ?? expect(folderOf(coder.sessionId)?.includes(basename(project)), `Coder's chat is under ${folderOf(coder.sessionId)}`)
})
await step('Coder reports its real execution policy', () => send(botNamed('Coder').id, '执行状态'), (_value, calls) => {
  return expect(saidText(calls, /执行状态：.*Backend: local/), 'execution_status did not report the backend')
    ?? expect(saidText(calls, /Sandbox mode: workspace-write/), 'execution_status did not report the sandbox mode')
    ?? expect(saidText(calls, /Sandbox enforcement: (full|partial)/), 'execution_status did not probe enforcement')
})
await step('Coder reads repository status through coding tools', () => send(botNamed('Coder').id, '编码状态'), (_value, calls) => {
  return expect(saidText(calls, /仓库状态：\nRepository:/), 'repo_status did not read the repository')
})
writeFileSync(join(project, 'README.md'), 'initial\nchanged\n')
await step('Coder reviews the unstaged diff through coding tools', () => send(botNamed('Coder').id, '编码差异'), (_value, calls) => {
  return expect(saidText(calls, /仓库差异：[\s\S]*\+changed/), 'repo_diff did not read the unstaged change')
})
await step('Coder creates an isolated worktree', () => send(botNamed('Coder').id, '创建隔离工作区'), (_value, calls) => {
  return expect(saidText(calls, /工作树已创建：[\s\S]*Branch: smoke-worktree/), 'create_worktree did not create the checkout')
})
await step('Coder reads repository status inside the worktree', () => send(botNamed('Coder').id, '编码状态'), (_value, calls) => {
  return expect(saidText(calls, /仓库状态：\nRepository: .*\.agents[\\/]worktrees[\\/]smoke-worktree/), 'repo_status did not follow the worktree directory')
})
await step('Coder lists the repository worktrees', () => send(botNamed('Coder').id, '列出工作树'), (_value, calls) => {
  return expect(saidText(calls, /工作树列表：[\s\S]*smoke-worktree/), 'list_worktrees did not show the checkout')
})
await step('Coder answers from its folder', () => send(botNamed('Coder').id, '你好'), () => expect(coderParts() === partsBeforeFolder + 1, 'Coder moved on again'))
await step('Coder goes back to the team workspace', () => api('update-bot', { id: botNamed('Coder').id, workDir: '' }), () => {
  const coder = botNamed('Coder')
  return expect(coder.workDir === undefined, 'folder not cleared')
    ?? expect(folderOf(coder.sessionId)?.endsWith('-bot-workspace--'), `Coder's chat is under ${folderOf(coder.sessionId)}`)
})
await step('Coder releases the persistent shell directory', () => send(botNamed('Coder').id, '编码离开'), (_value, calls) => {
  return expect(saidText(calls, /^已离开仓库目录/), 'the persistent shell still holds the repository directory')
})
try {
  rmSync(project, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
} catch (error) {
  // DSH can still watch a Session folder on Windows after its Agent moves away.
  if (process.platform !== 'win32' || (error.code !== 'EPERM' && error.code !== 'EBUSY')) throw error
  console.log(`note: the smoke folder stays until DSH exits: ${project}`)
}

await step('pin Coder', () => api('set-flags', { id: botNamed('Coder').id, pinned: true }), () => expect(botNamed('Coder').pinned === true, 'not pinned'))

await step('make Coder a Main Bot and back', async () => {
  await api('set-main', { id: botNamed('Coder').id, main: true })
  const both = state().mainBotIds.length
  await api('set-main', { id: botNamed('Coder').id, main: false })
  return both
}, both => expect(both === 2 && state().mainBotIds.length === 1, `main counts ${both}, ${state().mainBotIds.length}`))

await step('duplicate Coder', () => api('duplicate-bot', { id: botNamed('Coder').id }), copy => expect(copy && state().bots[copy.id] && copy.id !== botNamed('Coder').id, 'no copy'))

await step('set prefs', () => api('set-prefs', { theme: 'dark', accent: '#336699' }), () => expect(state().prefs.theme === 'dark' && state().prefs.accent === '#336699', 'prefs not saved'))

await step('delete the group', () => api('delete-room', { id: roomNamed('研发群').id }), () => expect(Object.keys(state().rooms).length === 0, 'group still there'))

await step('delete the copy', async () => {
  const copy = Object.values(state().bots).find(bot => bot.name !== 'Coder' && bot.name.startsWith('Coder'))
  if (!copy) throw new Error('no copy to delete')
  await api('delete-bot', { id: copy.id })
  return copy.id
}, id => expect(state().bots[id] === undefined, 'copy still there'))

// The mock answers 查能力 with the mcp__ tools and catalog skills it sees in the request.
const echoName = 'smoke-echo'
const skillName = 'smoke-guide'
const skillDescription = 'Smoke test skill'
const echoServer = join(ROOT, 'ds-bot', 'dev', 'mcp-echo-server.mjs')
const sees = `工具 mcp__${echoName}__echo；技能 ${skillName}（${skillDescription}）`
const seesNothing = '工具 无；技能 无'
const reportOf = (calls, bot) => calls.flatMap(call => call.out ?? []).find(block => block.type === 'text' && block.text.startsWith(`${bot} 能力：`))?.text
const attach = (bot, name, attached) => api('bot-capability', { botId: bot.id, name, attached })
await api('capability-save', { name: echoName, kind: 'mcp', description: 'Smoke test echo server', transport: 'stdio', command: process.execPath, args: [echoServer], env: {} })
await api('capability-save', {
  name: skillName,
  kind: 'skill',
  content: [
    '---',
    `name: ${skillName}`,
    `description: ${skillDescription}`,
    'whenToUse: When checking capability discovery',
    '---',
    '',
    'Use this skill when asked about capability smoke checks.',
  ].join('\n'),
})
await attach(chief(), echoName, true)
await attach(chief(), skillName, true)

await step('Chief sees its attached MCP and skill', () => send(chief().id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(sees), `Chief reported ${report}`)
})

const capabilityRoom = await api('create-room', { name: 'Capability smoke', members: [chief().id, botNamed('Coder').id], admin: chief().id })
await step('Chief first group turn sees its attached MCP and skill', () => send(capabilityRoom.id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(sees), `Chief reported ${report} in the group`)
})

await step('Coder does not inherit Chief capabilities', () => send(botNamed('Coder').id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Coder')
  return expect(report?.endsWith(seesNothing), `Coder reported ${report}`)
})

await attach(chief(), echoName, false)
await attach(chief(), skillName, false)
await step('detached capabilities disappear from Chief', () => send(chief().id, '查能力 smoke'), (_value, calls) => {
  const report = reportOf(calls, 'Chief')
  return expect(report?.endsWith(seesNothing), `Chief reported ${report}`)
})

await api('recipe-save', {
  name: 'smoke-recipe',
  description: 'Smoke test recipe',
  template: 'Review {{target}} and report one concrete risk.',
  inputs: [{ name: 'target', description: 'File to review', required: true }],
})
await api('bot-recipe', { botId: chief().id, name: 'smoke-recipe', attached: true })
await step('Chief lists and runs an attached recipe', () => send(chief().id, '列出配方'), (_value, calls) => {
  return expect(saidText(calls, /配方列表：.*smoke-recipe.*attached to you/), 'recipe_list did not show the attached recipe')
})
await step('recipe_run expands parameters without executing code', () => send(chief().id, '运行配方'), (_value, calls) => {
  return expect(saidText(calls, /配方：<recipe_content name="smoke-recipe".*Review README and report one concrete risk\./), 'recipe_run did not expand the template')
})
await step('plugin inventory is readable and profile-scoped', async () => {
  const inventory = await api('plugin-inventory', { fresh: true })
  return expect(inventory.scope === 'profile' && inventory.readOnly === true && Array.isArray(inventory.entries),
    `unexpected plugin inventory ${JSON.stringify(inventory).slice(0, 300)}`)
})

let smokeSchedule
await step('a scheduled task can be created, edited and inspected', async () => {
  const created = await api('schedule-create', {
    target: chief().id,
    title: 'Smoke schedule',
    prompt: 'Check the smoke bench',
    when: { kind: 'every', seconds: 3600 },
  })
  smokeSchedule = created.tasks.find(task => task.title === 'Smoke schedule')
  if (!smokeSchedule) return 'schedule-create did not return the task'
  const updated = await api('schedule-update', {
    sessionId: smokeSchedule.sessionId,
    id: smokeSchedule.id,
    expected: smokeSchedule,
    title: 'Smoke schedule edited',
    prompt: 'Check the edited smoke bench',
    when: { kind: 'cron', expression: '0 9 * * *', timeZone: 'UTC' },
  })
  const task = updated.tasks.find(item => item.id === smokeSchedule.id)
  const history = await api('schedule-history', { sessionId: smokeSchedule.sessionId, id: smokeSchedule.id, limit: 5 })
  return expect(task?.title === 'Smoke schedule edited', `schedule edit returned ${JSON.stringify(task)}`)
    ?? expect(task?.kind === 'cron' && task.expression === '0 9 * * *', `edited timing is ${JSON.stringify(task)}`)
    ?? expect(Array.isArray(history.records) && history.records.length === 0, 'new schedule should have no delivery records')
})
await step('the scheduled task can be deleted', async () => {
  const value = await api('schedule-delete', { sessionId: smokeSchedule.sessionId, id: smokeSchedule.id })
  return expect(!value.tasks.some(task => task.id === smokeSchedule.id), 'deleted schedule is still listed')
})

let smokeAutomation
await step('an event automation can be created and listed', async () => {
  smokeAutomation = await api('automation-save', {
    name: 'Smoke event',
    triggerKind: 'user_message',
    sourceBot: 'Coder',
    targetKind: 'bot',
    target: 'Chief',
    prompt: 'Automation smoke saw: {{text}}',
    cooldownSeconds: 0,
    enabled: true,
  })
  const value = await api('automations')
  return expect(value.rules.some(rule => rule.id === smokeAutomation.id && rule.sourceBotName === 'Coder'),
    `automation is missing from ${JSON.stringify(value).slice(0, 300)}`)
})
await step('the event automation wakes its target once', () => send(botNamed('Coder').id, '自动化冒烟'), (_value, calls) => {
  return expect(calls.some(call => JSON.stringify(call).includes('Automation smoke saw')), 'the target did not receive the automation prompt')
})
await step('the event automation can be deleted', async () => {
  await api('automation-delete', { id: smokeAutomation.id })
  const value = await api('automations')
  return expect(!value.rules.some(rule => rule.id === smokeAutomation.id), 'deleted automation is still listed')
})

let smokeIntegration
await step('a signed GitHub webhook reaches its target Bot', async () => {
  smokeIntegration = await api('integration-save', {
    provider: 'github',
    name: 'Smoke GitHub',
    targetKind: 'bot',
    target: 'Chief',
    events: 'issues',
    repos: 'zp-innovation/DeepSeek-Bot',
    secret: 'smoke-webhook-secret',
    enabled: true,
  })
  const body = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'zp-innovation/DeepSeek-Bot' },
    sender: { login: 'smoke' },
    issue: { number: 7, title: 'Integration smoke event', html_url: 'https://github.com/zp-innovation/DeepSeek-Bot/issues/7' },
  })
  const signature = createHmac('sha256', 'smoke-webhook-secret').update(body).digest('hex')
  const response = await fetch(`http://127.0.0.1:${port}/api/integrations/github/${smokeIntegration.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
      'x-github-delivery': 'smoke-delivery-1',
      'x-github-event': 'issues',
    },
    body,
  })
  return response.status
}, status => expect(status === 202, `webhook answered ${status}`))
await step('the GitHub webhook delivery completes its Bot turn', () => {
  const item = state().integrations?.items?.[smokeIntegration.id]
  return item?.lastDelivery?.status
}, status => expect(status === 'completed', `delivery status is ${status}`))
await step('the smoke GitHub integration can be deleted', async () => {
  await api('integration-delete', { id: smokeIntegration.id })
  return expect(state().integrations?.items?.[smokeIntegration.id] === undefined, 'deleted integration is still listed')
})

await step('Chief creates a named checkpoint', () => send(chief().id, '创建检查点'), (_value, calls) => {
  return expect(saidText(calls, /检查点：Checkpoint saved: smoke-checkpoint/), 'checkpoint_create did not save the checkpoint')
})
await step('Chief lists its checkpoints', () => send(chief().id, '列出检查点'), (_value, calls) => {
  return expect(saidText(calls, /检查点列表：.*smoke-checkpoint/), 'checkpoint_list did not show the checkpoint')
})
let beforeTimeTravel
await step('Chief prepares time travel', () => {
  beforeTimeTravel = chief().sessionId ?? chief().id
  return send(chief().id, '时间旅行')
}, (_value, calls) => {
  return expect(saidText(calls, /时间旅行：Branch prepared from smoke-checkpoint/), 'time_travel did not prepare a branch')
})
await step('Chief switches to the time-travel branch', async () => {
  for (const deadline = Date.now() + 5_000; Date.now() < deadline; await sleep(100)) {
    const current = chief()
    const old = (current.segments ?? []).find(segment => segment.sessionId === beforeTimeTravel && segment.reason === 'time-travel')
    if (current.sessionId !== beforeTimeTravel && old !== undefined) return { switched: true, old: true }
  }
  const current = chief()
  return { switched: current.sessionId !== beforeTimeTravel, old: (current.segments ?? []).some(segment => segment.sessionId === beforeTimeTravel && segment.reason === 'time-travel') }
}, result => {
  return expect(result.switched, 'time_travel did not switch the Bot conversation')
    ?? expect(result.old, 'the old conversation was not kept as the earlier branch')
})
await step('Chief answers in the time-travel branch', () => send(chief().id, '你好'), (_value, calls) => {
  return expect(saidText(calls, /^收到：你好/), 'the time-travel branch did not answer')
})

await step('observability summarizes real turns, tools and model calls', () => api('observability', { hours: 24 }), value => {
  return expect(value.summary.turns > 0, `no turns in observability (${JSON.stringify(value.summary)})`)
    ?? expect(value.summary.toolCalls > 0, 'no tool calls in observability')
    ?? expect(value.summary.modelCalls > 0, 'no model calls in observability')
    ?? expect(value.recent.length > 0, 'no recent traces')
})
await step('observability exports its trace records', () => api('observability-export'), value => {
  return expect(value.resource?.service?.name === 'ds-bot', 'wrong export resource')
    ?? expect(Array.isArray(value.records) && value.records.some(record => record.kind === 'trace'), 'export has no traces')
})

let smokeEval
await step('an evaluation suite runs in an isolated Session', async () => {
  smokeEval = await api('eval-save', {
    name: 'Smoke evaluation',
    description: 'Checks one deterministic mock answer',
    targetBotId: chief().id,
    cases: [{
      name: 'Greeting',
      prompt: '你好',
      contains: '收到：你好',
      maxDurationMs: 60_000,
      maxTokens: 20_000,
    }],
  })
  await api('eval-run', { id: smokeEval.id })
  for (const deadline = Date.now() + STEP_TIMEOUT_MS; Date.now() < deadline; await sleep(500)) {
    const view = await api('evaluations')
    const run = view.runs.find(item => item.suiteId === smokeEval.id)
    if (run !== undefined && run.status !== 'running') return run
  }
  throw new Error('evaluation did not finish')
}, run => {
  return expect(run?.status === 'completed', `evaluation ended as ${run?.status}`)
    ?? expect(run.results?.[0]?.status === 'passed', `case checks: ${JSON.stringify(run?.results?.[0]?.checks)}`)
    ?? expect(run.results?.[0]?.output?.includes('收到：你好'), 'evaluation answer is missing from its result')
})
await step('the evaluation suite can be deleted', async () => {
  await api('eval-delete', { id: smokeEval.id })
  const view = await api('evaluations')
  return expect(!view.suites.some(suite => suite.id === smokeEval.id), 'deleted suite is still listed')
})

if (outFile) writeFileSync(outFile, `${JSON.stringify(transcript, null, 2)}\n`)
console.log(failures.length === 0 ? `\nsmoke: all ${transcript.length} steps passed` : `\nsmoke: ${failures.length} failed\n${failures.join('\n')}`)
process.exit(failures.length === 0 ? 0 : 1)
