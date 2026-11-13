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
import { existsSync, statSync } from 'node:fs';
import z from '@deepseek-ai/schemastery';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import { SOURCES, buildInvocation, buildWslEnv, defaultResolveDeps, isWslLauncher, resolveBashTarget, translateWorkdir, } from './detect.js';
/** Default per-stream spill cap, mirrored from `@deepseek-ai/dsh-bash-local`. */
const DEFAULT_MAX_SPILL_BYTES = 64 * 1024 * 1024;
/**
 * The bash executor. One instance per composition: it resolves the configured
 * source once, then executes every command through that resolved bash.
 */
export default class VsshellBashExecutor extends LocalBashExecutor {
    config;
    /** Services this executor needs: the process substrate, prompt-section registry, and the deployment sandbox policy. */
    static inject = ['subprocess', 'systemPrompt', 'sandboxPolicy'];
    static Config = z.object({
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
    });
    /** Resolved target state; `pending` until the background resolution settles. */
    state = { status: 'pending' };
    /**
     * Test hook: replacement resolution side effects. Tests set this before
     * forcing a retry (by replacing `state`) to exercise the bounded-wait path
     * without spawning a real bash; production always uses the default deps.
     */
    internals = {};
    /** The in-flight (or last settled) background resolution. */
    resolution;
    /**
     * The deployment's default sandbox mode, captured from `ctx.sandboxPolicy`.
     * Advertised for DSH composition coherence (permission presets + tool
     * escalation schema); it does not mean this executor confines anything.
     */
    defaultSandboxMode;
    /**
     * The capability fact `tool-bash`/`permission-presets` read. DSH couples
     * "shell executor confines" to this getter, so it reports the deployment's
     * default FILE policy; execution itself remains unconfined (module note).
     */
    get sandboxMode() {
        return this.defaultSandboxMode;
    }
    constructor(ctx, config) {
        super(ctx, config);
        this.config = config;
        // `sandboxPolicy` is guaranteed by `static inject`; the structural cast keeps
        // this package independent of the policy package's type surface.
        const sandboxPolicy = ctx.sandboxPolicy;
        this.defaultSandboxMode = sandboxPolicy?.defaultMode ?? 'workspace-write';
        if (config.source === 'custom' && config.bashPath.trim() === '') {
            throw new Error('vsshell: source "custom" requires a non-empty bashPath');
        }
        if (!Number.isFinite(config.probeTimeoutMs) || config.probeTimeoutMs <= 0) {
            throw new Error('vsshell: probeTimeoutMs must be a positive finite number');
        }
        // `wslDistro` applies to any launch that ends up using a WSL launcher,
        // including the `auto` fallback; a native-only source simply never uses it.
        // Resolve eagerly so the prompt section can name the real shell soon after
        // startup, but never block plugin mount on a slow WSL cold start.
        this.resolution = this.startResolution();
        void this.resolution.catch(() => { });
        this.registerPromptSection(ctx);
    }
    /**
     * Resolve a request into a fully-specified spec. The parent owns budgets,
     * caps, and validation; this adds the workdir translation that lets a model
     * address the workspace with the POSIX paths its shell prints.
     */
    resolve(request) {
        const spec = super.resolve(request);
        // Execution never confines (see the module note): drop the per-call policy
        // instead of passing a policy that would not be enforced, and never emit
        // `sandbox` facts on results.
        return { ...spec, workdir: translateWorkdir(spec.workdir, this.config.source), sandboxPolicy: undefined };
    }
    /**
     * Execute one resolved spec through the resolved bash. WSL launches get
     * `WSLENV` forwarding (the Linux process inherits no Windows environment)
     * and `WSL_UTF8` so launcher diagnostics stay UTF-8. Native bash launches
     * export `CHERE_INVOKING=1`: Cygwin's `/etc/profile` otherwise `cd`s a login
     * shell to `$HOME`, which would silently defeat `workdir`; Git Bash ignores
     * the variable.
     */
    async execute(spec) {
        const target = await this.awaitTarget(spec);
        // Fail before spawning with a cause the model can act on: a wrong workdir
        // otherwise surfaces only as a bare `spawn ... ENOENT`, indistinguishable
        // from a missing bash executable.
        this.assertWorkdir(spec, target);
        const argv = buildInvocation(target, spec.command);
        if (target.kind !== 'wsl') {
            const env = { CHERE_INVOKING: '1', ...spec.env };
            return this.executeArgv({ ...spec, env }, argv);
        }
        const env = {
            ...spec.env,
            ...buildWslEnv({ env: spec.env, dshEnv: spec.dshEnv, inheritedWslEnv: process.env.WSLENV }),
        };
        return this.executeArgv({ ...spec, env }, argv);
    }
    /**
     * Live resolution facts for the configuration panel; never throws. The panel
     * is a separate host row, so it stays usable even when this executor failed
     * to resolve.
     */
    describeResolved() {
        const state = this.state;
        if (state.status === 'ready') {
            return {
                status: 'ready',
                exe: state.target.exe,
                family: state.target.family,
                label: state.target.label,
                source: state.target.source,
            };
        }
        if (state.status === 'failed') {
            return { status: 'failed', detail: state.error.message.split('\n')[0] ?? '' };
        }
        return { status: 'pending' };
    }
    /**
     * Reject a missing workdir with an actionable message before spawning. The
     * spawn layer would only report `ENOENT`, which cannot distinguish a bad
     * working directory from a missing bash executable.
     */
    assertWorkdir(spec, target) {
        const workdir = spec.workdir;
        if (workdir === '')
            return;
        let usable = false;
        try {
            usable = existsSync(workdir) && statSync(workdir).isDirectory();
        }
        catch {
            usable = false;
        }
        if (usable)
            return;
        const syntax = target.kind === 'wsl'
            ? '/mnt/<drive>/... (WSL)'
            : '/cygdrive/<drive>/... (Cygwin), /<drive>/... (Git Bash/Cygwin)';
        throw new Error(`vsshell: workdir is not an existing directory: ${JSON.stringify(workdir)}. `
            + `Resolved shell: source "${target.source}" (${target.label}, ${target.family}) at "${target.exe}". `
            + `The bash executable is not the problem — fix the working directory. Translated POSIX prefixes: ${syntax}; `
            + 'other POSIX paths are not translated and are treated as Windows paths.');
    }
    /**
     * Wait for the target under the execution's own contract: the caller's
     * cancellation aborts the wait, and a foreground deadline bounds it, so a slow
     * probe can neither outlive the timeout nor ignore a cancel.
     */
    async awaitTarget(spec) {
        const pending = this.currentTarget();
        if (this.state.status === 'ready')
            return pending;
        const timeoutMs = spec.onExpiry === 'kill' ? spec.timeoutMs : undefined;
        const cancelled = Promise.withResolvers();
        const cancel = (reason) => {
            cancelled.reject(reason instanceof Error ? reason : new Error(String(reason)));
        };
        const timer = timeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                cancel(new Error(`vsshell: bash resolution did not finish within ${String(timeoutMs)}ms; raise probeTimeoutMs or set verify: false`));
            }, timeoutMs);
        const outerSignal = spec.signal;
        const onAbort = () => { cancel(outerSignal?.reason); };
        if (outerSignal?.aborted === true)
            onAbort();
        else
            outerSignal?.addEventListener('abort', onAbort, { once: true });
        try {
            return await Promise.race([pending, cancelled.promise]);
        }
        finally {
            if (timer !== undefined)
                clearTimeout(timer);
            outerSignal?.removeEventListener('abort', onAbort);
        }
    }
    /** Start one background resolution and publish its outcome. */
    startResolution() {
        this.state = { status: 'pending' };
        return resolveBashTarget(this.resolveOptions(), this.internals.deps ?? defaultResolveDeps()).then((target) => {
            this.state = { status: 'ready', target };
            this.ctx.logger.info(`vsshell: bash source "${target.source}" resolved to ${target.exe} (${target.family}, ${target.loginShell ? '-lc' : '-c'})`);
            return target;
        }, (error) => {
            const failure = error instanceof Error ? error : new Error(String(error));
            this.state = { status: 'failed', error: failure };
            this.ctx.logger.warn(`vsshell: bash resolution failed: ${failure.message}`);
            throw failure;
        });
    }
    /** The resolved target, waiting for the in-flight resolution or retrying one failed attempt. */
    currentTarget() {
        if (this.state.status === 'ready')
            return Promise.resolve(this.state.target);
        if (this.state.status === 'failed') {
            // Retry once per call after a failure: the user may install or fix the
            // selected bash while the harness keeps running.
            this.resolution = this.startResolution();
            void this.resolution.catch(() => { });
        }
        return this.resolution;
    }
    /** The validated config subset the resolver consumes. */
    resolveOptions() {
        return {
            source: this.config.source,
            bashPath: this.config.bashPath,
            wslDistro: this.config.wslDistro,
            loginShell: this.config.loginShell,
            verify: this.config.verify,
            probeTimeoutMs: this.config.probeTimeoutMs,
        };
    }
    /** Register the global section that tells the model which shell it is driving. */
    registerPromptSection(ctx) {
        const dispose = ctx.systemPrompt.section({
            name: 'shell:vsshell',
            order: ctx.systemPrompt.getSectionOrder('TOOL_BASH') + 1,
            text: () => this.promptText(),
        });
        ctx.effect(() => dispose);
    }
    /**
     * The section text, resolved at each prompt assembly from the current target
     * state. Kept deliberately small (asserted by a length test): only facts the
     * model needs on EVERY call live here. Failure specifics stay in the error
     * messages, which cost nothing until a call actually fails.
     */
    promptText() {
        const lines = [];
        const state = this.state;
        if (state.status === 'ready') {
            const target = state.target;
            const label = target.kind === 'wsl'
                ? `WSL${target.wslDistro === '' ? '' : ` (distribution ${target.wslDistro})`}`
                : target.family === 'unknown' ? sourceLabel(target.source) : familyLabel(target.family);
            lines.push(`Shell: ${label} — ${invocationLabel(target)}.`);
            const pathNote = pathNoteFor(target);
            if (pathNote !== undefined)
                lines.push(pathNote);
            if (!this.config.verify) {
                lines.push('Family and path syntax were not probed (`verify: false`).');
            }
            else if (target.kind === 'wsl') {
                lines.push('`DSH_*` variables are forwarded via `WSLENV`; other Windows variables are not.');
            }
            else {
                lines.push('`DSH_*` variables are available in this shell.');
            }
        }
        else if (state.status === 'failed') {
            lines.push(`Shell: bash resolution failed for source "${this.config.source}"; calls retry and report every candidate tried.`);
        }
        else {
            lines.push(`Shell: resolving configured source "${this.config.source}"...`);
        }
        lines.push('Sandbox: bash is NOT confined (file tools still are); `sandbox_permissions`/`justification` are inert for this tool (escalation changes nothing).');
        return lines.join('\n');
    }
}
/** Human-readable shell family for the prompt (`$OSTYPE` values or launcher facts). */
function familyLabel(family) {
    switch (family) {
        case 'msys': return 'Git Bash (MSYS2)';
        case 'cygwin': return 'Cygwin bash';
        case 'linux-gnu': return 'bash';
        default: return `bash (${family})`;
    }
}
/** The exact shell invocation shape for the prompt, exe included exactly once. */
function invocationLabel(target) {
    const flag = target.loginShell ? '-lc' : '-c';
    if (target.kind === 'wsl' && isWslLauncher(target.exe)) {
        const distro = target.wslDistro === '' ? '' : ` -d ${target.wslDistro}`;
        return `\`wsl.exe${distro} --exec bash ${flag} <command>\``;
    }
    return `\`${target.exe} ${flag} <command>\``;
}
/** Human-readable source for a target whose family was not probed (`verify: false`). */
function sourceLabel(source) {
    switch (source) {
        case 'git-bash': return 'Git Bash (configured, not verified)';
        case 'cygwin': return 'Cygwin bash (configured, not verified)';
        case 'wsl': return 'WSL bash (configured, not verified)';
        case 'custom': return 'configured bash (not verified)';
        case 'auto': return 'bash (not verified)';
    }
}
/** One short path-syntax note for the resolved family; omitted when unknown. */
function pathNoteFor(target) {
    if (target.kind === 'wsl') {
        return 'Paths: POSIX (`/mnt/c/...`); `workdir` accepts Windows paths or `/mnt/<drive>/...`.';
    }
    if (target.family === 'msys') {
        return 'Paths: POSIX (`/c/...`); `workdir` accepts Windows paths, and `/c/...` only with an explicit git-bash/cygwin source.';
    }
    if (target.family === 'cygwin') {
        return 'Paths: POSIX (`/cygdrive/c/...`); `workdir` accepts Windows paths or `/cygdrive/<drive>/...`.';
    }
    return undefined;
}
