import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fakeContext } from './fake-ctx.js'
import { install } from '../src/host/execution.js'

function setup({ ssh = false, mode = 'workspace-write', enforcement = 'full', worktree = false, probeError } = {}) {
  const probes = []
  const services = {
    sandboxPolicy: {
      resolve: () => ({ mode, workspaceRoot: '/work/project' }),
    },
    permissionPresets: {
      current: () => 'workspace-write',
      resolve: () => ({ sandbox: mode, approval: 'ask' }),
    },
    workingDirectory: {
      get: () => worktree ? '/work/project/.agents/worktrees/task' : '/work/project',
    },
    sandbox: {
      confine: async (argv, policy, signal) => {
        probes.push({ argv, policy, signal })
        if (probeError !== undefined) throw probeError
        return { argv, enforcement, denialSignatures: [], runnerFailureRules: [] }
      },
    },
    ...(ssh ? { ssh: {} } : {}),
  }
  const ctx = fakeContext({ services })
  install({ ctx })
  const execute = (args = {}, signal = new AbortController().signal) => ctx.registeredTools.get('execution_status').execute(args, {
    agent: { id: 'b1', session: { id: 'b1', header: { cwd: '/work/project' } } },
    signal,
  })
  return { execute, probes }
}

test('execution_status reports the local sandbox, approval and real enforcement', async () => {
  const { execute, probes } = setup()
  const text = await execute()
  assert.match(text, /Backend: local/)
  assert.match(text, /Workspace: \/work\/project/)
  assert.match(text, /Permission preset: workspace-write/)
  assert.match(text, /Sandbox mode: workspace-write/)
  assert.match(text, /Sandbox enforcement: full/)
  assert.match(text, /Approval policy: ask/)
  assert.equal(probes.length, 1)
})

test('execution_status distinguishes an SSH profile and an active worktree', async () => {
  const text = await setup({ ssh: true, worktree: true }).execute()
  assert.match(text, /Backend: ssh \(profile-managed\)/)
  assert.match(text, /Worktree: active in this Session/)
})

test('execution_status reports danger-full-access and unavailable probes honestly', async () => {
  const full = setup({ mode: 'danger-full-access' })
  assert.match(await full.execute(), /Sandbox enforcement: not applied/)
  assert.equal(full.probes.length, 0)

  const failed = setup({ probeError: new Error('runner missing') })
  const text = await failed.execute()
  assert.match(text, /Sandbox enforcement: unavailable: runner missing/)
})
