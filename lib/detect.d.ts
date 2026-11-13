/**
 * Pure bash-configuration resolution for the vsshell executor: which bash to
 * spawn, how to invoke it, how to translate a POSIX `workdir`, and which
 * environment variables a WSL launch must forward.
 *
 * Every rule here is a pure function or takes its side effects (filesystem
 * existence checks, process spawning) as injected dependencies, so the
 * resolution rules stay unit-testable without launching a real shell.
 * @module @dsh-external/dsh-vsshell/detect
 */
/** stdout token that identifies a working bash during the probe. */
export declare const PROBE_MARKER = "__vsshell_probe__";
/** Selectable bash sources; `custom` requires an explicit `bashPath`. */
export declare const SOURCES: readonly ["auto", "wsl", "git-bash", "cygwin", "custom"];
/** One selectable bash source. */
export type Source = (typeof SOURCES)[number];
/**
 * How a candidate is launched: `native` spawns the bash-compatible executable
 * directly (Git for Windows, Cygwin, any user-provided bash), `wsl` routes
 * through a WSL launcher and needs distribution selection and environment
 * forwarding.
 */
export type BashKind = 'native' | 'wsl';
/** One launchable bash candidate before probing. */
export interface BashCandidate {
    /** Absolute executable path. */
    exe: string;
    /** Launch shape this candidate needs. */
    kind: BashKind;
    /** Human-readable provenance used in logs and error messages. */
    label: string;
}
/** A candidate that passed the probe, plus the facts the executor needs. */
export interface BashTarget extends BashCandidate {
    /** Shell family reported by `$OSTYPE` (`msys`, `cygwin`, `linux-gnu`, ...). */
    family: string;
    /** The configured source that produced this target. */
    source: Source;
    /** Whether commands run as a login shell (`-lc`) instead of `-c`. */
    loginShell: boolean;
    /** WSL distribution to select; empty means the default distribution. */
    wslDistro: string;
}
/** One probe attempt's outcome. */
export interface ProbeResult {
    /** Whether the candidate is a working bash. */
    ok: boolean;
    /** `$OSTYPE` reported by the shell, or `unknown`. */
    family: string;
    /** Single-line failure detail used in aggregated errors. */
    detail: string;
}
/** Injected side effects for {@link resolveBashTarget}. */
export interface ResolveDeps {
    /** Environment used to derive well-known install locations. */
    env: NodeJS.ProcessEnv;
    /** Platform to resolve for. */
    platform: NodeJS.Platform;
    /** Filesystem existence check for one candidate path. */
    exists: (path: string) => boolean;
    /** Run one candidate's probe argv and report whether it produced the marker. */
    probe: (candidate: BashCandidate, argv: readonly string[], timeoutMs: number) => Promise<ProbeResult>;
}
/** Resolution input derived from the validated plugin config. */
export interface ResolveOptions {
    source: Source;
    bashPath: string;
    wslDistro: string;
    loginShell: boolean;
    /** Probe each candidate (detect its family and reject broken launches) instead of trusting the first existing path. */
    verify: boolean;
    probeTimeoutMs: number;
}
/**
 * Terminal environment overrides a WSL launch must forward, mirroring the
 * keys of `ENV_OVERRIDES` owned by `@deepseek-ai/dsh-bash-local` (kept in sync
 * by hand: WSL does not inherit the Windows environment).
 */
export declare const TERMINAL_ENV_KEYS: readonly ["NO_COLOR", "TERM", "PAGER", "GIT_PAGER"];
/** Whether an executable is the modern WSL launcher rather than a WSL bash launcher. */
export declare function isWslLauncher(exe: string): boolean;
/**
 * Candidate executables for a source, in resolution order. `auto` probes native
 * Windows bash implementations first (Git for Windows, then Cygwin) and falls
 * back to WSL, because a native bash shares the Windows filesystem, PATH and
 * process model with the harness.
 * @param source - configured source; `custom` contributes no candidates.
 * @param env - environment used to derive install locations.
 * @param platform - host platform; candidates exist only on Windows.
 * @returns deduplicated candidates, or an empty list for `custom`/non-Windows.
 */
export declare function candidatePaths(source: Source, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): BashCandidate[];
/**
 * Build the argv that probes one candidate. The probe never loads a login
 * profile: it only has to prove the executable starts and reaches bash.
 * @param candidate - candidate to probe.
 * @param wslDistro - distribution a WSL launcher selects; empty means default.
 * @returns the exact probe argv.
 */
export declare function probeArgv(candidate: BashCandidate, wslDistro: string): string[];
/**
 * Parse probe stdout into its family and success flag.
 * @param stdout - captured probe output.
 * @returns the parsed probe result without the marker line.
 */
export declare function parseProbe(stdout: string): {
    ok: boolean;
    family: string;
};
/**
 * Resolve the configured source to the first candidate that exists and passes
 * its probe.
 * @param options - validated plugin config subset.
 * @param deps - injected filesystem/probe side effects.
 * @returns the working target.
 * @throws Error naming every candidate that was tried and why it failed.
 */
export declare function resolveBashTarget(options: ResolveOptions, deps?: ResolveDeps): Promise<BashTarget>;
/**
 * Build the exact shell invocation for one command.
 * @param target - resolved bash target.
 * @param command - the command string to run.
 * @returns the argv handed to the subprocess service.
 */
export declare function buildInvocation(target: BashTarget, command: string): string[];
/**
 * Translate a POSIX-style absolute `workdir` back to the Windows path the
 * subprocess service needs, so a model that thinks in its shell's path syntax
 * can still target its own workspace.
 *
 * `/mnt/<drive>/...` (WSL) and `/cygdrive/<drive>/...` (Cygwin) are
 * unambiguous and always translated. Git Bash's `/<drive>/...` form is only
 * translated for an explicit `git-bash`/`cygwin` source: in `auto` mode the
 * same shape is a legitimate Windows path rooted on the current drive.
 * @param workdir - the requested working directory.
 * @param source - configured source (decides the single-letter form).
 * @returns the Windows path, or `workdir` unchanged when no rule matches.
 */
export declare function translateWorkdir(workdir: string, source: Source): string;
/**
 * Build the environment additions a WSL launch needs: the Windows environment
 * is not inherited by the Linux process, so the DSH environment facts and the
 * terminal overrides ride through `WSLENV`.
 * @param input - the explicit env/dsh env maps of the execution and any inherited `WSLENV`.
 * @returns the `WSLENV` mapping plus `WSL_UTF8`, or just `WSL_UTF8` when nothing is forwarded.
 */
export declare function buildWslEnv(input: {
    /** Explicit command environment; only its variable NAMES are used. */
    env?: object | undefined;
    /** Managed `DSH_*` snapshot; only its variable NAMES are used. */
    dshEnv?: object | undefined;
    /** Ambient `WSLENV` whose entries are preserved ahead of the forwarded names. */
    inheritedWslEnv?: string | undefined;
}): Record<string, string>;
/**
 * The production probe: spawn the candidate with its probe argv under a
 * bounded timeout and look for the marker on stdout.
 * @param candidate - candidate being probed.
 * @param argv - exact probe argv.
 * @param timeoutMs - positive probe timeout.
 * @returns the probe result; spawn failures and timeouts report `ok: false`.
 */
export declare function probeCandidate(candidate: BashCandidate, argv: readonly string[], timeoutMs: number): Promise<ProbeResult>;
/**
 * Production side effects for {@link resolveBashTarget}.
 * @returns filesystem and process probe implementations backed by Node.
 */
export declare function defaultResolveDeps(): ResolveDeps;
