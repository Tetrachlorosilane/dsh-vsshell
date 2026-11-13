// Wiring tests for the executor plugin itself.
//
// A bare cordis Context provides the three services the plugin injects: a
// capturing `systemPrompt`, a fake `subprocess`, and a fake `sandboxPolicy`
// (the executor mirrors its default mode for DSH permission-presets
// composition while keeping execution unconfined). `verify: false` keeps
// resolution probe-free, so these tests start no shell, and the fake spawn lets
// them assert the exact argv and environment handed to the process substrate.
import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import VsshellBashExecutor from '../lib/index.js'

/** The fake deployment policy every test host provides. */
const FAKE_SANDBOX_POLICY = {
  defaultMode: 'workspace-write',
  resolve: () => ({ mode: 'workspace-write', workspaceRoot: process.cwd() }),
}

/** A host context that captures the registered prompt section. */
function captureHost() {
  const ctx = new Context()
  let section
  ctx.provide('systemPrompt', {
    section(value) {
      section = value
      return () => {}
    },
    getSectionOrder(name) {
      return name === 'TOOL_BASH' ? 1000 : 0
    },
  })
  ctx.provide('subprocess', {
    spawn() {
      throw new Error('unit tests must not spawn a process')
    },
  })
  ctx.provide('sandboxPolicy', FAKE_SANDBOX_POLICY)
  return { ctx, section: () => section }
}

/** A host context whose fake subprocess records every spawn spec and settles immediately. */
function spawnCapturingHost() {
  const ctx = new Context()
  /** @type {any[]} */
  const spawns = []
  ctx.provide('systemPrompt', {
    section: () => () => {},
    getSectionOrder: () => 1000,
  })
  ctx.provide('subprocess', {
    spawn(spec) {
      spawns.push(spec)
      const reader = { readFrom: () => ({ text: '', lossy: false, nextOffset: 0 }) }
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        collected: { stdout: reader, stderr: reader },
        terminate() {},
      }
    },
  })
  ctx.provide('sandboxPolicy', FAKE_SANDBOX_POLICY)
  return { ctx, spawns }
}

test('registers ctx.shell and mirrors the deployment sandbox mode', async () => {
  const { ctx, section } = captureHost()
  await ctx.plugin(VsshellBashExecutor, { source: 'git-bash', verify: false })
  assert.equal(typeof ctx.shell.resolve, 'function')
  // Advertised for permission-presets composition; execution stays unconfined.
  assert.equal(ctx.shell.sandboxMode, 'workspace-write')
  const registered = section()
  assert.equal(registered.name, 'shell:vsshell')
  assert.equal(registered.order, 1001)
  const text = registered.text()
  assert.match(text, /Shell:/u)
  assert.match(text, /bash is NOT confined/u)
  assert.match(text, /verify: false/u)
  assert.ok(text.length <= 600, `prompt section grew to ${text.length} chars; keep the proactive context minimal`)
})

test('resolve translates POSIX workdirs and strips the sandbox policy', async () => {
  const { ctx } = captureHost()
  await ctx.plugin(VsshellBashExecutor, { source: 'auto', verify: false, cwd: 'C:\\workspace' })
  const spec = ctx.shell.resolve({ command: 'pwd', workdir: '/mnt/c/work/dir' })
  assert.equal(spec.workdir, 'C:\\work\\dir')
  assert.equal(spec.sandboxPolicy, undefined)
  assert.equal(spec.timeoutMs, 120_000)
  assert.equal(spec.onExpiry, 'kill')
  assert.equal(ctx.shell.resolve({ command: 'pwd' }).workdir, 'C:\\workspace')
})

test('custom source without bashPath fails plugin load', async () => {
  const { ctx } = captureHost()
  await assert.rejects(
    async () => { await ctx.plugin(VsshellBashExecutor, { source: 'custom', bashPath: '', verify: false }) },
    /requires a non-empty bashPath/u,
  )
})

test('a non-positive probeTimeoutMs fails plugin load', async () => {
  const { ctx } = captureHost()
  await assert.rejects(
    async () => { await ctx.plugin(VsshellBashExecutor, { source: 'auto', verify: true, probeTimeoutMs: 0 }) },
    /probeTimeoutMs must be a positive finite number/u,
  )
})

test('execute rejects a missing workdir with an actionable message before spawning', async () => {
  const { ctx, spawns } = spawnCapturingHost()
  await ctx.plugin(VsshellBashExecutor, {
    source: 'custom',
    bashPath: 'C:\\tools\\bash.exe',
    verify: false,
  })
  const spec = ctx.shell.resolve({ command: 'echo hi', workdir: 'C:\\vsshell-definitely-missing\\dir' })
  await assert.rejects(
    async () => { await ctx.shell.execute(spec) },
    error => {
      assert.match(error.message, /workdir is not an existing directory/u)
      assert.match(error.message, /"C:\\\\vsshell-definitely-missing\\\\dir"/u)
      assert.match(error.message, /Resolved shell: source "custom"/u)
      assert.match(error.message, /Cygwin/u)
      return true
    },
  )
  // The spawn layer is never reached, so no opaque ENOENT can surface.
  assert.equal(spawns.length, 0)
})

test('execute spawns a native bash with -lc, terminal overrides and the DSH env', async () => {
  const { ctx, spawns } = spawnCapturingHost()
  await ctx.plugin(VsshellBashExecutor, {
    source: 'custom',
    bashPath: 'C:\\tools\\bash.exe',
    loginShell: true,
    verify: false,
  })
  const spec = ctx.shell.resolve({ command: 'echo hi', dshEnv: { DSH_PROBE: 'ok' } })
  const result = await (await ctx.shell.execute(spec)).result()

  assert.equal(spawns.length, 1)
  assert.deepEqual(spawns[0].argv, ['C:\\tools\\bash.exe', '-lc', 'echo hi'])
  assert.equal(spawns[0].env.NO_COLOR, '1')
  assert.equal(spawns[0].env.TERM, 'dumb')
  assert.equal(spawns[0].env.DSH_PROBE, 'ok')
  // Cygwin's /etc/profile cd's a login shell to $HOME unless CHERE_INVOKING is
  // set; the executor exports it for every native launch so workdir survives.
  assert.equal(spawns[0].env.CHERE_INVOKING, '1')
  assert.equal(result.exitCode, 0)
})

test('execute routes WSL through wsl.exe and forwards WSLENV + WSL_UTF8', async () => {
  const { ctx, spawns } = spawnCapturingHost()
  await ctx.plugin(VsshellBashExecutor, {
    source: 'wsl',
    bashPath: 'C:\\Windows\\System32\\wsl.exe',
    wslDistro: 'Ubuntu',
    loginShell: false,
    verify: false,
  })
  const spec = ctx.shell.resolve({ command: 'echo hi', dshEnv: { DSH_PROBE: 'ok' } })
  await (await ctx.shell.execute(spec)).result()

  assert.equal(spawns.length, 1)
  assert.deepEqual(
    spawns[0].argv,
    ['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-c', 'echo hi'],
  )
  assert.equal(spawns[0].env.WSL_UTF8, '1')
  assert.equal(spawns[0].env.CHERE_INVOKING, undefined, 'WSL launches must not carry the Cygwin workaround')
  const forwarded = spawns[0].env.WSLENV.split(':')
  for (const name of ['DSH_PROBE', 'NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER']) {
    assert.ok(forwarded.includes(name), `WSLENV should forward ${name}`)
  }
})

test('the prompt section names the resolved shell and fits the proactive-context budget', async () => {
  const { ctx, section } = captureHost()
  await ctx.plugin(VsshellBashExecutor, {
    source: 'wsl',
    bashPath: 'C:\\Windows\\System32\\wsl.exe',
    wslDistro: 'Ubuntu',
    verify: false,
  })
  // Let the (probe-free, synchronous-IO) background resolution publish its result.
  await new Promise(resolve => setTimeout(resolve, 0))
  const text = section().text()
  assert.match(text, /WSL/u)
  assert.match(text, /wsl\.exe -d Ubuntu --exec bash -lc <command>/u)
  assert.match(text, /not probed/u)
  assert.match(text, /bash is NOT confined/u)
  // Minimality: the section is injected into every system prompt, so it must
  // stay small; richer failure detail belongs to the per-call error messages.
  assert.ok(text.length <= 600, `prompt section grew to ${text.length} chars; keep the proactive context minimal`)
  assert.doesNotMatch(text, /Failure hints/u)
})

/**
 * Force the executor into a retry whose resolution never settles, so the bounded
 * wait in `awaitTarget` can be exercised without spawning anything.
 * @param {any} shell - the registered executor instance (`ctx.shell`).
 */
function forceSlowRetry(shell) {
  shell.internals.deps = {
    env: process.env,
    platform: process.platform,
    exists: () => true,
    probe: () => new Promise(() => {}),
  }
  shell.state = { status: 'failed', error: new Error('forced retry for test') }
}

test('awaitTarget bounds a slow resolution by the call timeout', async () => {
  const { ctx } = captureHost()
  await ctx.plugin(VsshellBashExecutor, { source: 'custom', bashPath: 'C:\\never\\bash.exe', verify: true })
  forceSlowRetry(ctx.shell)
  const spec = ctx.shell.resolve({ command: 'echo hi', timeoutMs: 80 })
  await assert.rejects(async () => { await ctx.shell.execute(spec) }, /did not finish within 80ms/u)
})

test('awaitTarget honours caller cancellation', async () => {
  const { ctx } = captureHost()
  await ctx.plugin(VsshellBashExecutor, { source: 'custom', bashPath: 'C:\\never\\bash.exe', verify: true })
  forceSlowRetry(ctx.shell)
  const controller = new AbortController()
  const spec = ctx.shell.resolve({ command: 'echo hi', signal: controller.signal })
  const execution = ctx.shell.execute(spec)
  setTimeout(() => controller.abort(new Error('cancelled-by-test')), 30)
  await assert.rejects(execution, /cancelled-by-test/u)
})
