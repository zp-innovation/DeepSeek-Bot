// Coding workflow: a Codex-grade loop over DSH's existing shell, sandbox and
// permission tools. This module adds repository inspection, diff review, commit,
// push and pull-request operations; it never bypasses the shell tool's sandbox.
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { textOf } from './text.js'
import { output } from './tools.js'

const SHELL_TIMEOUT_MS = 120_000
const GITHUB_API = 'https://api.github.com'
const GITHUB_TOKEN = 'GITHUB_TOKEN'
const MAX_TITLE = 200
const MAX_BODY = 30_000
const MAX_MESSAGE = 4_000
const REF = /^[A-Za-z0-9][A-Za-z0-9._/@{}^~:+-]{0,199}$/
const REMOTE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/

const CODING_PROTOCOL = [
  '# Engineering work',
  '- When the user asks for code, a repository change, debugging, tests, a commit, a push, or a pull request, work as a senior engineer, not as a note taker.',
  '- Start by inspecting the repository: call repo_status, read the relevant files, and read the nearest AGENTS.md, CONTRIBUTING and project instructions before editing.',
  '- For multi-step work, use todo_write and keep it current. State the concrete plan in the work itself, then execute it.',
  '- Make the smallest complete change that solves the task. Follow existing patterns and preserve unrelated user changes. Do not rewrite or revert work you did not make.',
  '- After editing, run the narrowest meaningful tests, lint or build first, then broaden when risk warrants it. If a check fails, read the error and fix it before claiming the work is done.',
  '- Before finishing, call repo_diff and review the actual diff. Check for accidental secrets, generated files, unrelated edits, missing tests and broken callers.',
  '- Never say that something is verified without command output or another concrete check. Say what was not run.',
  '- Use git_commit, git_push and pull_request only when the user asks for them. Never force-push, rewrite a pushed branch, or bypass hooks.',
  '- Use create_worktree when the user asks for isolation or a task should not disturb the current checkout. Use list_worktrees before reusing an existing checkout, and never delete work you did not create.',
  '- The shell tools are the execution boundary. Use them for commands, tests, formatters and Git; do not invent command results.',
].join('\n')

const shellName = () => (process.platform === 'win32' ? 'pwsh' : 'bash')

const shellQuote = (value) => {
  const text = String(value)
  return process.platform === 'win32'
    ? `'${text.replace(/'/g, "''")}'`
    : `'${text.replace(/'/g, "'\\''")}'`
}

const cleanRef = (value, label = 'ref') => {
  const text = String(value ?? '').trim()
  if (!REF.test(text)) throw new Error(`${label} is not a safe Git reference`)
  return text
}

const cleanRemote = (value) => {
  const text = String(value ?? '').trim()
  if (!REMOTE_NAME.test(text)) throw new Error('remote is not a safe Git remote name')
  return text
}

const cleanPath = (value) => {
  const text = String(value ?? '').trim()
  if (text === '' || text.length > 1_000) throw new Error('paths must be non-empty relative paths')
  if (text.includes('\0') || /[\r\n]/.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^[\\/]/.test(text) || /(^|[\\/])\.\.([\\/]|$)/.test(text)) {
    throw new Error(`path must stay inside the repository: ${text}`)
  }
  return text
}

const cleanMessage = (value, label, max) => {
  const text = String(value ?? '').trim()
  if (text === '') throw new Error(`${label} is required`)
  if (text.length > max) throw new Error(`${label} is longer than ${max} characters`)
  if (text.includes('\0')) throw new Error(`${label} contains a null byte`)
  return text
}

const parseShellResult = (value) => {
  const state = (text, exit, ok) => {
    const interrupted = /(?:^|\n)(?:Your command timed out after \d+ seconds|\[(?:timed out after \d+ms|Command timed out or OOM|still running after \d+ms|stopped:|killed by signal:|shell exited|shell killed by signal:))/m.test(text)
    return {
      text,
      exit: interrupted && exit === 0 ? 1 : exit,
      ok: ok && exit === 0 && !interrupted,
    }
  }
  if (value !== null && typeof value === 'object' && typeof value.text === 'string') {
    const exit = Number.isInteger(value.exit) ? value.exit : 0
    return state(value.text, exit, value.ok !== false)
  }
  const text = String(value ?? '')
  const matches = [...text.matchAll(/\[exit code:\s*(-?\d+)\]/g)]
  const exit = matches.length > 0 ? Number(matches.at(-1)[1]) : 0
  return state(text, exit, true)
}

const plainOutput = result => result.text.replace(/\[exit code:\s*-?\d+\]\s*$/gm, '').trim()

export function parseGitHubRemote(value) {
  const text = String(value ?? '').trim()
  const match = /^(?:https?:\/\/|ssh:\/\/git@|git@)github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i.exec(text)
  if (match === null) throw new Error('origin must be a GitHub HTTPS or SSH remote')
  return { owner: match[1], repo: match[2] }
}

export function install(rt) {
  const { ctx } = rt

  const botSession = id => rt.isBotSession?.(id) === true

  const runShell = async (exec, command, description, timeoutMs = SHELL_TIMEOUT_MS) => {
    if (typeof rt.runCodingShell === 'function') {
      return parseShellResult(await rt.runCodingShell({ command, description, timeoutMs, exec }))
    }
    if (typeof ctx.tools?.execute !== 'function') throw new Error('Coding tools need the DSH shell tool')
    const name = shellName()
    const served = typeof ctx.tools.schemas === 'function' ? ctx.tools.schemas(exec.agent) : []
    if (served.length > 0 && !served.some(schema => schema.name === name)) {
      throw new Error(`Coding tools need the ${name} tool, which this profile does not serve`)
    }
    const result = await ctx.tools.execute({
      callId: `${exec.callId ?? 'coding'}:${randomUUID()}`,
      ...(exec.rootCallId === undefined ? {} : { rootCallId: exec.rootCallId }),
      name,
      arguments: { command, description, timeoutMs },
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      ...(exec.token === undefined ? {} : { parent: exec.token }),
      signal: exec.signal === undefined
        ? AbortSignal.timeout(timeoutMs)
        : AbortSignal.any([exec.signal, AbortSignal.timeout(timeoutMs)]),
    })
    const text = textOf(result.content)
    if (result.isError) throw new Error(text || 'Shell command failed')
    return parseShellResult(text)
  }

  const approve = async (exec, toolName, reason) => {
    if (typeof rt.approveCoding === 'function') return rt.approveCoding(exec, toolName, reason)
    const approval = ctx.get?.('approval')
    if (approval?.request === undefined || exec.agent?.session === undefined) {
      throw new Error(`${toolName} needs the user's approval, and no approval channel is available`)
    }
    const outcome = await approval.request({
      agent: exec.agent,
      toolName,
      ...(exec.callId === undefined ? {} : { callId: exec.callId }),
      reason,
      displayReason: { en: reason, zh: reason },
      ...(exec.signal === undefined ? {} : { signal: exec.signal }),
    })
    if (outcome === 'allowed-once') return
    throw new Error(outcome === 'rejected' ? `${toolName} was not approved` : `${toolName} approval was cancelled`)
  }

  const gitCommand = (root, args) => ['git', '-C', shellQuote(root), ...args.map(shellQuote)].join(' ')

  const filterConfig = (output) => {
    const drivers = new Set()
    for (const key of String(output ?? '').split(/\r?\n/)) {
      const name = key.trim()
      if (!name.startsWith('filter.')) continue
      const at = name.lastIndexOf('.')
      if (at > 'filter.'.length) drivers.add(name.slice('filter.'.length, at))
    }
    return [...drivers].flatMap(driver => [
      '-c', `filter.${driver}.smudge=`,
      '-c', `filter.${driver}.process=`,
      '-c', `filter.${driver}.required=false`,
    ])
  }

  const repoRoot = async (exec) => {
    const cwd = rt.sessionFolder?.(exec.agent?.session ?? exec.agent)
    if (cwd === undefined) throw new Error('This Bot has no working folder')
    const result = await runShell(exec, gitCommand(cwd, ['rev-parse', '--show-toplevel']), 'Find Git repository root', 20_000)
    if (!result.ok) return { cwd, root: undefined, result }
    const root = result.text
      .split(/\r?\n/)
      .map(line => line.trim())
      .find(line => line !== '' && !line.startsWith('['))
    if (root === undefined) throw new Error('Git did not return a repository root')
    return { cwd, root, result }
  }

  const currentBranch = async (exec, root) => {
    const result = await runShell(exec, gitCommand(root, ['branch', '--show-current']), 'Read current Git branch', 20_000)
    if (!result.ok) throw new Error(result.text || 'Could not read the current branch')
    const branch = result.text.split(/\r?\n/).map(line => line.trim()).find(Boolean)
    if (branch === undefined || branch.startsWith('[')) throw new Error('The repository is not on a branch')
    return cleanRef(branch, 'branch')
  }

  const remoteUrl = async (exec, root, remote = 'origin') => {
    const result = await runShell(exec, gitCommand(root, ['config', '--get', `remote.${remote}.url`]), 'Read Git remote address', 20_000)
    if (!result.ok) throw new Error(result.text || `Git remote ${remote} is not configured`)
    const url = result.text.split(/\r?\n/).map(line => line.trim()).find(Boolean)
    if (url === undefined || url.startsWith('[')) throw new Error(`Git remote ${remote} has no URL`)
    return url
  }

  const githubContext = async (exec, branchArg, remoteArg, requireBranch = true) => {
    const { root } = await repoRoot(exec)
    if (root === undefined) throw new Error('Open a Git repository before using GitHub')
    const remote = cleanRemote(remoteArg ?? 'origin')
    const branch = branchArg !== undefined
      ? cleanRef(branchArg, 'branch')
      : requireBranch ? await currentBranch(exec, root) : undefined
    const { owner, repo } = parseGitHubRemote(await remoteUrl(exec, root, remote))
    await rt.loadSecrets?.()
    const token = rt.secretValue?.(GITHUB_TOKEN)
    if (typeof token !== 'string' || token === '') {
      throw new Error('Connect GitHub in Connectors first; GITHUB_TOKEN is not saved')
    }
    return { root, remote, branch, owner, repo, token }
  }

  const githubRequest = async (exec, context, path, { method = 'GET', body, accept = 'application/vnd.github+json' } = {}) => {
    const request = rt.codingFetch ?? fetch
    let response
    try {
      response = await request(`${GITHUB_API}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${context.token}`,
          accept,
          'x-github-api-version': '2022-11-28',
          'user-agent': 'ds-bot',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: exec.signal === undefined
          ? AbortSignal.timeout(30_000)
          : AbortSignal.any([exec.signal, AbortSignal.timeout(30_000)]),
      })
    } catch (error) {
      throw new Error(`Could not reach GitHub: ${rt.redactSecrets?.(String(error?.message ?? error)) ?? error}`)
    }
    const text = await response.text()
    let value = null
    try { value = text === '' ? null : JSON.parse(text) } catch { value = null }
    if (!response.ok) {
      const message = value?.message ?? text ?? `GitHub answered ${response.status}`
      throw new Error(`GitHub ${response.status}: ${rt.redactSecrets?.(String(message)) ?? message}`)
    }
    return value
  }

  const pullText = pr => [
    `${pr.draft ? 'Draft PR' : 'PR'} #${pr.number}: ${pr.title}`,
    `URL: ${pr.html_url}`,
    `Branch: ${pr.head?.label ?? pr.head?.ref ?? '?'} → ${pr.base?.ref ?? '?'}`,
    `State: ${pr.state ?? 'open'}${pr.mergeable_state ? ` · ${pr.mergeable_state}` : ''}`,
  ].join('\n')

  const repoStatusTool = defineTool({
    name: 'repo_status',
    description: 'Inspect the current Git repository before coding: root, branch, remotes, working-tree status, recent commits, and diff summary. Read-only; use this first for any repository task.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const found = await repoRoot(exec)
      if (found.root === undefined) return `No Git repository at ${found.cwd}.\n${found.result.text}`.trim()
      const root = found.root
      const status = await runShell(exec, gitCommand(root, ['status', '--short', '--branch']), 'Read Git working tree status', 20_000)
      const remotes = await runShell(exec, gitCommand(root, ['remote', '-v']), 'List Git remotes', 20_000)
      const log = await runShell(exec, gitCommand(root, ['log', '-5', '--oneline', '--decorate']), 'Read recent Git commits', 20_000)
      const unstaged = await runShell(exec, gitCommand(root, ['diff', '--stat']), 'Summarize unstaged changes', 20_000)
      const staged = await runShell(exec, gitCommand(root, ['diff', '--cached', '--stat']), 'Summarize staged changes', 20_000)
      return [
        `Repository: ${root}`,
        '',
        'Working tree:',
        plainOutput(status) || '(clean)',
        '',
        'Remotes:',
        plainOutput(remotes) || '(none)',
        '',
        'Recent commits:',
        plainOutput(log) || '(none)',
        '',
        'Unstaged diff:',
        plainOutput(unstaged) || '(none)',
        '',
        'Staged diff:',
        plainOutput(staged) || '(none)',
      ].join('\n')
    },
  })
  ctx.tools.register(repoStatusTool)

  ctx.tools.register(defineTool({
    name: 'repo_diff',
    description: 'Read the actual Git diff for unstaged changes, staged changes, or a branch comparison. Use it before claiming work is done and before committing.',
    parameters: {
      scope: { type: 'string', enum: ['unstaged', 'staged', 'branch'], description: 'Which changes to show; default unstaged' },
      base: { type: 'string', description: 'Base branch or commit for scope "branch", such as main or origin/dev' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Optional repository-relative paths to narrow the diff' },
      stat: { type: 'boolean', description: 'Show only a diffstat' },
      check: { type: 'boolean', description: 'Also run git diff --check for whitespace errors' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      await rt.load()
      const scope = args.scope ?? 'unstaged'
      const paths = (Array.isArray(args.paths) ? args.paths : []).map(cleanPath)
      const { root } = await repoRoot(exec)
      if (root === undefined) throw new Error('Not in a Git repository')
      const flags = ['diff', '--no-ext-diff', '--no-color']
      if (scope === 'staged') flags.push('--cached')
      if (scope === 'branch') {
        if (typeof args.base !== 'string' || args.base.trim() === '') throw new Error('base is required for scope "branch"')
        flags.push(`${cleanRef(args.base, 'base')}...HEAD`)
      }
      if (args.stat === true) flags.push('--stat')
      if (paths.length > 0) flags.push('--', ...paths)
      const diff = await runShell(exec, gitCommand(root, flags), 'Read Git diff', 30_000)
      if (!diff.ok) throw new Error(diff.text || 'git diff failed')
      const lines = [plainOutput(diff) || 'No changes.']
      if (args.check === true) {
        const check = await runShell(exec, gitCommand(root, ['diff', '--check', ...(paths.length > 0 ? ['--', ...paths] : [])]), 'Check Git diff whitespace', 20_000)
        lines.push('', 'Diff check:', plainOutput(check) || '(clean)')
      }
      return lines.join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'create_worktree',
    description: 'Create an isolated Git branch and worktree from a local commit, then make it this Session\'s working directory. Uses the active DSH filesystem, subprocess and sandbox providers. Existing branches or paths fail. Uncommitted source changes stay in the original checkout.',
    parameters: {
      name: { type: 'string', description: 'New branch name; defaults to ds-bot/<uuid>' },
      from: { type: 'string', description: 'Local commit, branch or tag; defaults to HEAD. No fetch is performed' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (exec.agent === undefined) throw new Error('create_worktree requires an owning agent session')
      const name = args.name === undefined ? `ds-bot/${randomUUID()}` : cleanRef(args.name, 'worktree name')
      const from = args.from === undefined ? 'HEAD' : cleanRef(args.from, 'worktree base')
      const { root } = await repoRoot(exec)
      if (root === undefined) throw new Error('Not in a Git repository')
      const checked = await runShell(exec, gitCommand(root, ['check-ref-format', '--branch', name]), 'Validate worktree branch', 20_000)
      if (!checked.ok) throw new Error(checked.text || `Invalid worktree branch ${name}`)
      const resolved = await runShell(exec, gitCommand(root, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`]), 'Resolve worktree base', 20_000)
      if (!resolved.ok) throw new Error(resolved.text || `Cannot resolve worktree base ${from}`)
      const baseCommit = plainOutput(resolved).split(/\r?\n/).at(-1)
      if (baseCommit === undefined || !/^[0-9a-f]{7,64}$/i.test(baseCommit)) throw new Error('Git did not return a worktree base commit')
      const existing = await runShell(exec, gitCommand(root, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`]), 'Check worktree branch', 20_000)
      if (existing.ok) throw new Error(`Branch already exists: ${name}`)
      const leaf = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || randomUUID()
      const pool = join(root, '.agents', 'worktrees')
      const path = join(pool, leaf)
      const createPool = process.platform === 'win32'
        ? `[IO.Directory]::CreateDirectory(${shellQuote(pool)}) | Out-Null`
        : `mkdir -p -- ${shellQuote(pool)}`
      const made = await runShell(exec, createPool, 'Create worktree pool', 20_000)
      if (!made.ok) throw new Error(made.text || 'Could not create the worktree pool')
      const fs = ctx.get?.('fs')
      if (fs?.resolve !== undefined && fs?.stat !== undefined && fs?.writeText !== undefined) {
        const ignore = await fs.resolve(join(pool, '.gitignore'), { cwd: root, signal: exec.signal })
        const writePolicy = ctx.get?.('sandboxPolicy')?.resolve?.({ session: exec.agent.session })
        if (await fs.stat(ignore, exec.signal) === undefined) await fs.writeText(ignore, '*\n', undefined, exec.signal, writePolicy)
      }
      const configured = await runShell(exec, gitCommand(root, ['config', '--name-only', '--get-regexp', '^filter\\.']), 'Read Git filter drivers', 20_000)
      const filters = configured.ok ? filterConfig(plainOutput(configured)) : []
      const added = await runShell(exec, gitCommand(root, [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false',
        'worktree', 'add', '--no-checkout', '-b', name, '--', path, baseCommit,
      ]), 'Create Git worktree', 120_000)
      if (!added.ok) throw new Error(added.text || 'git worktree add failed')
      const reset = await runShell(exec, gitCommand(path, [
        '-c', 'core.hooksPath=/dev/null',
        '-c', 'core.fsmonitor=false',
        ...filters,
        '--work-tree', path,
        'reset', '--hard', '--no-recurse-submodules', baseCommit,
      ]), 'Populate Git worktree', 120_000)
      if (!reset.ok) throw new Error(`${reset.text || 'Could not populate the worktree'}\nThe branch and checkout remain at ${path}.`)
      const workingDirectory = ctx.get?.('workingDirectory')
      if (workingDirectory?.set === undefined) throw new Error(`Worktree created at ${path}, but this profile cannot change the Session directory`)
      const current = await workingDirectory.set(exec.agent, path, exec.signal)
      return [
        'Worktree created.',
        `Path: ${current}`,
        `Branch: ${name}`,
        `Base commit: ${baseCommit}`,
        `Repository: ${root}`,
      ].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'list_worktrees',
    description: 'List every Git worktree registered by the current repository. Read-only.',
    parameters: {},
    output,
    isConcurrencySafe: () => true,
    async execute(_args, exec) {
      await rt.load()
      const { root } = await repoRoot(exec)
      if (root === undefined) throw new Error('Not in a Git repository')
      const listed = await runShell(exec, gitCommand(root, ['worktree', 'list', '--porcelain']), 'List Git worktrees', 20_000)
      if (!listed.ok) throw new Error(listed.text || 'git worktree list failed')
      return plainOutput(listed) || '(no worktrees)'
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_commit',
    description: 'Stage explicitly chosen paths or all changes, then create one ordinary Git commit. Requires user approval. Never bypasses hooks and never rewrites history.',
    parameters: {
      message: { type: 'string', required: true, description: 'Commit subject and optional body' },
      paths: { type: 'array', items: { type: 'string' }, description: 'Repository-relative paths to stage; omit only with all: true' },
      all: { type: 'boolean', description: 'Stage every tracked and untracked change explicitly' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const message = cleanMessage(args.message, 'commit message', MAX_MESSAGE)
      const paths = (Array.isArray(args.paths) ? args.paths : []).map(cleanPath)
      if (paths.length === 0 && args.all !== true) throw new Error('Name the paths to stage, or set all: true')
      const { root } = await repoRoot(exec)
      if (root === undefined) throw new Error('Not in a Git repository')
      await approve(exec, 'git_commit', `Commit ${args.all === true ? 'all changes' : `${paths.length} selected path(s)`} with message: ${message.split('\n')[0]}`)
      const add = args.all === true
        ? await runShell(exec, gitCommand(root, ['add', '-A']), 'Stage all repository changes', 30_000)
        : await runShell(exec, gitCommand(root, ['add', '--', ...paths]), 'Stage selected repository changes', 30_000)
      if (!add.ok) throw new Error(add.text || 'git add failed')
      const names = await runShell(exec, gitCommand(root, [
        'diff', '--cached', '--name-only',
        ...(args.all === true ? [] : ['--', ...paths]),
      ]), 'List staged changes', 20_000)
      if (!names.ok) throw new Error(names.text || 'Could not read staged changes')
      if (names.text.replace(/\[exit code:\s*\d+\]/g, '').trim() === '') return 'Nothing staged; no commit was created.'
      const commit = await runShell(exec, gitCommand(root, [
        'commit',
        ...(args.all === true ? [] : ['--only']),
        '-m', message,
        ...(args.all === true ? [] : ['--', ...paths]),
      ]), 'Create Git commit', 120_000)
      if (!commit.ok) throw new Error(commit.text || 'git commit failed')
      const after = await runShell(exec, gitCommand(root, ['status', '--short', '--branch']), 'Read status after commit', 20_000)
      const last = await runShell(exec, gitCommand(root, ['log', '-1', '--oneline']), 'Read created commit', 20_000)
      return ['Commit created.', plainOutput(last), '', 'Working tree:', plainOutput(after) || '(clean)'].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'git_push',
    description: 'Push the current branch to a Git remote. Requires user approval. Never force-pushes or rewrites a pushed branch.',
    parameters: {
      remote: { type: 'string', description: 'Remote name; default origin' },
      branch: { type: 'string', description: 'Branch to push; default the current branch' },
      setUpstream: { type: 'boolean', description: 'Set the upstream tracking branch while pushing' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      const remote = cleanRemote(args.remote ?? 'origin')
      const requestedBranch = args.branch === undefined ? undefined : cleanRef(args.branch, 'branch')
      const { root } = await repoRoot(exec)
      if (root === undefined) throw new Error('Not in a Git repository')
      const branch = requestedBranch ?? await currentBranch(exec, root)
      await approve(exec, 'git_push', `Push ${branch} to ${remote}${args.setUpstream === true ? ' and set upstream' : ''}`)
      const flags = ['push', ...(args.setUpstream === true ? ['--set-upstream'] : []), remote, branch]
      const pushed = await runShell(exec, gitCommand(root, flags), 'Push Git branch', 120_000)
      if (!pushed.ok) throw new Error(pushed.text || 'git push failed')
      const status = await runShell(exec, gitCommand(root, ['status', '--short', '--branch']), 'Read status after push', 20_000)
      return ['Push finished.', plainOutput(pushed), '', 'Working tree:', plainOutput(status) || '(clean)'].join('\n')
    },
  }))

  ctx.tools.register(defineTool({
    name: 'pull_request',
    description: 'View, create, update, or inspect checks for a GitHub pull request. Create and update require user approval. The GitHub token stays in the host.',
    parameters: {
      action: { type: 'string', required: true, enum: ['view', 'create', 'update', 'checks'], description: 'Pull-request operation' },
      title: { type: 'string', description: 'PR title for create or update' },
      body: { type: 'string', description: 'PR body for create or update' },
      base: { type: 'string', description: 'Base branch; default the repository default branch' },
      branch: { type: 'string', description: 'Head branch; default the current branch' },
      remote: { type: 'string', description: 'Git remote name; default origin' },
      number: { type: 'integer', description: 'PR number for view, update, or checks' },
      draft: { type: 'boolean', description: 'Create the PR as a draft' },
    },
    output,
    async execute(args, exec) {
      await rt.load()
      if (args.number !== undefined && (!Number.isInteger(args.number) || args.number <= 0)) {
        throw new Error('number must be a positive integer')
      }
      const needsBranch = args.action === 'create'
        || ((args.action === 'view' || args.action === 'checks') && args.number === undefined)
      const context = await githubContext(exec, args.branch, args.remote, needsBranch)
      const baseRepo = `/repos/${context.owner}/${context.repo}`
      const existing = async () => {
        const list = await githubRequest(exec, context, `${baseRepo}/pulls?state=open&head=${encodeURIComponent(`${context.owner}:${context.branch}`)}`)
        return Array.isArray(list) ? list[0] : undefined
      }

      if (args.action === 'view') {
        const pr = args.number === undefined
          ? await existing()
          : await githubRequest(exec, context, `${baseRepo}/pulls/${args.number}`)
        return pr === undefined ? `No open pull request for ${context.branch}.` : pullText(pr)
      }

      if (args.action === 'checks') {
        const pr = args.number === undefined ? await existing() : await githubRequest(exec, context, `${baseRepo}/pulls/${args.number}`)
        if (pr === undefined) return `No open pull request for ${context.branch}; no checks to read.`
        const ref = pr.head?.sha
        if (typeof ref !== 'string') return `PR #${pr.number} has no head commit yet.`
        const [runs, statuses] = await Promise.all([
          githubRequest(exec, context, `${baseRepo}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`),
          githubRequest(exec, context, `${baseRepo}/commits/${encodeURIComponent(ref)}/status`),
        ])
        const checks = Array.isArray(runs?.check_runs) ? runs.check_runs : []
        const contexts = Array.isArray(statuses?.statuses) ? statuses.statuses : []
        const lines = checks.map(check => `- ${check.name}: ${check.status}${check.conclusion ? ` / ${check.conclusion}` : ''}${check.html_url ? ` · ${check.html_url}` : ''}`)
        lines.push(...contexts.map(status => `- ${status.context}: ${status.state}${status.target_url ? ` · ${status.target_url}` : ''}`))
        return [`Checks for PR #${pr.number}:`, ...(lines.length > 0 ? lines : ['- no checks reported'])].join('\n')
      }

      if (args.action === 'create') {
        const repoInfo = await githubRequest(exec, context, baseRepo)
        const base = args.base === undefined || args.base === '' ? repoInfo.default_branch : cleanRef(args.base, 'base')
        if (base === context.branch) throw new Error('The head branch and base branch must differ')
        const title = cleanMessage(args.title, 'PR title', MAX_TITLE)
        const body = args.body === undefined ? '' : String(args.body).trim()
        if (body.length > MAX_BODY) throw new Error(`PR body is longer than ${MAX_BODY} characters`)
        const found = await existing()
        if (found !== undefined) return `An open pull request already exists.\n${pullText(found)}`
        await approve(exec, 'pull_request', `Create a pull request from ${context.branch} into ${base}: ${title}`)
        const created = await githubRequest(exec, context, `${baseRepo}/pulls`, {
          method: 'POST',
          body: { title, body, head: context.branch, base, draft: args.draft === true },
        })
        return `Pull request created.\n${pullText(created)}`
      }

      if (args.action === 'update') {
        if (!Number.isInteger(args.number) || args.number <= 0) throw new Error('number is required to update a pull request')
        const base = args.base === undefined ? undefined : cleanRef(args.base, 'base')
        if (base !== undefined && base === context.branch) throw new Error('The head branch and base branch must differ')
        const patch = {
          ...(args.title === undefined ? {} : { title: cleanMessage(args.title, 'PR title', MAX_TITLE) }),
          ...(args.body === undefined ? {} : { body: String(args.body).trim() }),
          ...(base === undefined ? {} : { base }),
        }
        if (typeof patch.body === 'string' && patch.body.length > MAX_BODY) throw new Error(`PR body is longer than ${MAX_BODY} characters`)
        if (Object.keys(patch).length === 0) throw new Error('Nothing to update')
        await approve(exec, 'pull_request', `Update pull request #${args.number}`)
        const updated = await githubRequest(exec, context, `${baseRepo}/pulls/${args.number}`, { method: 'PATCH', body: patch })
        return `Pull request updated.\n${pullText(updated)}`
      }

      throw new Error(`Unknown pull_request action ${args.action}`)
    },
  }))

  ctx.systemPrompt.section({
    name: 'bot-coding',
    order: 648,
    interpolate: false,
    text: context => (botSession(context?.agent?.id) ? CODING_PROTOCOL : ''),
  })

  Object.assign(rt, { codingProtocol: CODING_PROTOCOL })
}
