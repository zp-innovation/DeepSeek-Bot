import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install, parseGitHubRemote } from '../src/host/coding.js'

const exec = (sessionId = 'b1') => ({ agent: { id: sessionId, session: { id: sessionId } }, signal: new AbortController().signal })

function setup({ results = {}, approval = true, botSession = () => true, fetchImpl, services = {} } = {}) {
  const ctx = fakeContext({ services })
  const commands = []
  const approvals = []
  const rt = {
    ctx,
    state: {},
    sessionFolder: () => 'C:\\work\\repo',
    isBotSession: botSession,
    load: async () => {},
    loadSecrets: async () => {},
    secretValue: () => 'token',
    redactSecrets: value => value,
    warn() {},
    approveCoding: async (_exec, tool, reason) => {
      approvals.push({ tool, reason })
      if (approval !== true) throw new Error('not approved')
    },
  }
  if (fetchImpl !== undefined) rt.codingFetch = fetchImpl
  rt.runCodingShell = async ({ command }) => {
    commands.push(command)
    const value = results[command] ?? results[command.replace(/'/g, '"')] ?? ''
    return typeof value === 'function' ? value(command) : value
  }
  install(rt)
  return { ctx, rt, commands, approvals, tool: (name, args, runExec = exec()) => ctx.registeredTools.get(name).execute(args, runExec) }
}

const git = (root, ...args) => ['git', '-C', `'${root}'`, ...args.map(arg => `'${String(arg).replace(/'/g, "''")}'`)].join(' ')
const response = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json' },
})

test('GitHub remotes are read from HTTPS and SSH forms', () => {
  assert.deepEqual(parseGitHubRemote('https://github.com/zp-innovation/DeepSeek-Bot.git'), { owner: 'zp-innovation', repo: 'DeepSeek-Bot' })
  assert.deepEqual(parseGitHubRemote('git@github.com:zp-innovation/DeepSeek-Bot.git'), { owner: 'zp-innovation', repo: 'DeepSeek-Bot' })
  assert.throws(() => parseGitHubRemote('https://example.com/a/b.git'), /GitHub/)
})

test('repo_status reports root, branch, remotes, commits and diffs', async () => {
  const base = 'C:\\work\\repo'
  const { tool } = setup({
    results: {
      [git(base, 'rev-parse', '--show-toplevel')]: 'C:\\work\\repo\n[exit code: 0]',
      [git(base, 'status', '--short', '--branch')]: '## main...origin/main\n M src/a.js\n[exit code: 0]',
      [git(base, 'remote', '-v')]: 'origin https://github.com/zp-innovation/DeepSeek-Bot.git (fetch)\n[exit code: 0]',
      [git(base, 'log', '-5', '--oneline', '--decorate')]: 'abc123 latest\n[exit code: 0]',
      [git(base, 'diff', '--stat')]: ' src/a.js | 2 +-\n[exit code: 0]',
      [git(base, 'diff', '--cached', '--stat')]: '[exit code: 0]',
    },
  })
  const text = await tool('repo_status', {})
  assert.match(text, /Repository: C:\\work\\repo/)
  assert.match(text, /## main\.\.\.origin\/main/)
  assert.match(text, /origin https:\/\/github\.com/)
  assert.match(text, /abc123 latest/)
  assert.match(text, /src\/a\.js \| 2/)
})

test('repo_diff rejects paths outside the repository', async () => {
  const { tool } = setup({ results: { [git('C:\\work\\repo', 'rev-parse', '--show-toplevel')]: 'C:\\work\\repo\n[exit code: 0]' } })
  await assert.rejects(() => tool('repo_diff', { paths: ['../secret'] }), /inside the repository/)
  await assert.rejects(() => tool('repo_diff', { paths: ['C:\\secret'] }), /inside the repository/)
})

test('git_commit requires explicit paths or all, asks for approval, and commits', async () => {
  const base = 'C:\\work\\repo'
  const { approvals, tool } = setup({
    results: {
      [git(base, 'rev-parse', '--show-toplevel')]: 'C:\\work\\repo\n[exit code: 0]',
      [git(base, 'add', '--', 'src/a.js')]: '[exit code: 0]',
      [git(base, 'diff', '--cached', '--name-only', '--', 'src/a.js')]: 'src/a.js\n[exit code: 0]',
      [git(base, 'commit', '--only', '-m', 'fix: update a', '--', 'src/a.js')]: '[main abc123] fix: update a\n[exit code: 0]',
      [git(base, 'log', '-1', '--oneline')]: 'abc123 fix: update a\n[exit code: 0]',
      [git(base, 'status', '--short', '--branch')]: '## main\n[exit code: 0]',
    },
  })
  await assert.rejects(() => tool('git_commit', { message: 'fix: update a' }), /set all: true/)
  const text = await tool('git_commit', { message: 'fix: update a', paths: ['src/a.js'] })
  assert.match(text, /Commit created/)
  assert.deepEqual(approvals.map(item => item.tool), ['git_commit'])
})

test('git_push refuses a non-origin remote syntax and approves the push', async () => {
  const base = 'C:\\work\\repo'
  const { approvals, tool } = setup({
    results: {
      [git(base, 'rev-parse', '--show-toplevel')]: 'C:\\work\\repo\n[exit code: 0]',
      [git(base, 'branch', '--show-current')]: 'feat/coding\n[exit code: 0]',
      [git(base, 'push', 'origin', 'feat/coding')]: 'pushed\n[exit code: 0]',
      [git(base, 'status', '--short', '--branch')]: '## feat/coding...origin/feat/coding\n[exit code: 0]',
    },
  })
  await assert.rejects(() => tool('git_push', { remote: 'bad remote' }), /safe Git remote/)
  const text = await tool('git_push', {})
  assert.match(text, /Push finished/)
  assert.match(text, /origin\/feat\/coding/)
  assert.deepEqual(approvals.map(item => item.tool), ['git_push'])
})

test('a shell timeout is never reported as a successful Git operation', async () => {
  const base = 'C:\\work\\repo'
  const { approvals, tool } = setup({
    results: {
      [git(base, 'rev-parse', '--show-toplevel')]: `${base}\n[exit code: 0]`,
      [git(base, 'branch', '--show-current')]: 'feat/coding\n[exit code: 0]',
      [git(base, 'push', 'origin', 'feat/coding')]: 'partial output\n[timed out after 120000ms]',
    },
  })
  await assert.rejects(() => tool('git_push', {}), /timed out/)
  assert.deepEqual(approvals.map(item => item.tool), ['git_push'])
})

test('a persistent pwsh timeout is never reported as success', async () => {
  const base = 'C:\\work\\repo'
  const { tool } = setup({
    results: {
      [git(base, 'rev-parse', '--show-toplevel')]: `${base}\n[exit code: 0]`,
      [git(base, 'branch', '--show-current')]: 'feat/coding\n[exit code: 0]',
      [git(base, 'push', 'origin', 'feat/coding')]: 'partial output\nYour command timed out after 120 seconds or experienced an OOM error. Below is partial output:\nThe persistent pwsh shell was reset',
    },
  })
  await assert.rejects(() => tool('git_push', {}), /timed out/)
})

test('create_worktree creates an isolated checkout and enters it', async () => {
  const root = 'C:\\work\\repo'
  const path = join(root, '.agents', 'worktrees', 'ds-bot-task')
  const base = 'abc1234'
  const entered = []
  const mkdir = process.platform === 'win32'
    ? `[IO.Directory]::CreateDirectory('${join(root, '.agents', 'worktrees').replace(/'/g, "''")}') | Out-Null`
    : `mkdir -p -- '${join(root, '.agents', 'worktrees').replace(/'/g, "'\\''")}'`
  const { tool } = setup({
    results: {
      [git(root, 'rev-parse', '--show-toplevel')]: `${root}\n[exit code: 0]`,
      [git(root, 'check-ref-format', '--branch', 'ds-bot/task')]: '[exit code: 0]',
      [git(root, 'rev-parse', '--verify', '--end-of-options', 'HEAD^{commit}')]: `${base}\n[exit code: 0]`,
      [git(root, 'show-ref', '--verify', '--quiet', 'refs/heads/ds-bot/task')]: '[exit code: 1]',
      [mkdir]: '[exit code: 0]',
      [git(root, 'config', '--name-only', '--get-regexp', '^filter\\.')]: 'filter.lfs.smudge\n[exit code: 0]',
      [git(root, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'worktree', 'add', '--no-checkout', '-b', 'ds-bot/task', '--', path, base)]: `Preparing ${path}\n[exit code: 0]`,
      [git(path, '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'filter.lfs.smudge=', '-c', 'filter.lfs.process=', '-c', 'filter.lfs.required=false', '--work-tree', path, 'reset', '--hard', '--no-recurse-submodules', base)]: 'HEAD is now at abc1234\n[exit code: 0]',
    },
    services: {
      workingDirectory: {
        set: async (_agent, next) => {
          entered.push(next)
          return next
        },
      },
    },
  })
  const text = await tool('create_worktree', { name: 'ds-bot/task' })
  assert.match(text, /Worktree created/)
  assert.match(text, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.deepEqual(entered, [path])
})

test('list_worktrees reads the repository worktree registry', async () => {
  const root = 'C:\\work\\repo'
  const { tool } = setup({
    results: {
      [git(root, 'rev-parse', '--show-toplevel')]: `${root}\n[exit code: 0]`,
      [git(root, 'worktree', 'list', '--porcelain')]: `worktree ${root}\nHEAD abc1234\nbranch refs/heads/main\n\n[exit code: 0]`,
    },
  })
  const text = await tool('list_worktrees', {})
  assert.match(text, /branch refs\/heads\/main/)
})

test('pull_request creates one approved PR through the GitHub API', async () => {
  const root = 'C:\\work\\repo'
  const calls = []
  const { approvals, tool } = setup({
    results: {
      [git(root, 'rev-parse', '--show-toplevel')]: `${root}\n[exit code: 0]`,
      [git(root, 'branch', '--show-current')]: 'feat/coding\n[exit code: 0]',
      [git(root, 'config', '--get', 'remote.origin.url')]: 'https://github.com/zp-innovation/DeepSeek-Bot.git\n[exit code: 0]',
    },
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body === undefined ? undefined : JSON.parse(init.body) })
      if (url.endsWith('/repos/zp-innovation/DeepSeek-Bot')) return response({ default_branch: 'main' })
      if (url.includes('/pulls?state=open&head=')) return response([])
      if (url.endsWith('/pulls') && init.method === 'POST') {
        return response({ number: 41, title: 'Codex-grade coding', html_url: 'https://github.com/zp-innovation/DeepSeek-Bot/pull/41', state: 'open', head: { ref: 'feat/coding', label: 'zp-innovation:feat/coding' }, base: { ref: 'main' } }, 201)
      }
      return response({ message: 'unexpected request' }, 500)
    },
  })
  const text = await tool('pull_request', { action: 'create', title: 'Codex-grade coding', body: '' })
  assert.match(text, /Pull request created/)
  assert.match(text, /#41/)
  assert.deepEqual(approvals.map(item => item.tool), ['pull_request'])
  const post = calls.find(call => call.method === 'POST')
  assert.deepEqual(post.body, { title: 'Codex-grade coding', body: '', head: 'feat/coding', base: 'main', draft: false })
})

test('pull_request reads existing PR checks', async () => {
  const root = 'C:\\work\\repo'
  const { tool } = setup({
    results: {
      [git(root, 'rev-parse', '--show-toplevel')]: `${root}\n[exit code: 0]`,
      [git(root, 'branch', '--show-current')]: 'feat/coding\n[exit code: 0]',
      [git(root, 'config', '--get', 'remote.origin.url')]: 'git@github.com:zp-innovation/DeepSeek-Bot.git\n[exit code: 0]',
    },
    fetchImpl: async (url) => {
      if (url.includes('/pulls?state=open&head=')) {
        return response([{ number: 41, title: 'Codex-grade coding', html_url: 'https://github.com/zp-innovation/DeepSeek-Bot/pull/41', head: { sha: 'abc123', ref: 'feat/coding', label: 'zp-innovation:feat/coding' }, base: { ref: 'main' }, state: 'open' }])
      }
      if (url.includes('/commits/abc123/check-runs')) {
        return response({ check_runs: [{ name: 'test', status: 'completed', conclusion: 'success', html_url: 'https://github.com/check/1' }] })
      }
      if (url.includes('/commits/abc123/status')) {
        return response({ statuses: [{ context: 'lint', state: 'success', target_url: 'https://github.com/check/2' }] })
      }
      return response({ message: 'unexpected request' }, 500)
    },
  })
  const text = await tool('pull_request', { action: 'checks' })
  assert.match(text, /Checks for PR #41/)
  assert.match(text, /test: completed \/ success/)
  assert.match(text, /lint: success/)
})

test('pull_request view by number does not require a current branch', async () => {
  const root = 'C:\\work\\repo'
  const { commands, tool } = setup({
    results: {
      [git(root, 'rev-parse', '--show-toplevel')]: `${root}\n[exit code: 0]`,
      [git(root, 'config', '--get', 'remote.origin.url')]: 'https://github.com/zp-innovation/DeepSeek-Bot.git\n[exit code: 0]',
    },
    fetchImpl: async (url) => {
      if (url.endsWith('/repos/zp-innovation/DeepSeek-Bot/pulls/41')) {
        return response({ number: 41, title: 'Detached review', html_url: 'https://github.com/zp-innovation/DeepSeek-Bot/pull/41', head: { ref: 'feat/coding' }, base: { ref: 'main' }, state: 'open' })
      }
      return response({ message: 'unexpected request' }, 500)
    },
  })
  await assert.rejects(() => tool('pull_request', { action: 'view', number: 0 }), /positive integer/)
  const text = await tool('pull_request', { action: 'view', number: 41 })
  assert.match(text, /PR #41/)
  assert.equal(commands.some(command => command.includes('branch --show-current')), false)
})

test('the coding protocol is attached only to Bot sessions', () => {
  const { ctx } = setup({ botSession: id => id === 'b1' })
  const section = ctx.sections.get('bot-coding')
  assert.equal(section.order, 648)
  assert.match(section.text({ agent: { id: 'b1' } }), /Engineering work/)
  assert.equal(section.text({ agent: { id: 'agent-session' } }), '')
})
