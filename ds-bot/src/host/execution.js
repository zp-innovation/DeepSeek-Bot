// Execution status: the one read-only place that explains which execution world
// and file policy a Bot is really using. It probes confinement without running a
// command, so a status report cannot be confused with a successful test run.
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

const short = value => String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, 240)

const worktreePath = path => /(^|[\\/])\.agents[\\/]worktrees[\\/]/.test(path ?? '')

export function install(rt) {
  const { ctx } = rt

  ctx.tools.register(defineTool({
    name: 'execution_status',
    description: 'Inspect the current execution world, working directory, permission preset, sandbox mode and real enforcement. Read-only; does not run a command. Use when isolation, remote execution or worktrees matter.',
    parameters: {
      probe: { type: 'boolean', description: 'Resolve the sandbox backend and enforcement without executing a command; default true' },
    },
    output,
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) throw new Error('execution_status requires an owning agent session')
      const policy = ctx.get?.('sandboxPolicy')?.resolve?.({ session })
      const folder = ctx.get?.('workingDirectory')
      let workspace
      try {
        workspace = folder?.get?.(session) ?? session.header?.cwd
      } catch {
        workspace = session.header?.cwd
      }
      const permission = ctx.get?.('permissionPresets')
      let preset
      let knobs
      try {
        preset = permission?.current?.(session)
        if (preset !== undefined && permission?.resolve !== undefined) knobs = permission.resolve(preset)
      } catch {}

      const backend = ctx.get?.('ssh') === undefined ? 'local' : 'ssh (profile-managed)'
      const sandbox = ctx.get?.('sandbox')
      const mode = policy?.mode ?? 'unknown'
      let enforcement
      if (mode === 'danger-full-access') enforcement = 'not applied: danger-full-access explicitly bypasses file confinement'
      else if (args.probe === false) enforcement = 'not probed'
      else if (policy === undefined || sandbox?.confine === undefined) enforcement = 'unknown: this profile has no sandbox provider'
      else {
        const argv = process.platform === 'win32'
          ? [process.env.ComSpec ?? 'cmd.exe', '/c', 'ver']
          : ['true']
        try {
          const confined = await sandbox.confine(argv, policy, exec.signal)
          enforcement = confined.enforcement === 'full' ? 'full' : 'partial'
        } catch (error) {
          enforcement = `unavailable: ${short(error?.message ?? error)}`
        }
      }

      return [
        `Backend: ${backend}`,
        `Sandbox mode: ${mode}`,
        `Sandbox enforcement: ${enforcement}`,
        `Approval policy: ${knobs?.approval ?? 'unknown'}`,
        `Permission preset: ${preset ?? 'unknown'}`,
        `Workspace: ${workspace ?? '(unknown)'}`,
        `Shell: ${process.platform === 'win32' ? 'pwsh' : 'bash'}`,
        `Worktree: ${worktreePath(workspace) ? 'active in this Session' : 'available through create_worktree'}`,
      ].join('\n')
    },
  }))
}
