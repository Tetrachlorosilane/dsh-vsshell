// Run every tests/*.test.mjs file in this single process.
//
// `node --test` spawns one child per file, and a child-spawn inside the DSH
// Windows sandbox fails with EPERM (restricted-token pipe creation). Importing
// the files directly keeps `node:test` in-process, so the same command works
// both in a normal shell and from inside the harness.
import { readdirSync } from 'node:fs'

const directory = new URL('../tests/', import.meta.url)
const files = readdirSync(directory).filter(name => name.endsWith('.test.mjs')).sort()

for (const file of files) {
  process.stdout.write(`\n# ${file}\n`)
  await import(new URL(file, directory))
}
