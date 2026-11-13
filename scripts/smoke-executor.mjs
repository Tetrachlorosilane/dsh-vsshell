// Real-process smoke test for the vsshell executor.
//
// This is the ONLY script that starts a real bash. Run it with an unconfined
// token (`danger-full-access` in the harness): the Windows ACL sandbox runs
// children under a restricted token, where MSYS2 cannot create its signal pipe
// and WSL gets E_ACCESSDENIED — both were measured on this machine, so a smoke
// failure inside the default sandbox is an environment boundary, not a
// regression.
//
// Usage:
//   node scripts/smoke-executor.mjs
//   VSSHELL_SOURCE=wsl VSSHELL_DISTRO=Ubuntu node scripts/smoke-executor.mjs
//   VSSHELL_SOURCE=custom VSSHELL_BASH_PATH=D:\tools\bash.exe node scripts/smoke-executor.mjs
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import VsshellBashExecutor from '../lib/index.js'

const failures = []
let checks = 0

/** Assert one smoke expectation. */
function check(name, predicate, detail) {
  checks += 1
  if (predicate) {
    console.log(`ok   ${name}`)
    return
  }
  failures.push(name)
  console.log(`FAIL ${name}${detail === undefined ? '' : `: ${detail}`}`)
}

/** Create the minimal host the executor needs. */
async function startExecutor(config) {
  const ctx = new Context()
  // The executor injects `systemPrompt`; a host plugin always finds the real
  // registry, but this standalone app only needs the section API surface.
  ctx.provide('systemPrompt', {
    section: () => () => {},
    getSectionOrder: () => 1000,
  })
  // The executor injects `sandboxPolicy` (it mirrors the deployment default mode
  // for DSH permission-presets composition) and does not confine commands.
  ctx.provide('sandboxPolicy', {
    defaultMode: 'workspace-write',
    resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }),
  })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(VsshellBashExecutor, config)
  if (ctx.shell === undefined) throw new Error('executor did not register ctx.shell')
  if (ctx.shell.sandboxMode !== 'workspace-write') throw new Error('executor must mirror the deployment sandbox mode')
  return ctx
}

/** Resolve and run one command, returning its settled result. */
async function run(ctx, request) {
  const spec = ctx.shell.resolve(request)
  const process = await ctx.shell.execute(spec)
  return process.result()
}

const config = {
  source: process.env.VSSHELL_SOURCE ?? 'auto',
  bashPath: process.env.VSSHELL_BASH_PATH ?? '',
  wslDistro: process.env.VSSHELL_DISTRO ?? '',
  loginShell: (process.env.VSSHELL_LOGIN ?? '1') !== '0',
}

console.log(`smoke: source=${config.source} bashPath=${config.bashPath || '(auto)'} distro=${config.wslDistro || '(default)'} login=${String(config.loginShell)}`)
const ctx = await startExecutor(config)

try {
  const echo = await run(ctx, { command: 'echo hello-vsshell', workdir: process.cwd() })
  check('echo stdout', echo.stdout.text.trim() === 'hello-vsshell', JSON.stringify(echo.stdout.text))
  check('echo exit code', echo.exitCode === 0, String(echo.exitCode))

  const pwd = await run(ctx, { command: 'pwd', workdir: process.cwd() })
  check('pwd printed a path', pwd.stdout.text.trim() !== '', JSON.stringify(pwd.stderr.text))
  console.log(`     pwd -> ${pwd.stdout.text.trim()}`)

  const failed = await run(ctx, { command: 'exit 7' })
  check('exit code propagates', failed.exitCode === 7, String(failed.exitCode))
  check('exit code is not a timeout', failed.timedOut === false)

  const streams = await run(ctx, { command: 'printf "to-stdout\\n"; printf "to-stderr\\n" >&2' })
  check('stdout is captured', streams.stdout.text.includes('to-stdout'), JSON.stringify(streams.stdout.text))
  check('stderr is captured', streams.stderr.text.includes('to-stderr'), JSON.stringify(streams.stderr.text))

  const managed = await run(ctx, { command: 'printf "%s\\n" "${DSH_PROBE:-missing}"', dshEnv: { DSH_PROBE: 'dsh-env-ok' } })
  check('DSH_* env reaches the shell', managed.stdout.text.trim() === 'dsh-env-ok', JSON.stringify(managed.stdout.text))

  const slow = await run(ctx, { command: 'sleep 5', timeoutMs: 400 })
  check('timeout is classified', slow.timedOut === true, JSON.stringify({ timedOut: slow.timedOut, exitCode: slow.exitCode }))

  const background = ctx.shell.resolve({ command: 'echo background-ok', onExpiry: 'none' })
  const handle = await ctx.shell.execute(background)
  const backgroundResult = await handle.result()
  check('background job runs', backgroundResult.stdout.text.trim() === 'background-ok', JSON.stringify(backgroundResult.stdout.text))
} catch (error) {
  failures.push('executor threw')
  console.error('FAIL executor threw:', error instanceof Error ? error.message : error)
} finally {
  if (typeof ctx.dispose === 'function') await ctx.dispose()
}

if (failures.length > 0) {
  console.error(`\nsmoke: ${String(failures.length)} of ${String(checks)} checks FAILED`)
  process.exit(1)
}
console.log(`\nsmoke: PASS (${String(checks)} checks)`)
