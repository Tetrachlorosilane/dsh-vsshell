#!/usr/bin/env node
/**
 * Validate this bundle's `cordis.patch.yml`.
 *
 * Three independent checks (docs/design.md section 9, AGENTS.md section 5):
 *   1. structure assertions — the host rows, the vsshell insert row, and the
 *      standard/ptc/cordis preset overrides are exactly what the bundle needs
 *      (and no `preset-minimal` row appears);
 *   2. target-version assertions — the generated header names the DSH version of
 *      the checked-in preset snapshot, and that version equals the pinned
 *      `@deepseek-ai/dsh-bash-local` devDependency (so a snapshot taken from a
 *      different DSH release cannot pass silently);
 *   3. generation consistency — the file is byte-for-byte what
 *      `scripts/gen-preset-patch.mjs` renders from the checked-in preset snapshot.
 *
 * A failed check is a real failure; do not relax an assertion to make the
 * command green (AGENTS.md section 5.3).
 *
 * Usage: node scripts/check-patch.mjs [--file <patch.yml>] [--source <preset snapshot | DSH checkout>]
 */

import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  COVERED_PRESETS,
  DEFAULT_OUT,
  DEFAULT_SOURCE,
  PRESET_PLUGIN_NAME,
  REPO_ROOT,
  VSSHELL_PANEL_PLUGIN_NAME,
  VSSHELL_PLUGIN_NAME,
  compareTexts,
  generatePatch,
  isJsExpression,
  parsePatchYaml,
  printDifference,
  readDshVersion,
} from './gen-preset-patch.mjs'

/** Host rows the bundle disables, with the plugin name each row must assert. */
const DISABLED_HOST_ROWS = [
  { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox' },
  { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh' },
]

/**
 * Host tool-bash row: always enabled. In a Web/preset composition the preset's
 * same-named row shadows this one in the agent scope; only a duplicate inside one
 * scope is an error.
 */
const HOST_TOOL_BASH = {
  id: 'tool-bash',
  name: '@deepseek-ai/dsh-tool-bash',
}

/** The pinned devDependency whose version defines the supported DSH runtime. */
const PINNED_DSH_PACKAGE = '@deepseek-ai/dsh-bash-local'

/** The generated header line that records the target DSH version. */
const VERSION_LINE = /^# 目标 DSH 版本：(\S+?)；/mu

/** The inserted host rows: the executor and the configuration panel's host half. */
const VSSHELL_ROWS = [
  { id: 'dsh-vsshell', name: VSSHELL_PLUGIN_NAME, purpose: 'executor' },
  { id: 'dsh-vsshell-panel', name: VSSHELL_PANEL_PLUGIN_NAME, purpose: 'configuration panel host' },
]

/**
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether `value` is a plain mapping.
 */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsExpression(value)
}

/**
 * Render a value for inclusion in a problem message.
 * @param {unknown} value - offending value.
 * @returns {string} readable description.
 */
function describe(value) {
  if (isJsExpression(value)) return `!!js ${JSON.stringify(value.expression)}`
  if (typeof value === 'undefined') return '（缺省）'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/**
 * Structural assertions for a parsed patch document.
 * @param {unknown} rows - parsed top-level patch value.
 * @returns {string[]} human-readable problems; empty when the structure is correct.
 */
export function validatePatchStructure(rows) {
  /** @type {string[]} */
  const problems = []
  if (!Array.isArray(rows)) {
    problems.push('顶层必须是 YAML 数组')
    return problems
  }
  rows.forEach((row, index) => {
    if (!isMapping(row)) problems.push(`第 ${index + 1} 个顶层条目必须是映射`)
  })
  /** @param {string} id - top-level row id. */
  const findTop = (id) => rows.find(row => isMapping(row) && row.id === id)

  // 1) host rows: pwsh executor and tool disabled.
  for (const expected of DISABLED_HOST_ROWS) {
    const row = findTop(expected.id)
    if (row === undefined) {
      problems.push(`缺少 host 行 id: ${expected.id}`)
      continue
    }
    if (row.name !== expected.name) {
      problems.push(`host 行 ${expected.id} 的 name 应为 ${expected.name}，实际 ${describe(row.name)}`)
    }
    if (row.disabled !== true) {
      problems.push(`host 行 ${expected.id} 必须 disabled: true，实际 ${describe(row.disabled)}`)
    }
    if ('insert' in row) problems.push(`host 行 ${expected.id} 不应包含 insert`)
  }

  // 2) host tool-bash row: always enabled (Web preset rows shadow it in the agent scope).
  const toolBash = findTop(HOST_TOOL_BASH.id)
  if (toolBash === undefined) {
    problems.push(`缺少 host 行 id: ${HOST_TOOL_BASH.id}`)
  } else {
    if (toolBash.name !== HOST_TOOL_BASH.name) {
      problems.push(`host 行 ${HOST_TOOL_BASH.id} 的 name 应为 ${HOST_TOOL_BASH.name}，实际 ${describe(toolBash.name)}`)
    }
    if (toolBash.disabled !== false) {
      problems.push(`host 行 ${HOST_TOOL_BASH.id} 必须 disabled: false（常开；Web preset 的同名行在 agent scope 遮蔽它），实际 ${describe(toolBash.disabled)}`)
    }
  }

  // 3) exactly one insert block holding exactly the executor and panel host rows.
  const insertRows = rows.filter(row => isMapping(row) && 'insert' in row)
  if (insertRows.length !== 1) {
    problems.push(`顶层应恰好有 1 个 insert 行，实际 ${insertRows.length}`)
  } else {
    const inserted = insertRows[0].insert
    if (!Array.isArray(inserted)) {
      problems.push('insert 必须是数组')
    } else {
      const ids = inserted.filter(isMapping).map(row => row.id)
      const unexpected = ids.filter(id => !VSSHELL_ROWS.some(expected => expected.id === id))
      if (unexpected.length > 0) problems.push(`insert 出现了不应存在的行：${unexpected.join(', ')}`)
      for (const expected of VSSHELL_ROWS) {
        const matching = inserted.filter(row => isMapping(row) && row.id === expected.id)
        if (matching.length !== 1) {
          problems.push(`insert 中应恰好有 1 行 id: ${expected.id}（${expected.purpose}），实际 ${matching.length}`)
          continue
        }
        const row = matching[0]
        if (row.name !== expected.name) {
          problems.push(`insert 行 ${expected.id} 的 name 应为 ${expected.name}，实际 ${describe(row.name)}`)
        }
        if (!isMapping(row.config)) {
          problems.push(`insert 行 ${expected.id} 必须带 config 映射（即使内容为 {}），实际 ${describe(row.config)}`)
        }
        // Both rows are Windows-only: on POSIX the shipped bash-sandbox owns
        // ctx.shell, and the panel has no executor to configure.
        if (!isJsExpression(row.disabled)) {
          problems.push(`insert 行 ${expected.id} 必须 disabled: !!js process.platform !== 'win32'（POSIX 已有 bash-sandbox 提供 ctx.shell）`)
        } else if (!row.disabled.expression.includes('process.platform') || !row.disabled.expression.includes('win32')) {
          problems.push(`insert 行 ${expected.id} 的 !!js 表达式应把本插件限制在 win32，实际 ${JSON.stringify(row.disabled.expression)}`)
        }
      }
    }
  }

  // 4) preset rows: exactly standard/ptc/cordis, each with tool-bash enabled and tool-pwsh disabled.
  const presetRows = rows.filter(row => isMapping(row) && typeof row.id === 'string' && row.id.startsWith('preset-'))
  const presetIds = presetRows.map(row => row.id)
  const expectedPresetIds = COVERED_PRESETS.map(preset => `preset-${preset}`)
  for (const id of expectedPresetIds) {
    if (!presetIds.includes(id)) problems.push(`缺少 preset 覆盖行 id: ${id}`)
  }
  for (const id of presetIds) {
    if (!expectedPresetIds.includes(id)) {
      problems.push(`出现了不应存在的 preset 行 id: ${id}（只覆盖 ${expectedPresetIds.join(' / ')}；minimal 走 persistent-shell，不覆盖）`)
    }
  }
  if (new Set(presetIds).size !== presetIds.length) {
    problems.push(`preset 行 id 有重复：${presetIds.join(', ')}`)
  }
  if (presetRows.length !== expectedPresetIds.length) {
    problems.push(`应恰好有 ${expectedPresetIds.length} 个 preset 覆盖行，实际 ${presetRows.length}`)
  }
  for (const preset of COVERED_PRESETS) {
    const id = `preset-${preset}`
    const row = findTop(id)
    if (row === undefined) continue
    if (row.name !== PRESET_PLUGIN_NAME) {
      problems.push(`preset 行 ${id} 的 name 应为 ${PRESET_PLUGIN_NAME}，实际 ${describe(row.name)}`)
    }
    if (!isMapping(row.config)) {
      problems.push(`preset 行 ${id} 必须带 config 映射`)
      continue
    }
    if (row.config.id !== preset) {
      problems.push(`preset 行 ${id} 的 config.id 应为 "${preset}"，实际 ${describe(row.config.id)}`)
    }
    if (!Array.isArray(row.config.plugins)) {
      problems.push(`preset 行 ${id} 的 config.plugins 必须是数组`)
      continue
    }
    const plugins = row.config.plugins
    const bash = plugins.find(plugin => isMapping(plugin) && plugin.id === 'tool-bash')
    if (bash === undefined) {
      problems.push(`preset ${preset}: config.plugins 中缺少 id: tool-bash`)
    } else {
      // Assert the plugin NAME too: a corrupted snapshot row with the right id but
      // a wrong/broken package name would otherwise pass structure and generation.
      if (bash.name !== '@deepseek-ai/dsh-tool-bash') {
        problems.push(`preset ${preset}: tool-bash 行的 name 应为 @deepseek-ai/dsh-tool-bash，实际 ${describe(bash.name)}`)
      }
      if ('disabled' in bash && bash.disabled !== false) {
        problems.push(`preset ${preset}: tool-bash 必须启用（删除 disabled），实际 disabled: ${describe(bash.disabled)}`)
      }
    }
    const pwsh = plugins.find(plugin => isMapping(plugin) && plugin.id === 'tool-pwsh')
    if (pwsh === undefined) {
      problems.push(`preset ${preset}: config.plugins 中缺少 id: tool-pwsh`)
    } else {
      if (pwsh.name !== '@deepseek-ai/dsh-tool-pwsh') {
        problems.push(`preset ${preset}: tool-pwsh 行的 name 应为 @deepseek-ai/dsh-tool-pwsh，实际 ${describe(pwsh.name)}`)
      }
      if (pwsh.disabled !== true) {
        problems.push(`preset ${preset}: tool-pwsh 必须 disabled: true，实际 ${describe(pwsh.disabled)}`)
      }
    }
  }
  return problems
}

/** Exact-version form for a pinned release (no range operators). */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** The only non-`dsh-*` peer this bundle also pins exactly. */
const PINNED_CORDIS = '@deepseek-ai/cordis'

/**
 * Assert the plugin manifest pins DSH peers to exact versions. The DSH
 * compatibility preflight evaluates peers as semver ranges with prereleases, so
 * a `~`/`^` range would activate this bundle on a release its pinned preset
 * snapshot was not taken from; a range is a real defect.
 * @param {Record<string, any>} manifest - parsed package.json.
 * @returns {string[]} human-readable problems; empty when every DSH peer is an exact pin.
 */
export function peerPinProblems(manifest) {
  /** @type {string[]} */
  const problems = []
  const dev = manifest.devDependencies ?? {}
  const strip = value => (typeof value === 'string' ? value.replace(/^[~^]/u, '') : undefined)
  const expectedDsh = strip(dev[PINNED_DSH_PACKAGE])
  const expectedCordis = strip(dev[PINNED_CORDIS])
  if (expectedDsh === undefined) {
    problems.push(`package.json 缺少 devDependencies["${PINNED_DSH_PACKAGE}"]，无法校验 peer 精确版本`)
  }
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    const isDsh = name === '@deepseek-ai/dsh' || name.startsWith('@deepseek-ai/dsh-')
    if (!isDsh && name !== PINNED_CORDIS) continue
    if (typeof range !== 'string' || !EXACT_VERSION.test(range)) {
      problems.push(`peerDependencies["${name}"] 必须是精确版本（不能是 ${JSON.stringify(range)} 这样的范围）；DSH 的兼容检查把 peer 当 semver range，\`~0.2.1-rc.5\` 会放行后续版本`)
      continue
    }
    const expected = isDsh ? expectedDsh : expectedCordis
    if (expected !== undefined && range !== expected) {
      problems.push(`peerDependencies["${name}"] 是 ${range}，应等于 devDependencies 的 ${expected}`)
    }
  }
  return problems
}

/**
 * Assert the generated patch is pinned to one DSH version: the header line, the
 * preset snapshot manifest, the devDependency that the executor was compiled
 * against, and every exactly-pinned DSH peer must all name the same release.
 * @param {string} text - generated patch text.
 * @param {string} source - preset snapshot directory or DSH checkout used for generation.
 * @returns {{ declared: string | undefined, snapshot: string | undefined, pinned: string | undefined, problems: string[] }} version facts and problems.
 */
export function validateTargetVersion(text, source = DEFAULT_SOURCE) {
  /** @type {string[]} */
  const problems = []
  const declared = VERSION_LINE.exec(text)?.[1]
  if (declared === undefined) problems.push('生成物头部缺少「# 目标 DSH 版本：<version>；」行')
  let snapshot
  try {
    snapshot = readDshVersion(source)
  } catch (error) {
    problems.push(`无法读取 preset 来源的 DSH 版本（${source}）：${error instanceof Error ? error.message : String(error)}`)
  }
  let pinned
  try {
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
    const value = manifest.devDependencies?.[PINNED_DSH_PACKAGE]
    if (typeof value !== 'string' || value === '') {
      problems.push(`package.json 缺少 devDependencies["${PINNED_DSH_PACKAGE}"]，无法固定目标 DSH 版本`)
    } else {
      pinned = value.replace(/^[~^]/u, '')
    }
    problems.push(...peerPinProblems(manifest))
  } catch (error) {
    problems.push(`无法读取 package.json：${error instanceof Error ? error.message : String(error)}`)
  }
  if (declared !== undefined && snapshot !== undefined && declared !== snapshot) {
    problems.push(`生成物声明 DSH ${declared}，但 preset 来源是 DSH ${snapshot}；重新运行 pnpm run gen:patch`)
  }
  if (snapshot !== undefined && pinned !== undefined && snapshot !== pinned) {
    problems.push(`preset 快照是 DSH ${snapshot}，而 devDependencies["${PINNED_DSH_PACKAGE}"] 固定 ${pinned}；两者必须一致（升级 DSH 时一起更新，见 AGENTS.md §8）`)
  }
  return { declared, snapshot, pinned, problems }
}

/**
 * Run all checks against one patch file.
 * @param {{ file?: string, source?: string }} [options] - patch file and preset-source overrides.
 * @returns {{
 *   file: string,
 *   rows: unknown,
 *   structureProblems: string[],
 *   versionProblems: string[],
 *   version: ReturnType<typeof validateTargetVersion>,
 *   generation: { source: string, problems: string[], difference?: ReturnType<typeof compareTexts> },
 * }} check result; `generation.problems` is empty only when the rendered text matches.
 */
export function checkPatch(options = {}) {
  const file = resolve(options.file ?? DEFAULT_OUT)
  const source = resolve(options.source ?? DEFAULT_SOURCE)
  const text = readFileSync(file, 'utf8')
  const rows = parsePatchYaml(text, file)
  const structureProblems = validatePatchStructure(rows)
  const version = validateTargetVersion(text, source)
  /** @type {{ source: string, problems: string[], difference?: ReturnType<typeof compareTexts> }} */
  const generation = { source, problems: [] }
  try {
    const generated = generatePatch({ source })
    const difference = compareTexts(text, generated.text)
    if (difference !== undefined) {
      generation.difference = difference
      generation.problems.push(`生成物与 ${source} 的渲染结果不一致；重新运行 pnpm run gen:patch 并审阅 git diff`)
    }
  } catch (error) {
    generation.problems.push(`无法重新生成以做一致性校验：${error instanceof Error ? error.message : String(error)}`)
  }
  return { file, rows, structureProblems, versionProblems: version.problems, version, generation }
}

/**
 * Print one check result in the PASS/FAIL format.
 * @param {ReturnType<typeof checkPatch>} result - result of {@link checkPatch}.
 * @returns {boolean} whether the check passed.
 */
export function reportCheck(result) {
  let passed = true
  if (result.structureProblems.length === 0) {
    console.log(`patch structure: PASS — ${result.file}`)
  } else {
    passed = false
    console.error(`patch structure: FAIL — ${result.file}`)
    for (const problem of result.structureProblems) console.error(`  - ${problem}`)
  }
  if (result.versionProblems.length === 0) {
    console.log(`target version: PASS — DSH ${result.version.declared}（快照 DSH ${result.version.snapshot}，devDependency ${result.version.pinned}）`)
  } else {
    passed = false
    console.error(`target version: FAIL — ${result.file}`)
    for (const problem of result.versionProblems) console.error(`  - ${problem}`)
  }
  if (result.generation.problems.length === 0) {
    console.log(`generated patch: PASS — 与 ${result.generation.source} 的渲染结果逐字一致`)
  } else {
    passed = false
    console.error(`generated patch: FAIL — ${result.file}`)
    for (const problem of result.generation.problems) console.error(`  - ${problem}`)
    if (result.generation.difference !== undefined) printDifference(result.generation.difference)
  }
  return passed
}

/**
 * Parse the checker's command line.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{ file: string, source: string, help: boolean }} parsed options.
 */
function parseArgs(argv) {
  const options = { file: DEFAULT_OUT, source: DEFAULT_SOURCE, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '--file' || arg === '--source') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`)
      if (arg === '--file') options.file = value
      else options.source = value
      index += 1
    } else if (arg.startsWith('--file=')) {
      options.file = arg.slice('--file='.length)
    } else if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length)
    } else {
      throw new Error(`未知参数：${arg}（支持 --file、--source、--help）`)
    }
  }
  return options
}

/**
 * Run the checker CLI.
 * @returns {void}
 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`check-patch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    console.log([
      'usage: node scripts/check-patch.mjs [--file <patch.yml>] [--source <preset snapshot | DSH checkout>]',
      '',
      `  --file <file>   要校验的 patch（默认 ${DEFAULT_OUT}）`,
      `  --source <dir>  preset 快照目录（默认 ${DEFAULT_SOURCE}）或匹配版本的 DSH 源码检出，用于生成物一致性校验`,
      '  --help          打印本帮助',
    ].join('\n'))
    return
  }
  let result
  try {
    result = checkPatch(options)
  } catch (error) {
    console.error(`check-patch: FAIL — 无法读取或解析 patch：${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }
  if (!reportCheck(result)) process.exitCode = 1
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) main()
