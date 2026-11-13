// `pnpm run check`: the repository's full static gate, in one process tree.
//
//   typecheck -> build -> emitted-syntax check -> unit tests -> patch structure
//
// Everything is spawned as a direct child of this process (no shell, no nested
// package manager), so the same sequence works from a normal terminal and from
// inside the harness' sandboxed shell, where only captured-child pipes are
// restricted — inherited stdio is fine.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const node = process.execPath

/** Resolve a repository-relative path. */
const path = relative => fileURLToPath(new URL(relative, import.meta.url))

/** Run one command with inherited stdio and abort the gate on the first failure. */
function run(label, args) {
  process.stdout.write(`\n== ${label}\n`)
  const result = spawnSync(node, args, { cwd: repo, stdio: 'inherit' })
  if (result.error !== undefined) {
    console.error(`FAILED: ${label}: ${result.error.message}`)
    process.exit(1)
  }
  if (result.status !== 0) {
    console.error(`FAILED: ${label} (exit ${String(result.status)})`)
    process.exit(result.status ?? 1)
  }
}

const tsc = path('../node_modules/typescript/bin/tsc')
if (!existsSync(tsc)) {
  console.error(`FAILED: typescript is not installed (${tsc}); run pnpm install first`)
  process.exit(1)
}

run('typecheck (tsc --noEmit)', [tsc, '-p', 'tsconfig.json', '--noEmit'])
run('build (tsc)', [tsc, '-p', 'tsconfig.json'])
run('syntax: lib/index.js', ['--check', 'lib/index.js'])
run('syntax: lib/detect.js', ['--check', 'lib/detect.js'])
run('syntax: lib/panel.js', ['--check', 'lib/panel.js'])
run('syntax: client.js', ['--check', 'client.js'])
run('unit tests', ['scripts/test.mjs'])
run('patch structure, target version and freshness', ['scripts/check-patch.mjs'])

process.stdout.write('\ncheck: PASS\n')
