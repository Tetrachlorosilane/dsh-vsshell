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
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
/** stdout token that identifies a working bash during the probe. */
export const PROBE_MARKER = '__vsshell_probe__';
/** Selectable bash sources; `custom` requires an explicit `bashPath`. */
export const SOURCES = ['auto', 'wsl', 'git-bash', 'cygwin', 'custom'];
/**
 * Terminal environment overrides a WSL launch must forward, mirroring the
 * keys of `ENV_OVERRIDES` owned by `@deepseek-ai/dsh-bash-local` (kept in sync
 * by hand: WSL does not inherit the Windows environment).
 */
export const TERMINAL_ENV_KEYS = ['NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER'];
/** Whether an executable is the modern WSL launcher rather than a WSL bash launcher. */
export function isWslLauncher(exe) {
    return basename(exe).toLowerCase() === 'wsl.exe';
}
/** Derive the well-known Windows roots, falling back to their conventional locations. */
function rootsOf(env) {
    const userProfile = env.USERPROFILE ?? homedir();
    return {
        programFiles: env.ProgramFiles ?? 'C:\\Program Files',
        programFilesX86: env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
        localAppData: env.LOCALAPPDATA ?? join(userProfile, 'AppData', 'Local'),
        userProfile,
        systemRoot: env.SystemRoot ?? 'C:\\Windows',
        systemDrive: env.SystemDrive ?? 'C:',
    };
}
/** Candidate executables for one concrete source (never `auto`). */
function candidatesFor(source, roots) {
    switch (source) {
        case 'git-bash':
            return [
                join(roots.programFiles, 'Git', 'bin', 'bash.exe'),
                join(roots.programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
                join(roots.programFilesX86, 'Git', 'bin', 'bash.exe'),
                join(roots.localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
                join(roots.userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
            ].map(exe => ({ exe, kind: 'native', label: 'git-bash' }));
        case 'cygwin': {
            const drive = roots.systemDrive.endsWith('\\') ? roots.systemDrive.slice(0, -1) : roots.systemDrive;
            return [
                `${drive}\\cygwin64\\bin\\bash.exe`,
                `${drive}\\cygwin\\bin\\bash.exe`,
                join(roots.programFiles, 'Cygwin64', 'bin', 'bash.exe'),
                join(roots.programFiles, 'Cygwin', 'bin', 'bash.exe'),
            ].map(exe => ({ exe, kind: 'native', label: 'cygwin' }));
        }
        case 'wsl':
            return [
                { exe: join(roots.systemRoot, 'System32', 'wsl.exe'), kind: 'wsl', label: 'wsl' },
                { exe: join(roots.systemRoot, 'System32', 'bash.exe'), kind: 'wsl', label: 'wsl-bash-launcher' },
            ];
        case 'custom':
            return [];
    }
}
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
export function candidatePaths(source, env = process.env, platform = process.platform) {
    if (platform !== 'win32' || source === 'custom')
        return [];
    const roots = rootsOf(env);
    const sources = source === 'auto'
        ? ['git-bash', 'cygwin', 'wsl']
        : [source];
    const seen = new Set();
    const candidates = [];
    for (const one of sources) {
        for (const candidate of candidatesFor(one, roots)) {
            const key = candidate.exe.toLowerCase();
            if (seen.has(key))
                continue;
            seen.add(key);
            candidates.push(candidate);
        }
    }
    return candidates;
}
/** The one-line shell program the probe runs; `$OSTYPE` identifies the family. */
function probeScript() {
    return `printf '${PROBE_MARKER}:%s\\n' "\${OSTYPE:-unknown}"`;
}
/**
 * Build the argv that probes one candidate. The probe never loads a login
 * profile: it only has to prove the executable starts and reaches bash.
 * @param candidate - candidate to probe.
 * @param wslDistro - distribution a WSL launcher selects; empty means default.
 * @returns the exact probe argv.
 */
export function probeArgv(candidate, wslDistro) {
    const script = probeScript();
    if (candidate.kind === 'native')
        return [candidate.exe, '-c', script];
    if (isWslLauncher(candidate.exe)) {
        return [candidate.exe, ...(wslDistro.trim() === '' ? [] : ['-d', wslDistro.trim()]), '--exec', 'bash', '-c', script];
    }
    return [candidate.exe, '-c', script];
}
/**
 * Parse probe stdout into its family and success flag.
 * @param stdout - captured probe output.
 * @returns the parsed probe result without the marker line.
 */
export function parseProbe(stdout) {
    for (const line of stdout.split(/\r?\n/u)) {
        if (!line.startsWith(`${PROBE_MARKER}:`))
            continue;
        const family = line.slice(PROBE_MARKER.length + 1).trim();
        return { ok: true, family: family === '' ? 'unknown' : family };
    }
    return { ok: false, family: 'unknown' };
}
/**
 * Correct a candidate's launch shape from evidence: any bash that reports a
 * Linux `$OSTYPE` and lives in `System32` is actually the WSL launcher, even
 * when the user configured it as a custom or native path.
 */
function effectiveKind(candidate, family) {
    if (candidate.kind === 'wsl')
        return 'wsl';
    if (family !== 'linux-gnu')
        return 'native';
    return isWslLauncher(candidate.exe) || /[\\/]System32[\\/]bash\.exe$/iu.test(candidate.exe) ? 'wsl' : 'native';
}
/**
 * Resolve the configured source to the first candidate that exists and passes
 * its probe.
 * @param options - validated plugin config subset.
 * @param deps - injected filesystem/probe side effects.
 * @returns the working target.
 * @throws Error naming every candidate that was tried and why it failed.
 */
export async function resolveBashTarget(options, deps = defaultResolveDeps()) {
    const explicit = options.bashPath.trim();
    const failures = [];
    /** Finish a candidate without probing it: used by `verify: false` and the explicit-path fast path. */
    const trusted = (candidate, family) => ({
        ...candidate,
        kind: effectiveKind(candidate, family),
        family,
        source: options.source,
        loginShell: options.loginShell,
        wslDistro: options.wslDistro.trim(),
    });
    let candidates;
    if (explicit !== '') {
        const kind = options.source === 'wsl' || (options.source === 'auto' && isWslLauncher(explicit)) ? 'wsl' : 'native';
        if (!options.verify)
            return trusted({ exe: explicit, kind, label: 'bashPath' }, 'unknown');
        candidates = [{ exe: explicit, kind, label: 'bashPath' }];
    }
    else if (options.source === 'custom') {
        throw new Error('vsshell: source "custom" requires a non-empty bashPath');
    }
    else {
        candidates = candidatePaths(options.source, deps.env, deps.platform);
    }
    if (candidates.length === 0) {
        throw new Error(`vsshell: no bash candidate is available for source "${options.source}" on ${deps.platform}`);
    }
    for (const candidate of candidates) {
        if (!deps.exists(candidate.exe)) {
            failures.push(`${candidate.label}: ${candidate.exe} (not found)`);
            continue;
        }
        if (!options.verify)
            return trusted(candidate, 'unknown');
        const argv = probeArgv(candidate, options.wslDistro);
        const result = await deps.probe(candidate, argv, options.probeTimeoutMs);
        if (result.ok)
            return trusted(candidate, result.family);
        failures.push(`${candidate.label}: ${candidate.exe} (${result.detail === '' ? 'probe failed' : result.detail})`);
    }
    throw new Error(`vsshell: no usable bash found for source "${options.source}". Tried:\n  ${failures.join('\n  ')}`);
}
/**
 * Build the exact shell invocation for one command.
 * @param target - resolved bash target.
 * @param command - the command string to run.
 * @returns the argv handed to the subprocess service.
 */
export function buildInvocation(target, command) {
    const flag = target.loginShell ? '-lc' : '-c';
    if (target.kind === 'native')
        return [target.exe, flag, command];
    const distro = target.wslDistro.trim();
    if (isWslLauncher(target.exe)) {
        return [target.exe, ...(distro === '' ? [] : ['-d', distro]), '--exec', 'bash', flag, command];
    }
    return [target.exe, flag, command];
}
/** Convert one POSIX drive prefix match into its Windows path. */
function windowsDrivePath(letter, rest) {
    const suffix = (rest ?? '').replace(/\//gu, '\\');
    return suffix === '' ? `${letter.toUpperCase()}:\\` : `${letter.toUpperCase()}:\\${suffix}`;
}
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
export function translateWorkdir(workdir, source) {
    const wsl = /^\/mnt\/([A-Za-z])(?:\/(.*))?$/u.exec(workdir);
    if (wsl !== null)
        return windowsDrivePath(wsl[1], wsl[2]);
    const cygwin = /^\/cygdrive\/([A-Za-z])(?:\/(.*))?$/u.exec(workdir);
    if (cygwin !== null)
        return windowsDrivePath(cygwin[1], cygwin[2]);
    if (source === 'git-bash' || source === 'cygwin') {
        // The optional rest also covers the bare drive roots `/c` and `/c/`.
        const msys = /^\/([A-Za-z])(?:\/(.*))?$/u.exec(workdir);
        if (msys !== null)
            return windowsDrivePath(msys[1], msys[2]);
    }
    return workdir;
}
/**
 * Build the environment additions a WSL launch needs: the Windows environment
 * is not inherited by the Linux process, so the DSH environment facts and the
 * terminal overrides ride through `WSLENV`.
 * @param input - the explicit env/dsh env maps of the execution and any inherited `WSLENV`.
 * @returns the `WSLENV` mapping plus `WSL_UTF8`, or just `WSL_UTF8` when nothing is forwarded.
 */
export function buildWslEnv(input) {
    const names = new Set();
    const collect = (record) => {
        if (record === undefined)
            return;
        for (const name of Object.keys(record)) {
            if (name === '' || name === 'WSLENV' || name === 'WSL_UTF8')
                continue;
            names.add(name);
        }
    };
    collect(input.env);
    collect(input.dshEnv);
    for (const name of TERMINAL_ENV_KEYS)
        names.add(name);
    const entries = [];
    const seen = new Set();
    const push = (entry) => {
        const name = entry.split('/')[0] ?? '';
        if (name === '' || seen.has(name.toLowerCase()))
            return;
        seen.add(name.toLowerCase());
        entries.push(entry);
    };
    for (const entry of (input.inheritedWslEnv ?? '').split(':')) {
        const trimmed = entry.trim();
        if (trimmed !== '')
            push(trimmed);
    }
    for (const name of [...names].sort())
        push(name);
    return entries.length === 0
        ? { WSL_UTF8: '1' }
        : { WSLENV: entries.join(':'), WSL_UTF8: '1' };
}
/** One-line, bounded failure text for aggregated resolution errors (keeps the tail). */
function failureDetail(stderr, stdout, fallback) {
    const text = (stderr.trim() !== '' ? stderr : stdout).trim().replace(/\s+/gu, ' ');
    if (text === '')
        return fallback;
    return text.length > 300 ? `...${text.slice(-300)}` : text;
}
/** Probe environment: quiet, and UTF-8 WSL diagnostics where a WSL launcher is used. */
function probeEnv(candidate) {
    return { ...process.env, NO_COLOR: '1', ...candidate.kind === 'wsl' ? { WSL_UTF8: '1' } : {} };
}
/**
 * The production probe: spawn the candidate with its probe argv under a
 * bounded timeout and look for the marker on stdout.
 * @param candidate - candidate being probed.
 * @param argv - exact probe argv.
 * @param timeoutMs - positive probe timeout.
 * @returns the probe result; spawn failures and timeouts report `ok: false`.
 */
export function probeCandidate(candidate, argv, timeoutMs) {
    return new Promise((resolve) => {
        const [program, ...args] = argv;
        if (program === undefined) {
            resolve({ ok: false, family: 'unknown', detail: 'empty probe argv' });
            return;
        }
        let settled = false;
        let stdout = '';
        let stderr = '';
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve(result);
        };
        const child = spawn(program, args, { env: probeEnv(candidate), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
            child.kill();
            finish({ ok: false, family: 'unknown', detail: `probe timed out after ${String(timeoutMs)}ms` });
        }, timeoutMs);
        child.stdout?.setEncoding('utf8');
        child.stderr?.setEncoding('utf8');
        child.stdout?.on('data', (chunk) => { if (stdout.length < 8192)
            stdout += chunk; });
        child.stderr?.on('data', (chunk) => { if (stderr.length < 8192)
            stderr += chunk; });
        child.on('error', (error) => {
            finish({ ok: false, family: 'unknown', detail: failureDetail('', error.message, 'spawn failed') });
        });
        child.on('close', (code) => {
            const parsed = parseProbe(stdout);
            finish({
                ok: parsed.ok && code === 0,
                family: parsed.family,
                detail: failureDetail(stderr, stdout, `exit code ${String(code)} without the probe marker`),
            });
        });
    });
}
/**
 * Production side effects for {@link resolveBashTarget}.
 * @returns filesystem and process probe implementations backed by Node.
 */
export function defaultResolveDeps() {
    return {
        env: process.env,
        platform: process.platform,
        exists: path => existsSync(path),
        probe: probeCandidate,
    };
}
