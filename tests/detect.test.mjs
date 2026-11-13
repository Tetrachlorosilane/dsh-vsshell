// Unit tests for the pure resolution rules in src/detect.ts.
//
// No test starts a real shell: every filesystem and probe side effect is
// injected. The real spawn lives in scripts/smoke-executor.mjs, which needs an
// unconfined token (see AGENTS.md section 3).
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  PROBE_MARKER,
  buildInvocation,
  buildWslEnv,
  candidatePaths,
  parseProbe,
  probeArgv,
  resolveBashTarget,
  translateWorkdir,
} from '../lib/detect.js'

const WIN_ENV = {
  ProgramFiles: 'C:\\Program Files',
  'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\tester\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\tester',
  SystemRoot: 'C:\\Windows',
  SystemDrive: 'C:',
}

/** Build a target fixture. */
function target(overrides = {}) {
  return {
    exe: 'C:\\Program Files\\Git\\bin\\bash.exe',
    kind: 'native',
    label: 'git-bash',
    family: 'msys',
    source: 'auto',
    loginShell: true,
    wslDistro: '',
    ...overrides,
  }
}

/** Build injected deps whose existence check only knows the given paths. */
function deps({ existing = [], probe } = {}) {
  const normalized = new Set(existing.map(path => path.toLowerCase()))
  return {
    env: WIN_ENV,
    platform: 'win32',
    exists: path => normalized.has(path.toLowerCase()),
    probe: probe ?? (async () => ({ ok: true, family: 'msys', detail: '' })),
  }
}

test('candidatePaths: auto prefers Git Bash, then Cygwin, then WSL', () => {
  const candidates = candidatePaths('auto', WIN_ENV, 'win32')
  const labels = candidates.map(candidate => candidate.label)
  assert.equal(labels[0], 'git-bash')
  assert.ok(labels.includes('cygwin'))
  assert.equal(labels.at(-1), 'wsl-bash-launcher')
  assert.equal(new Set(candidates.map(candidate => candidate.exe.toLowerCase())).size, candidates.length, 'deduplicated')
  assert.equal(candidates.find(candidate => candidate.label === 'git-bash')?.exe, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.equal(candidates.find(candidate => candidate.label === 'wsl')?.kind, 'wsl')
})

test('candidatePaths: explicit sources list only their own implementations', () => {
  const cygwin = candidatePaths('cygwin', WIN_ENV, 'win32')
  assert.ok(cygwin.length > 0)
  assert.ok(cygwin.every(candidate => candidate.label === 'cygwin'))
  assert.ok(cygwin.some(candidate => candidate.exe === 'C:\\cygwin64\\bin\\bash.exe'))
  assert.deepEqual(candidatePaths('custom', WIN_ENV, 'win32'), [])
  assert.deepEqual(candidatePaths('auto', WIN_ENV, 'linux'), [], 'no Windows candidates off Windows')
})

test('probeArgv: native, WSL launcher with and without a distribution, legacy launcher', () => {
  const native = probeArgv({ exe: 'C:\\Program Files\\Git\\bin\\bash.exe', kind: 'native', label: 'git-bash' }, '')
  assert.deepEqual(native.slice(0, 2), ['C:\\Program Files\\Git\\bin\\bash.exe', '-c'])
  assert.ok(native[2].includes(PROBE_MARKER))

  const wsl = probeArgv({ exe: 'C:\\Windows\\System32\\wsl.exe', kind: 'wsl', label: 'wsl' }, 'Ubuntu')
  assert.deepEqual(wsl.slice(0, 6), ['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-c'])

  const defaultDistro = probeArgv({ exe: 'C:\\Windows\\System32\\wsl.exe', kind: 'wsl', label: 'wsl' }, '')
  assert.deepEqual(defaultDistro.slice(0, 4), ['C:\\Windows\\System32\\wsl.exe', '--exec', 'bash', '-c'])

  const legacy = probeArgv({ exe: 'C:\\Windows\\System32\\bash.exe', kind: 'wsl', label: 'wsl-bash-launcher' }, '')
  assert.deepEqual(legacy.slice(0, 2), ['C:\\Windows\\System32\\bash.exe', '-c'])
})

test('parseProbe: extracts the family from the marker line', () => {
  assert.deepEqual(parseProbe(`${PROBE_MARKER}:msys\n`), { ok: true, family: 'msys' })
  assert.deepEqual(parseProbe(`noise\r\n${PROBE_MARKER}:linux-gnu\r\n`), { ok: true, family: 'linux-gnu' })
  assert.deepEqual(parseProbe(`${PROBE_MARKER}:\n`), { ok: true, family: 'unknown' })
  assert.deepEqual(parseProbe('nothing here'), { ok: false, family: 'unknown' })
})

test('buildInvocation: login flag, WSL distro selection, legacy launcher shape', () => {
  assert.deepEqual(
    buildInvocation(target(), 'echo hi'),
    ['C:\\Program Files\\Git\\bin\\bash.exe', '-lc', 'echo hi'],
  )
  assert.deepEqual(
    buildInvocation(target({ loginShell: false }), 'echo hi'),
    ['C:\\Program Files\\Git\\bin\\bash.exe', '-c', 'echo hi'],
  )
  const wsl = target({ exe: 'C:\\Windows\\System32\\wsl.exe', kind: 'wsl', family: 'linux-gnu', wslDistro: 'Ubuntu' })
  assert.deepEqual(
    buildInvocation(wsl, 'echo hi'),
    ['C:\\Windows\\System32\\wsl.exe', '-d', 'Ubuntu', '--exec', 'bash', '-lc', 'echo hi'],
  )
  const legacy = target({ exe: 'C:\\Windows\\System32\\bash.exe', kind: 'wsl', family: 'linux-gnu' })
  assert.deepEqual(buildInvocation(legacy, 'echo hi'), ['C:\\Windows\\System32\\bash.exe', '-lc', 'echo hi'])
})

test('translateWorkdir: WSL and Cygwin prefixes always translate', () => {
  assert.equal(translateWorkdir('/mnt/c/Users/tester/project', 'auto'), 'C:\\Users\\tester\\project')
  assert.equal(translateWorkdir('/mnt/d', 'auto'), 'D:\\')
  assert.equal(translateWorkdir('/cygdrive/e/a/b', 'auto'), 'E:\\a\\b')
})

test('translateWorkdir: single-letter drive only for explicit Git Bash/Cygwin', () => {
  assert.equal(translateWorkdir('/c/Users/tester', 'git-bash'), 'C:\\Users\\tester')
  assert.equal(translateWorkdir('/c/Users/tester', 'cygwin'), 'C:\\Users\\tester')
  assert.equal(translateWorkdir('/c/Users/tester', 'auto'), '/c/Users/tester')
  // Bare drive roots are valid workdir values too.
  assert.equal(translateWorkdir('/c', 'git-bash'), 'C:\\')
  assert.equal(translateWorkdir('/c/', 'git-bash'), 'C:\\')
  assert.equal(translateWorkdir('/d', 'cygwin'), 'D:\\')
  assert.equal(translateWorkdir('/c', 'auto'), '/c')
  assert.equal(translateWorkdir('/home/tester', 'git-bash'), '/home/tester')
  assert.equal(translateWorkdir('C:\\Users\\tester', 'git-bash'), 'C:\\Users\\tester')
  assert.equal(translateWorkdir('relative/dir', 'auto'), 'relative/dir')
})

test('buildWslEnv: forwards DSH_*, caller env and terminal overrides through WSLENV', () => {
  const env = buildWslEnv({
    env: { HOOK_VALUE: '1' },
    dshEnv: { DSH_PROFILE: 'desktop', DSH_SESSION_ID: 'abc' },
  })
  assert.equal(env.WSL_UTF8, '1')
  const names = env.WSLENV.split(':')
  for (const expected of ['HOOK_VALUE', 'DSH_PROFILE', 'DSH_SESSION_ID', 'NO_COLOR', 'TERM', 'PAGER', 'GIT_PAGER']) {
    assert.ok(names.includes(expected), `WSLENV should forward ${expected}`)
  }
  assert.ok(!names.includes('WSLENV'))
  assert.ok(!names.includes('WSL_UTF8'))
})

test('buildWslEnv: preserves inherited entries and deduplicates by name', () => {
  const env = buildWslEnv({
    dshEnv: { DSH_PROFILE: 'desktop' },
    inheritedWslEnv: 'HTTP_PROXY/p:DSH_PROFILE',
  })
  const names = env.WSLENV.split(':')
  assert.equal(names[0], 'HTTP_PROXY/p', 'inherited mapping keeps its flags and position')
  assert.equal(names.filter(name => name.split('/')[0] === 'DSH_PROFILE').length, 1)
})

test('buildWslEnv: always asks for UTF-8 diagnostics and the terminal overrides', () => {
  const env = buildWslEnv({})
  assert.equal(env.WSL_UTF8, '1')
  assert.deepEqual(env.WSLENV.split(':'), ['GIT_PAGER', 'NO_COLOR', 'PAGER', 'TERM'])
})

test('resolveBashTarget: explicit bashPath is trusted and probed once', async () => {
  const probed = []
  const resolved = await resolveBashTarget(
    { source: 'git-bash', bashPath: 'D:\\tools\\bash.exe', wslDistro: '', loginShell: false, verify: true, probeTimeoutMs: 1000 },
    deps({
      existing: ['D:\\tools\\bash.exe'],
      probe: async (candidate, argv) => { probed.push({ candidate, argv }); return { ok: true, family: 'msys', detail: '' } },
    }),
  )
  assert.equal(resolved.exe, 'D:\\tools\\bash.exe')
  assert.equal(resolved.family, 'msys')
  assert.equal(resolved.kind, 'native')
  assert.equal(resolved.loginShell, false)
  assert.equal(probed.length, 1)
  assert.equal(probed[0].argv[1], '-c', 'the probe never loads a login profile')
})

test('resolveBashTarget: auto falls through a failing candidate to the next existing one', async () => {
  const seen = []
  const resolved = await resolveBashTarget(
    { source: 'auto', bashPath: '', wslDistro: '', loginShell: true, verify: true, probeTimeoutMs: 1000 },
    deps({
      existing: ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe'],
      probe: async (candidate) => {
        seen.push(candidate.exe)
        return candidate.label === 'git-bash'
          ? { ok: false, family: 'unknown', detail: 'could not start' }
          : { ok: true, family: 'cygwin', detail: '' }
      },
    }),
  )
  assert.deepEqual(seen, ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\cygwin64\\bin\\bash.exe'])
  assert.equal(resolved.family, 'cygwin')
})

test('resolveBashTarget: a WSL launcher keeps its kind and distribution', async () => {
  const resolved = await resolveBashTarget(
    { source: 'wsl', bashPath: '', wslDistro: ' Ubuntu ', loginShell: true, verify: true, probeTimeoutMs: 1000 },
    deps({
      existing: ['C:\\Windows\\System32\\wsl.exe'],
      probe: async () => ({ ok: true, family: 'linux-gnu', detail: '' }),
    }),
  )
  assert.equal(resolved.kind, 'wsl')
  assert.equal(resolved.family, 'linux-gnu')
  assert.equal(resolved.wslDistro, 'Ubuntu')
})

test('resolveBashTarget: a System32 bash.exe reporting linux-gnu is treated as WSL', async () => {
  const resolved = await resolveBashTarget(
    { source: 'custom', bashPath: 'C:\\Windows\\System32\\bash.exe', wslDistro: '', loginShell: true, verify: true, probeTimeoutMs: 1000 },
    deps({
      existing: ['C:\\Windows\\System32\\bash.exe'],
      probe: async () => ({ ok: true, family: 'linux-gnu', detail: '' }),
    }),
  )
  assert.equal(resolved.kind, 'wsl')
  assert.equal(resolved.label, 'bashPath')
})

test('resolveBashTarget: all candidates failing aggregates candidate paths and reasons', async () => {
  await assert.rejects(
    resolveBashTarget(
      { source: 'auto', bashPath: '', wslDistro: '', loginShell: true, verify: true, probeTimeoutMs: 1000 },
      deps({
        existing: ['C:\\Program Files\\Git\\bin\\bash.exe'],
        probe: async () => ({ ok: false, family: 'unknown', detail: 'couldn\'t create signal pipe' }),
      }),
    ),
    (error) => {
      assert.ok(error instanceof Error)
      assert.match(error.message, /no usable bash found for source "auto"/u)
      assert.match(error.message, /Git\\bin\\bash\.exe .*couldn't create signal pipe/u)
      return true
    },
  )
})

test('resolveBashTarget: source "custom" without a path fails loudly', async () => {
  await assert.rejects(
    resolveBashTarget(
      { source: 'custom', bashPath: '  ', wslDistro: '', loginShell: true, verify: true, probeTimeoutMs: 1000 },
      deps(),
    ),
    /source "custom" requires a non-empty bashPath/u,
  )
})

test('resolveBashTarget: a configured but missing bashPath reports "not found"', async () => {
  await assert.rejects(
    resolveBashTarget(
      { source: 'custom', bashPath: 'D:\\missing\\bash.exe', wslDistro: '', loginShell: true, verify: true, probeTimeoutMs: 1000 },
      deps(),
    ),
    /D:\\missing\\bash\.exe \(not found\)/u,
  )
})

test('resolveBashTarget: verify false trusts the first existing candidate without probing', async () => {
  let probes = 0
  const resolved = await resolveBashTarget(
    { source: 'git-bash', bashPath: '', wslDistro: '', loginShell: true, verify: false, probeTimeoutMs: 1000 },
    deps({
      existing: ['C:\\Program Files\\Git\\bin\\bash.exe'],
      probe: async () => { probes += 1; return { ok: true, family: 'msys', detail: '' } },
    }),
  )
  assert.equal(resolved.exe, 'C:\\Program Files\\Git\\bin\\bash.exe')
  assert.equal(resolved.family, 'unknown')
  assert.equal(probes, 0, 'verify: false must not probe')
})

test('resolveBashTarget: verify false trusts an explicit bashPath even when it is missing', async () => {
  const resolved = await resolveBashTarget(
    { source: 'custom', bashPath: 'D:\\tools\\bash.exe', wslDistro: '', loginShell: true, verify: false, probeTimeoutMs: 1000 },
    deps(),
  )
  assert.equal(resolved.exe, 'D:\\tools\\bash.exe')
  assert.equal(resolved.kind, 'native')
  assert.equal(resolved.family, 'unknown')
})
