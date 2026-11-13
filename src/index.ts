/**
 * Model-facing bash on Windows with a configurable shell source.
 *
 * Registers as `ctx.shell` in place of the pwsh executor and reuses
 * {@link LocalBashExecutor}'s process mechanics: command defaulting, deadlines
 * and cause classification, the model-friendly environment, output collection
 * and spill, and background-process semantics all stay upstream. This executor
 * only decides WHICH bash runs, HOW it is invoked, and which environment a WSL
 * launch must forward.
 *
 * Deliberate capability boundary: execution is NOT sandboxed. The Windows ACL
 * sandbox uses a restricted security token, and neither MSYS2 (Git Bash /
 * Cygwin) nor WSL can start inside it — measured as `couldn't create signal
 * pipe, Win32 error 5` and `Wsl/E_ACCESSDENIED`. Two separate facts must not be
 * conflated:
 *
 * - `sandboxMode` mirrors `ctx.sandboxPolicy.defaultMode`. DSH's
 *   `permission-presets` REFUSES to activate over a shell executor whose
 *   `sandboxMode` is undefined ("composing this plugin over an unconfined
 *   executor is a misconfiguration") and uses that value as the session's
 *   default sandbox mode, so the value describes the deployment's default FILE
 *   policy, not this executor's enforcement. Without it the Web permission
 *   switcher (and its projection/remote surface) would be unavailable.
 * - Execution itself stays unconfined: `resolve()` drops the per-call policy and
 *   results carry no `sandbox` facts, so nothing claims commands were confined.
 *   The model is told that bash is not confined while the harness file tools
 *   still are. See docs/design.md sections 2 and 7.
 * @module @dsh-external/dsh-vsshell
 */

import { existsSync, statSync } from 'node:fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local'
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox'
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell'
import {
  SOURCES,
  buildInvocation,
  buildWslEnv,
  defaultResolveDeps,
  isWslLauncher,
  resolveBashTarget,
  translateWorkdir,
} from './detect.js'
import type { BashTarget, ResolveDeps, ResolveOptions, Source } from './detect.js'

/** Default per-stream spill cap, mirrored from `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024

/**
 * Validated plugin configuration: the local bash budgets (mirrored from
 * `LocalBashExecutor.Config`, see AGENTS.md section 4.3) plus the shell-source
 * selection this package adds.
 */
export interface Config extends LocalBashConfig {
  /** Which bash implementation to run. `auto` prefers Git for Windows, then Cygwin, then WSL. */
  source: Source
  /**
   * Explicit bash executable. Optional for `git-bash`/`cygwin`/`wsl`: a
   * non-empty value becomes the only candidate (still existence-checked and
   * probed unless `verify` is false). Required for `custom`.
   */
  bashPath: string
  /** WSL distribution name (`wsl.exe -d`); empty selects the default distribution. Applies to any launch that ends up on a WSL launcher, including the `auto` fallback. */
  wslDistro: string
  /** Run commands as a login shell (`-lc`) so profile PATHs apply; `false` uses `-c`. */
  loginShell: boolean
  /**
   * Probe the selected executable before first use (default true): confirms it
   * starts, detects the shell family, and reports a usable error when it does
   * not. `false` trusts the first existing path (and an explicit `bashPath`
   * outright), skipping the probe delay.
   */
  verify: boolean
  /** Positive probe timeout for resolving one candidate bash executable. */
  probeTimeoutMs: number
}

/** Current bash-target state: resolution runs in the background at plugin load and retries after a failure. */
type TargetState =
  | { status: 'pending' }
  | { status: 'ready'; target: BashTarget }
  | { status: 'failed'; error: Error }

/**
 * The actual shell service: one instance per composition. It resolves the
 * configured source once, then executes every command through that resolved
 * bash.
 *
 * The plugin entry below (`VsshellBashExecutor`) constructs this class only
 * when `ctx.shell` is free. Keeping the provider separate from the plugin
 * wrapper is what makes a live `install_bundle` over an already-running
 * `pwsh-sandbox` possible: registering a second `shell` service in the same
 * context throws in cordis, so the wrapper waits for the old provider's fiber
 * to release the slot first (see AGENTS.md section 4.14).
 */
class VsshellService extends LocalBashExecutor {
  /** Services this executor needs: the process substrate, prompt-section registry, and the deployment sandbox policy. */
  static override inject = ['subprocess', 'systemPrompt', 'sandboxPolicy']

  static override Config = z.object({
    // Budgets mirrored from @deepseek-ai/dsh-bash-local (keep in sync with
    // packages/shell/bash-local/src/index.ts; see AGENTS.md section 4.3).
    cwd: z.string().volatile(),
    timeoutMs: z.number().default(120_000).volatile(),
    maxTimeoutMs: z.number().default(600_000).volatile(),
    maxOutputBytes: z.number().default(64_000).volatile(),
    maxSpillBytes: z.number().default(DEFAULT_MAX_SPILL_BYTES).volatile(),
    graceMs: z.number().default(3_000).volatile(),
    // Shell-source selection.
    source: z.union(SOURCES).default('auto'),
    bashPath: z.string().default(''),
    wslDistro: z.string().default(''),
    loginShell: z.boolean().default(true),
    verify: z.boolean().default(true),
    probeTimeoutMs: z.number().default(15_000),
  })

  /** Resolved target state; `pending` until the background resolution settles. */
  private state: TargetState = { status: 'pending' }

  /**
   * Test hook: replacement resolution side effects. Tests set this before
   * forcing a retry (by replacing `state`) to exercise the bounded-wait path
   * without spawning a real bash; production always uses the default deps.
   */
  readonly internals: { deps?: ResolveDeps } = {}

  /** The in-flight (or last settled) background resolution. */
  private resolution: Promise<BashTarget>

  /**
   * The deployment's default sandbox mode, captured from `ctx.sandboxPolicy`.
   * Advertised for DSH composition coherence (permission presets + tool
   * escalation schema); it does not mean this executor confines anything.
   */
  private readonly defaultSandboxMode: SandboxMode

  /**
   * The capability fact `tool-bash`/`permission-presets` read. DSH couples
   * "shell executor confines" to this getter, so it reports the deployment's
   * default FILE policy; execution itself remains unconfined (module note).
   */
  override get sandboxMode(): SandboxMode {
    return this.defaultSandboxMode
  }

  constructor(ctx: Context, override readonly config: Config) {
    super(ctx, config)
    // `sandboxPolicy` is guaranteed by `static inject`; the structural cast keeps
    // this package independent of the policy package's type surface.
    const sandboxPolicy = (ctx as unknown as { sandboxPolicy?: { defaultMode?: SandboxMode } }).sandboxPolicy
    this.defaultSandboxMode = sandboxPolicy?.defaultMode ?? 'workspace-write'
    assertValidConfig(config)
    // `wslDistro` applies to any launch that ends up using a WSL launcher,
    // including the `auto` fallback; a native-only source simply never uses it.
    // Resolve eagerly so the prompt section can name the real shell soon after
    // startup, but never block plugin mount on a slow WSL cold start.
    this.resolution = this.startResolution()
    void this.resolution.catch(() => {})
    this.registerPromptSection(ctx)
  }

  /**
   * Resolve a request into a fully-specified spec. The parent owns budgets,
   * caps, and validation; this adds the workdir translation that lets a model
   * address the workspace with the POSIX paths its shell prints.
   */
  override resolve(request: ShellExecRequest): ShellExecSpec {
    const spec = super.resolve(request)
    // Execution never confines (see the module note): drop the per-call policy
    // instead of passing a policy that would not be enforced, and never emit
    // `sandbox` facts on results.
    return { ...spec, workdir: translateWorkdir(spec.workdir, this.config.source), sandboxPolicy: undefined }
  }

  /**
   * Execute one resolved spec through the resolved bash. WSL launches get
   * `WSLENV` forwarding (the Linux process inherits no Windows environment)
   * and `WSL_UTF8` so launcher diagnostics stay UTF-8. Native bash launches
   * export `CHERE_INVOKING=1`: Cygwin's `/etc/profile` otherwise `cd`s a login
   * shell to `$HOME`, which would silently defeat `workdir`; Git Bash ignores
   * the variable.
   */
  override async execute(spec: ShellExecSpec): Promise<ShellExecution> {
    const target = await this.awaitTarget(spec)
    // Fail before spawning with a cause the model can act on: a wrong workdir
    // otherwise surfaces only as a bare `spawn ... ENOENT`, indistinguishable
    // from a missing bash executable.
    this.assertWorkdir(spec, target)
    const argv = buildInvocation(target, spec.command)
    if (target.kind !== 'wsl') {
      const env = { CHERE_INVOKING: '1', ...spec.env }
      return this.executeArgv({ ...spec, env }, argv)
    }
    const env = {
      ...spec.env,
      ...buildWslEnv({ env: spec.env, dshEnv: spec.dshEnv, inheritedWslEnv: process.env.WSLENV }),
    }
    return this.executeArgv({ ...spec, env }, argv)
  }

  /**
   * Live resolution facts for the configuration panel; never throws. The panel
   * is a separate host row, so it stays usable even when this executor failed
   * to resolve.
   */
  describeResolved(): {
    status: 'ready' | 'pending' | 'failed'
    exe?: string
    family?: string
    label?: string
    source?: Source
    detail?: string
  } {
    const state = this.state
    if (state.status === 'ready') {
      return {
        status: 'ready',
        exe: state.target.exe,
        family: state.target.family,
        label: state.target.label,
        source: state.target.source,
      }
    }
    if (state.status === 'failed') {
      return { status: 'failed', detail: state.error.message.split('\n')[0] ?? '' }
    }
    return { status: 'pending' }
  }

  /**
   * Reject a missing workdir with an actionable message before spawning. The
   * spawn layer would only report `ENOENT`, which cannot distinguish a bad
   * working directory from a missing bash executable.
   */
  private assertWorkdir(spec: ShellExecSpec, target: BashTarget): void {
    const workdir = spec.workdir
    if (workdir === '') return
    let usable = false
    try {
      usable = existsSync(workdir) && statSync(workdir).isDirectory()
    } catch {
      usable = false
    }
    if (usable) return
    const syntax = target.kind === 'wsl'
      ? '/mnt/<drive>/... (WSL)'
      : '/cygdrive/<drive>/... (Cygwin), /<drive>/... (Git Bash/Cygwin)'
    throw new Error(
      `vsshell: workdir is not an existing directory: ${JSON.stringify(workdir)}. `
      + `Resolved shell: source "${target.source}" (${target.label}, ${target.family}) at "${target.exe}". `
      + `The bash executable is not the problem — fix the working directory. Translated POSIX prefixes: ${syntax}; `
      + 'other POSIX paths are not translated and are treated as Windows paths.',
    )
  }

  /**
   * Wait for the target under the execution's own contract: the caller's
   * cancellation aborts the wait, and a foreground deadline bounds it, so a slow
   * probe can neither outlive the timeout nor ignore a cancel.
   */
  private async awaitTarget(spec: ShellExecSpec): Promise<BashTarget> {
    const pending = this.currentTarget()
    if (this.state.status === 'ready') return pending
    const timeoutMs = spec.onExpiry === 'kill' ? spec.timeoutMs : undefined
    const cancelled = Promise.withResolvers<never>()
    const cancel = (reason: unknown): void => {
      cancelled.reject(reason instanceof Error ? reason : new Error(String(reason)))
    }
    const timer = timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
        cancel(new Error(`vsshell: bash resolution did not finish within ${String(timeoutMs)}ms; raise probeTimeoutMs or set verify: false`))
      }, timeoutMs)
    const outerSignal = spec.signal
    const onAbort = (): void => { cancel(outerSignal?.reason) }
    if (outerSignal?.aborted === true) onAbort()
    else outerSignal?.addEventListener('abort', onAbort, { once: true })
    try {
      return await Promise.race([pending, cancelled.promise])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      outerSignal?.removeEventListener('abort', onAbort)
    }
  }

  /** Start one background resolution and publish its outcome. */
  private startResolution(): Promise<BashTarget> {
    this.state = { status: 'pending' }
    return resolveBashTarget(this.resolveOptions(), this.internals.deps ?? defaultResolveDeps()).then(
      (target) => {
        this.state = { status: 'ready', target }
        this.ctx.logger.info(
          `vsshell: bash source "${target.source}" resolved to ${target.exe} (${target.family}, ${target.loginShell ? '-lc' : '-c'})`,
        )
        return target
      },
      (error: unknown) => {
        const failure = error instanceof Error ? error : new Error(String(error))
        this.state = { status: 'failed', error: failure }
        this.ctx.logger.warn(`vsshell: bash resolution failed: ${failure.message}`)
        throw failure
      },
    )
  }

  /** The resolved target, waiting for the in-flight resolution or retrying one failed attempt. */
  private currentTarget(): Promise<BashTarget> {
    if (this.state.status === 'ready') return Promise.resolve(this.state.target)
    if (this.state.status === 'failed') {
      // Retry once per call after a failure: the user may install or fix the
      // selected bash while the harness keeps running.
      this.resolution = this.startResolution()
      void this.resolution.catch(() => {})
    }
    return this.resolution
  }

  /** The validated config subset the resolver consumes. */
  private resolveOptions(): ResolveOptions {
    return {
      source: this.config.source,
      bashPath: this.config.bashPath,
      wslDistro: this.config.wslDistro,
      loginShell: this.config.loginShell,
      verify: this.config.verify,
      probeTimeoutMs: this.config.probeTimeoutMs,
    }
  }

  /** Register the global section that tells the model which shell it is driving. */
  private registerPromptSection(ctx: Context): void {
    const dispose = ctx.systemPrompt.section({
      name: 'shell:vsshell',
      order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
      text: () => this.promptText(),
    })
    ctx.effect(() => dispose)
  }

  /**
   * The section text, resolved at each prompt assembly from the current target
   * state. Kept deliberately small (asserted by a length test): only facts the
   * model needs on EVERY call live here. Failure specifics stay in the error
   * messages, which cost nothing until a call actually fails.
   */
  private promptText(): string {
    const lines: string[] = []
    const state = this.state
    if (state.status === 'ready') {
      const target = state.target
      const label = target.kind === 'wsl'
        ? `WSL${target.wslDistro === '' ? '' : ` (distribution ${target.wslDistro})`}`
        : target.family === 'unknown' ? sourceLabel(target.source) : familyLabel(target.family)
      lines.push(`Shell: ${label} — ${invocationLabel(target)}.`)
      const pathNote = pathNoteFor(target)
      if (pathNote !== undefined) lines.push(pathNote)
      if (!this.config.verify) {
        lines.push('Family and path syntax were not probed (`verify: false`).')
      } else if (target.kind === 'wsl') {
        lines.push('`DSH_*` variables are forwarded via `WSLENV`; other Windows variables are not.')
      } else {
        lines.push('`DSH_*` variables are available in this shell.')
      }
    } else if (state.status === 'failed') {
      lines.push(`Shell: bash resolution failed for source "${this.config.source}"; calls retry and report every candidate tried.`)
    } else {
      lines.push(`Shell: resolving configured source "${this.config.source}"...`)
    }
    lines.push(
      'Sandbox: bash is NOT confined (file tools still are); `sandbox_permissions`/`justification` are inert for this tool (escalation changes nothing).',
    )
    return lines.join('\n')
  }
}

/**
 * Plugin entry for the bundle's `dsh-vsshell` row.
 *
 * Cordis allows one `shell` service per context, and the provider registers
 * during construction. A live `install_bundle` replaces the bundle layer while
 * the previous `pwsh-sandbox` service is still mounted; constructing the
 * provider directly in that window throws `service "shell" has been registered
 * at <SandboxPwshExecutor>` and leaves the deployment without ANY shell tool
 * (the bundle patch already disabled pwsh/tool-pwsh).
 *
 * This wrapper therefore waits for the old provider's fiber to release
 * `ctx.shell`, then mounts the executor. The wait is bounded by the plugin's
 * own lifetime and reports one actionable warning after a few seconds; it does
 * not throw, so a hot install degrades to "bash appears once the old provider
 * unloads (or after a restart)" instead of a broken composition.
 */
export default class VsshellBashExecutor {
  /** Same dependencies as the provider; declared here so the fiber waits for them. */
  static inject = ['subprocess', 'systemPrompt', 'sandboxPolicy']

  /** The provider's schema, exposed for DSH's Config projection. */
  static Config = VsshellService.Config

  constructor(ctx: Context, config: Config) {
    // Keep load-time config errors identical to the old direct-service plugin:
    // an invalid config must reject activation even if mounting is deferred.
    assertValidConfig(config)
    mountShellWhenFree(ctx, config)
  }
}

/** How often the wrapper re-checks the `shell` slot while an old provider unloads. */
const SHELL_MOUNT_POLL_MS = 200
/** After this long, emit one actionable warning but keep waiting. */
const SHELL_MOUNT_WARN_MS = 5_000

/** Mount the provider if `ctx.shell` is free; report whether it mounted. */
function tryMountShell(ctx: Context, config: Config): boolean {
  if (readService(ctx, 'shell') !== undefined) return false
  new VsshellService(ctx, config)
  return true
}

/** Wait for a still-mounted `shell` provider to unload, then mount ours. */
function mountShellWhenFree(ctx: Context, config: Config): void {
  if (tryMountShell(ctx, config)) return
  const startedAt = Date.now()
  let warned = false
  const timer = setInterval(() => {
    try {
      if (tryMountShell(ctx, config)) {
        clearInterval(timer)
        const logger = readService(ctx, 'logger') as { info?: (message: string) => void } | undefined
        logger?.info?.(`dsh-vsshell: previous shell provider released ctx.shell after ${Date.now() - startedAt}ms; bash executor mounted`)
        return
      }
    } catch (error) {
      clearInterval(timer)
      const message = error instanceof Error ? error.message : String(error)
      const logger = readService(ctx, 'logger') as { error?: (message: string) => void } | undefined
      logger?.error?.(`dsh-vsshell: deferred shell mount failed: ${message}`)
      return
    }
    if (!warned && Date.now() - startedAt >= SHELL_MOUNT_WARN_MS) {
      warned = true
      const logger = readService(ctx, 'logger') as { warn?: (message: string) => void } | undefined
      logger?.warn?.(
        'dsh-vsshell: ctx.shell is still held by another executor (usually the previous pwsh-sandbox during a live install). '
        + 'The bash executor will mount automatically once that provider unloads; if the bash tool stays unavailable, '
        + 'fully quit and relaunch DSH.',
      )
    }
  }, SHELL_MOUNT_POLL_MS)
  // Owned by the plugin fiber: cleared on unload/reload so a stale timer can
  // never mount after the bundle has gone away.
  ctx.effect(() => () => clearInterval(timer), 'dsh-vsshell: wait for ctx.shell before mounting')
}

/**
 * Read a service without requiring it in `static inject`. Used for diagnostics
 * (`logger`) and for the shell-slot probe, which must see a still-mounted
 * provider even while it is being replaced.
 */
function readService(ctx: Context, name: string): unknown {
  const get = (ctx as unknown as { get?: (service: string, strict?: boolean) => unknown }).get
  if (typeof get !== 'function') return undefined
  return get.call(ctx, name, false)
}

/** Load-time configuration validation shared by the wrapper and the provider. */
function assertValidConfig(config: Config): void {
  if (config.source === 'custom' && config.bashPath.trim() === '') {
    throw new Error('vsshell: source "custom" requires a non-empty bashPath')
  }
  if (!Number.isFinite(config.probeTimeoutMs) || config.probeTimeoutMs <= 0) {
    throw new Error('vsshell: probeTimeoutMs must be a positive finite number')
  }
}

/** Human-readable shell family for the prompt (`$OSTYPE` values or launcher facts). */
function familyLabel(family: string): string {
  switch (family) {
    case 'msys': return 'Git Bash (MSYS2)'
    case 'cygwin': return 'Cygwin bash'
    case 'linux-gnu': return 'bash'
    default: return `bash (${family})`
  }
}

/** The exact shell invocation shape for the prompt, exe included exactly once. */
function invocationLabel(target: BashTarget): string {
  const flag = target.loginShell ? '-lc' : '-c'
  if (target.kind === 'wsl' && isWslLauncher(target.exe)) {
    const distro = target.wslDistro === '' ? '' : ` -d ${target.wslDistro}`
    return `\`wsl.exe${distro} --exec bash ${flag} <command>\``
  }
  return `\`${target.exe} ${flag} <command>\``
}

/** Human-readable source for a target whose family was not probed (`verify: false`). */
function sourceLabel(source: Source): string {
  switch (source) {
    case 'git-bash': return 'Git Bash (configured, not verified)'
    case 'cygwin': return 'Cygwin bash (configured, not verified)'
    case 'wsl': return 'WSL bash (configured, not verified)'
    case 'custom': return 'configured bash (not verified)'
    case 'auto': return 'bash (not verified)'
  }
}

/** One short path-syntax note for the resolved family; omitted when unknown. */
function pathNoteFor(target: BashTarget): string | undefined {
  if (target.kind === 'wsl') {
    return 'Paths: POSIX (`/mnt/c/...`); `workdir` accepts Windows paths or `/mnt/<drive>/...`.'
  }
  if (target.family === 'msys') {
    return 'Paths: POSIX (`/c/...`); `workdir` accepts Windows paths, and `/c/...` only with an explicit git-bash/cygwin source.'
  }
  if (target.family === 'cygwin') {
    return 'Paths: POSIX (`/cygdrive/c/...`); `workdir` accepts Windows paths or `/cygdrive/<drive>/...`.'
  }
  return undefined
}
