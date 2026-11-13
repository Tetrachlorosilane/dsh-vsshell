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
import type { Config as LocalBashConfig } from '@deepseek-ai/dsh-bash-local';
import type { Source } from './detect.js';
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
    static inject: string[];
    /** The provider's schema, exposed for DSH's Config projection. */
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
    constructor(ctx: Context, config: Config);
}
