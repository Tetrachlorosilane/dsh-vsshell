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
import { Context } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local';
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local';
import type { SandboxMode } from '@deepseek-ai/dsh-sandbox';
import type { ShellExecRequest, ShellExecSpec, ShellExecution } from '@deepseek-ai/dsh-shell';
import type { ResolveDeps, Source } from './detect.js';
/**
 * Validated plugin configuration: the local bash budgets (mirrored from
 * `LocalBashExecutor.Config`, see AGENTS.md section 4.3) plus the shell-source
 * selection this package adds.
 */
export interface Config extends LocalBashConfig {
    /** Which bash implementation to run. `auto` prefers Git for Windows, then Cygwin, then WSL. */
    source: Source;
    /**
     * Explicit bash executable. Optional for `git-bash`/`cygwin`/`wsl`: a
     * non-empty value becomes the only candidate (still existence-checked and
     * probed unless `verify` is false). Required for `custom`.
     */
    bashPath: string;
    /** WSL distribution name (`wsl.exe -d`); empty selects the default distribution. Applies to any launch that ends up on a WSL launcher, including the `auto` fallback. */
    wslDistro: string;
    /** Run commands as a login shell (`-lc`) so profile PATHs apply; `false` uses `-c`. */
    loginShell: boolean;
    /**
     * Probe the selected executable before first use (default true): confirms it
     * starts, detects the shell family, and reports a usable error when it does
     * not. `false` trusts the first existing path (and an explicit `bashPath`
     * outright), skipping the probe delay.
     */
    verify: boolean;
    /** Positive probe timeout for resolving one candidate bash executable. */
    probeTimeoutMs: number;
}
/**
 * The bash executor. One instance per composition: it resolves the configured
 * source once, then executes every command through that resolved bash.
 */
export default class VsshellBashExecutor extends LocalBashExecutor {
    readonly config: Config;
    /** Services this executor needs: the process substrate, prompt-section registry, and the deployment sandbox policy. */
    static inject: string[];
    static Config: z<Schemastery.ObjectS<NoInfer<{
        cwd: z<string, string, "volatile">;
        timeoutMs: z<number, number, "volatile-defined">;
        maxTimeoutMs: z<number, number, "volatile-defined">;
        maxOutputBytes: z<number, number, "volatile-defined">;
        maxSpillBytes: z<number, number, "volatile-defined">;
        graceMs: z<number, number, "volatile-defined">;
        source: z<"auto" | "wsl" | "git-bash" | "cygwin" | "custom", "auto" | "wsl" | "git-bash" | "cygwin" | "custom", "defined">;
        bashPath: z<string, string, "defined">;
        wslDistro: z<string, string, "defined">;
        loginShell: z<boolean, boolean, "defined">;
        verify: z<boolean, boolean, "defined">;
        probeTimeoutMs: z<number, number, "defined">;
    }>>, Schemastery.ObjectT<NoInfer<{
        cwd: z<string, string, "volatile">;
        timeoutMs: z<number, number, "volatile-defined">;
        maxTimeoutMs: z<number, number, "volatile-defined">;
        maxOutputBytes: z<number, number, "volatile-defined">;
        maxSpillBytes: z<number, number, "volatile-defined">;
        graceMs: z<number, number, "volatile-defined">;
        source: z<"auto" | "wsl" | "git-bash" | "cygwin" | "custom", "auto" | "wsl" | "git-bash" | "cygwin" | "custom", "defined">;
        bashPath: z<string, string, "defined">;
        wslDistro: z<string, string, "defined">;
        loginShell: z<boolean, boolean, "defined">;
        verify: z<boolean, boolean, "defined">;
        probeTimeoutMs: z<number, number, "defined">;
    }>>, "plain">;
    /** Resolved target state; `pending` until the background resolution settles. */
    private state;
    /**
     * Test hook: replacement resolution side effects. Tests set this before
     * forcing a retry (by replacing `state`) to exercise the bounded-wait path
     * without spawning a real bash; production always uses the default deps.
     */
    readonly internals: {
        deps?: ResolveDeps;
    };
    /** The in-flight (or last settled) background resolution. */
    private resolution;
    /**
     * The deployment's default sandbox mode, captured from `ctx.sandboxPolicy`.
     * Advertised for DSH composition coherence (permission presets + tool
     * escalation schema); it does not mean this executor confines anything.
     */
    private readonly defaultSandboxMode;
    /**
     * The capability fact `tool-bash`/`permission-presets` read. DSH couples
     * "shell executor confines" to this getter, so it reports the deployment's
     * default FILE policy; execution itself remains unconfined (module note).
     */
    get sandboxMode(): SandboxMode;
    constructor(ctx: Context, config: Config);
    /**
     * Resolve a request into a fully-specified spec. The parent owns budgets,
     * caps, and validation; this adds the workdir translation that lets a model
     * address the workspace with the POSIX paths its shell prints.
     */
    resolve(request: ShellExecRequest): ShellExecSpec;
    /**
     * Execute one resolved spec through the resolved bash. WSL launches get
     * `WSLENV` forwarding (the Linux process inherits no Windows environment)
     * and `WSL_UTF8` so launcher diagnostics stay UTF-8. Native bash launches
     * export `CHERE_INVOKING=1`: Cygwin's `/etc/profile` otherwise `cd`s a login
     * shell to `$HOME`, which would silently defeat `workdir`; Git Bash ignores
     * the variable.
     */
    execute(spec: ShellExecSpec): Promise<ShellExecution>;
    /**
     * Live resolution facts for the configuration panel; never throws. The panel
     * is a separate host row, so it stays usable even when this executor failed
     * to resolve.
     */
    describeResolved(): {
        status: 'ready' | 'pending' | 'failed';
        exe?: string;
        family?: string;
        label?: string;
        source?: Source;
        detail?: string;
    };
    /**
     * Reject a missing workdir with an actionable message before spawning. The
     * spawn layer would only report `ENOENT`, which cannot distinguish a bad
     * working directory from a missing bash executable.
     */
    private assertWorkdir;
    /**
     * Wait for the target under the execution's own contract: the caller's
     * cancellation aborts the wait, and a foreground deadline bounds it, so a slow
     * probe can neither outlive the timeout nor ignore a cancel.
     */
    private awaitTarget;
    /** Start one background resolution and publish its outcome. */
    private startResolution;
    /** The resolved target, waiting for the in-flight resolution or retrying one failed attempt. */
    private currentTarget;
    /** The validated config subset the resolver consumes. */
    private resolveOptions;
    /** Register the global section that tells the model which shell it is driving. */
    private registerPromptSection;
    /**
     * The section text, resolved at each prompt assembly from the current target
     * state. Kept deliberately small (asserted by a length test): only facts the
     * model needs on EVERY call live here. Failure specifics stay in the error
     * messages, which cost nothing until a call actually fails.
     */
    private promptText;
}
