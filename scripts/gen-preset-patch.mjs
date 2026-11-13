#!/usr/bin/env node
/**
 * Generate this bundle's `cordis.patch.yml` from the checked-in preset snapshot
 * (`presets/`, byte-identical to the shipped presets of the pinned DSH release).
 *
 * The generated document has two layers (docs/design.md section 8):
 *   1. host rows: disable the win32 pwsh executor/tool, insert the vsshell
 *      executor (win32-only), and keep the built-in tool-bash always enabled
 *      (a Web preset's same-named row shadows it in the agent scope; only a
 *      duplicate within one scope is an error);
 *   2. preset rows: a wholesale `config.plugins` snapshot of the shipped
 *      standard/ptc/cordis presets with tool-bash enabled and tool-pwsh
 *      disabled.
 *
 * The preset snapshot is a copy tied to one DSH version (`presets/source.json`
 * holds the version and file hashes; the generator refuses a tampered snapshot).
 * A DSH upgrade replaces the snapshot, updates the manifest and regenerates,
 * then diffs the result (AGENTS.md section 8, docs/design.md section 10).
 *
 * The shipped preset YAML uses the Cordis Loader dialect, whose `!!js` scalars
 * are expressions rather than data. The `yaml` package cannot re-serialize such
 * tags, and the plan-mode prompt section is a multi-line literal block that must
 * survive byte-for-byte, so this script parses with a custom tag into
 * {@link JsExpression} markers and renders the document with a minimal emitter.
 *
 * Usage: node scripts/gen-preset-patch.mjs [--source <preset snapshot | DSH checkout>] [--out <file>] [--check]
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parse } from 'yaml'

/** The `scripts/` directory containing this file. */
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))

/** Repository root (this script's parent directory). */
export const REPO_ROOT = resolve(SCRIPT_DIR, '..')

/** Checked-in shipped-preset snapshot of the target DSH version (no external checkout needed). */
export const DEFAULT_SOURCE = resolve(REPO_ROOT, 'presets')

/** Snapshot manifest that records the exact DSH version and provenance of the preset files. */
export const SNAPSHOT_MANIFEST = 'source.json'

/** Default generated patch path. */
export const DEFAULT_OUT = resolve(REPO_ROOT, 'cordis.patch.yml')

/** Shipped presets covered by the generated override, in output order. `minimal` is deliberately absent. */
export const COVERED_PRESETS = ['standard', 'ptc', 'cordis']

/** Location of the preset definitions inside a DSH source checkout. */
export const PRESET_DIR = ['packages', 'bundle', 'web-app', 'presets']

/** YAML tag the Cordis Loader uses for JavaScript expressions. */
export const YAML_JS_TAG = 'tag:yaml.org,2002:js'

/** Package name of the agent-preset plugin each preset row declares. */
export const PRESET_PLUGIN_NAME = '@deepseek-ai/dsh-agent-preset'

/** Row name of this bundle's executor plugin. */
export const VSSHELL_PLUGIN_NAME = '@dsh-external/dsh-vsshell'

/** Row name of this bundle's configuration-panel host half (package subpath). */
export const VSSHELL_PANEL_PLUGIN_NAME = '@dsh-external/dsh-vsshell/panel'

/** Fixed header comment of the generated document. */
const HEADER_LINES = [
  '# dsh-vsshell bundle patch —— 由 scripts/gen-preset-patch.mjs 生成，禁止手改。',
  '#',
  '# 重新生成：pnpm run gen:patch [--source <preset 快照目录或 DSH 源码检出>]',
  '# 校验：pnpm run check:patch（结构断言 + 生成物一致性 + 目标版本断言）',
  '#',
  '# 1) host 层：禁用 win32 默认的 pwsh-sandbox / tool-pwsh，插入 dsh-vsshell 执行器（提供 ctx.shell）',
  '#    tool-bash 的 host 行常开；Web/preset 组合里同名工具由 preset 行的 agent scope 遮蔽（同层重名才会报错）。',
  '#    同一 insert 里还有 dsh-vsshell/panel：配置面板的 Host 半（JSON 路由 + profile 配置读写）。',
  '# 2) preset 层：整份覆盖 shipped preset 的 config.plugins —— tool-bash 启用、tool-pwsh 禁用。',
  '#    覆盖是快照：DSH 升级后必须更新 presets/ 快照并重新生成 + diff（docs/design.md §8 / §10）。',
  '# 3) preset-minimal 不覆盖：它走 persistent-shell（tool-bash-persistent + PTY terminal-bash）这条不同的 seam，v1 不支持。',
]

/** One header line naming the target DSH version and where the preset snapshot came from. */
function headerVersionLine(meta) {
  return `# 目标 DSH 版本：${meta.dshVersion}；preset 快照来源：${meta.sourceLabel}`
}

/** One `!!js` Loader expression, preserved verbatim from a preset patch. */
export class JsExpression {
  /** @param {string} expression - the raw JavaScript expression body. */
  constructor(expression) {
    /** @type {string} */
    this.expression = expression
  }
}

/**
 * Wrap a Loader expression so the renderer emits it as a `!!js` scalar.
 * @param {string} expression - non-empty JavaScript expression body.
 * @returns {JsExpression} marker value.
 */
export function jsExpression(expression) {
  if (typeof expression !== 'string' || expression.trim() === '') {
    throw new Error(`!!js expression must be a non-empty string, got ${JSON.stringify(expression)}`)
  }
  return new JsExpression(expression)
}

/**
 * @param {unknown} value - candidate value.
 * @returns {boolean} whether `value` is a preserved `!!js` expression.
 */
export function isJsExpression(value) {
  return value instanceof JsExpression
}

/** @param {unknown} value - candidate value. @returns {boolean} whether it is a plain mapping. */
function isMapping(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isJsExpression(value)
}

/**
 * Parse Loader-dialect YAML, keeping `!!js` scalars as {@link JsExpression}
 * markers instead of evaluating or dropping them.
 * @param {string} text - YAML source.
 * @param {string} [label] - origin used in error messages.
 * @returns {unknown} parsed document.
 */
export function parsePatchYaml(text, label = '<patch>') {
  try {
    return parse(text, {
      customTags: [{
        tag: YAML_JS_TAG,
        resolve: (value) => {
          if (typeof value !== 'string' || value.trim() === '') {
            throw new Error(`${label}: a !!js scalar must carry a non-empty expression body`)
          }
          return new JsExpression(value)
        },
      }],
    })
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot parse YAML from ${label}: ${detail}`)
  }
}

/**
 * Locate one preset patch file inside a snapshot directory or a DSH checkout.
 * A snapshot directory keeps `<preset>.patch.yml` at its root; a checkout keeps
 * them under `packages/bundle/web-app/presets/`.
 * @param {string} sourceRoot - snapshot directory or DSH source checkout root.
 * @param {string} preset - preset name (`standard`, `ptc`, `cordis`).
 * @returns {string} the preset patch path (whether or not it exists).
 */
export function presetFilePath(sourceRoot, preset) {
  const snapshotFile = join(sourceRoot, `${preset}.patch.yml`)
  if (existsSync(snapshotFile)) return snapshotFile
  return join(sourceRoot, ...PRESET_DIR, `${preset}.patch.yml`)
}

/**
 * Read the DSH version a preset source belongs to: the snapshot manifest for a
 * snapshot directory, else the checkout's own package.json.
 * @param {string} sourceRoot - snapshot directory or DSH source checkout root.
 * @returns {string} the DSH version string.
 */
export function readDshVersion(sourceRoot) {
  const manifestPath = join(sourceRoot, SNAPSHOT_MANIFEST)
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (typeof manifest.dshVersion === 'string' && manifest.dshVersion.trim() !== '') return manifest.dshVersion
    throw new Error(`${manifestPath}: dshVersion 必须是非空字符串`)
  }
  const packagePath = join(sourceRoot, 'package.json')
  if (existsSync(packagePath)) {
    const manifest = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (typeof manifest.version === 'string' && manifest.version.trim() !== '') return manifest.version
    throw new Error(`${packagePath}: version 必须是非空字符串`)
  }
  throw new Error(`无法确定 DSH 版本：${sourceRoot} 既不是含 ${SNAPSHOT_MANIFEST} 的快照目录，也不是含 package.json 的源码检出`)
}

/**
 * Verify the snapshot files against the SHA-256 hashes recorded in `source.json`.
 * A source without a manifest hash map (a raw DSH checkout) has nothing to verify.
 * @param {string} sourceRoot - preset snapshot directory (or DSH checkout).
 * @returns {Record<string, string>} verified `preset -> sha256` map; empty when the source records no hashes.
 * @throws when a recorded hash is missing/invalid or a file no longer matches it.
 */
export function verifySnapshotHashes(sourceRoot) {
  const manifestPath = join(sourceRoot, SNAPSHOT_MANIFEST)
  if (!existsSync(manifestPath)) return {}
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const recorded = manifest.sha256
  if (recorded === null || typeof recorded !== 'object') return {}
  /** @type {Record<string, string>} */
  const verified = {}
  for (const preset of COVERED_PRESETS) {
    const expected = recorded[preset]
    if (typeof expected !== 'string' || expected === '') {
      throw new Error(`${manifestPath}: sha256.${preset} 缺失或不是字符串`)
    }
    const file = presetFilePath(sourceRoot, preset)
    const actual = createHash('sha256').update(readFileSync(file)).digest('hex')
    if (actual !== expected.toLowerCase()) {
      throw new Error(
        `preset 快照被改动：${file}\n  期望 sha256 ${expected}\n  实际 sha256 ${actual}\n升级 DSH 时必须整份替换快照并更新 presets/source.json，不要手改内容（AGENTS.md §5.5）`,
      )
    }
    verified[preset] = actual
  }
  return verified
}

/**
 * Read one shipped preset's declaration from a preset snapshot or DSH source checkout.
 * @param {string} sourceRoot - snapshot directory or DSH source checkout root.
 * @param {string} preset - preset name (`standard`, `ptc`, `cordis`).
 * @returns {{ preset: string, file: string, config: { id: string, order: number, plugins: unknown[] } }} the declaration.
 */
export function readPresetConfig(sourceRoot, preset) {
  const file = presetFilePath(sourceRoot, preset)
  if (!existsSync(file)) {
    throw new Error(`preset 定义不存在：${file}\n--source 应指向本仓库的 presets/ 快照目录（默认 ${DEFAULT_SOURCE}）或匹配版本的 DSH 源码检出`)
  }
  const document = parsePatchYaml(readFileSync(file, 'utf8'), file)
  if (!Array.isArray(document) || document.length === 0) {
    throw new Error(`${file}: 顶层必须是数组`)
  }
  const patch = document[0]
  const row = isMapping(patch) && Array.isArray(patch.insert) ? patch.insert[0] : undefined
  const config = isMapping(row) ? row.config : undefined
  if (!isMapping(config)) {
    throw new Error(`${file}: 找不到 patch.insert[0].config 映射`)
  }
  const { id, order, plugins } = config
  if (typeof id !== 'string' || id === '') {
    throw new Error(`${file}: config.id 必须是非空字符串`)
  }
  if (typeof order !== 'number') {
    throw new Error(`${file}: config.order 必须是数字`)
  }
  if (!Array.isArray(plugins) || plugins.length === 0) {
    throw new Error(`${file}: config.plugins 必须是非空数组`)
  }
  return { preset, file, config: { id, order, plugins } }
}

/**
 * Apply the vsshell overrides to one preset's plugin list: enable tool-bash by
 * removing its `disabled`, and disable tool-pwsh with a literal `true`. Every
 * other row (groups, isolates, config, `!!js` expressions) is copied as parsed.
 * @param {unknown[]} plugins - the shipped plugin rows.
 * @param {string} preset - preset name used in error messages.
 * @returns {unknown[]} the overridden rows.
 */
export function normalizePresetPlugins(plugins, preset) {
  return plugins.map((row, index) => {
    if (!isMapping(row)) {
      throw new Error(`preset "${preset}": plugins[${index}] 必须是映射`)
    }
    /** @type {Record<string, unknown>} */
    const out = {}
    for (const [key, value] of Object.entries(row)) {
      if (row.id === 'tool-bash' && key === 'disabled') continue
      out[key] = row.id === 'tool-pwsh' && key === 'disabled' ? true : value
    }
    if (row.id === 'tool-pwsh' && !('disabled' in out)) out.disabled = true
    return out
  })
}

/**
 * Build the full patch document model: host rows, the vsshell insert row, then
 * one override row per covered preset.
 * @param {Array<{ preset: string, config: { id: string, order: number, plugins: unknown[] } }>} presetConfigs - presets to cover.
 * @returns {Array<Record<string, unknown>>} the patch rows.
 */
export function buildPatchModel(presetConfigs) {
  /** @type {Array<Record<string, unknown>>} */
  const rows = [
    { id: 'pwsh-sandbox', name: '@deepseek-ai/dsh-pwsh-sandbox', disabled: true },
    { id: 'tool-pwsh', name: '@deepseek-ai/dsh-tool-pwsh', disabled: true },
    // Always on: a base/CLI composition gets the tool from this host row, and a
    // Web preset composition shadows the same name in the agent scope (only a
    // duplicate WITHIN one scope throws). Gating on `ctx.get('agentPresets')`
    // looked right but is evaluated before that in-tree service is active, so it
    // was always false.
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: false },
    // Windows-only: on POSIX the shipped bash-sandbox already provides ctx.shell,
    // and a second provider would be a duplicate-service failure.
    {
      insert: [
        { id: 'dsh-vsshell', name: VSSHELL_PLUGIN_NAME, disabled: jsExpression("process.platform !== 'win32'"), config: {} },
        { id: 'dsh-vsshell-panel', name: VSSHELL_PANEL_PLUGIN_NAME, disabled: jsExpression("process.platform !== 'win32'"), config: {} },
      ],
    },
  ]
  for (const { preset, config } of presetConfigs) {
    rows.push({
      id: `preset-${preset}`,
      name: PRESET_PLUGIN_NAME,
      config: {
        id: config.id,
        order: config.order,
        plugins: normalizePresetPlugins(config.plugins, preset),
      },
    })
  }
  return rows
}

/** YAML values that would be read back as something other than a string when left plain. */
const RESERVED_WORDS = /^(?:true|false|yes|no|on|off|null|y|n|~)$/iu
/** Numeric-looking strings are quoted so they read back as strings. */
const NUMERIC_TEXT = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/u

/**
 * Whether a string can be emitted as a plain (unquoted) scalar and read back as
 * exactly the same string. Deliberately conservative: quoting is only a style
 * change, while a wrong plain scalar changes the value.
 * @param {string} text - scalar text.
 * @returns {boolean} whether plain style is safe.
 */
function isPlainSafe(text) {
  if (text === '' || text !== text.trim()) return false
  if (/[\u0000-\u001f\u007f]/u.test(text)) return false
  if (/^[-?:,[\]{}#&*!|>'"%@`]/u.test(text)) return false
  if (/:\s/u.test(text) || / #/u.test(text)) return false
  if (RESERVED_WORDS.test(text) || NUMERIC_TEXT.test(text)) return false
  if (/[[\]{}]/u.test(text)) return false
  return true
}

/**
 * Render a string as a YAML double-quoted scalar, escaping only what YAML
 * requires so the parsed value is identical to the input.
 * @param {string} text - scalar text.
 * @returns {string} double-quoted YAML scalar.
 */
function doubleQuote(text) {
  let out = ''
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0
    if (char === '\\') out += '\\\\'
    else if (char === '"') out += '\\"'
    else if (char === '\n') out += '\\n'
    else if (char === '\t') out += '\\t'
    else if (char === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`
    else out += char
  }
  return `"${out}"`
}

/**
 * Render a single-line string scalar: plain when safe, single-quoted otherwise,
 * falling back to double quotes when the text itself contains a quote.
 * @param {string} text - scalar text.
 * @returns {string} YAML scalar.
 */
function renderString(text) {
  if (isPlainSafe(text)) return text
  return text.includes("'") ? doubleQuote(text) : `'${text}'`
}

/**
 * Describe a literal block scalar when the value can round-trip through one.
 * @param {string} value - scalar value.
 * @returns {{ indicator: '|' | '|-', lines: string[] } | undefined} block form, or undefined to fall back to quoting.
 */
function literalBlock(value) {
  if (!value.includes('\n')) return undefined
  const lines = value.split('\n')
  let indicator
  if (lines[lines.length - 1] === '') {
    lines.pop()
    // Two or more trailing newlines need `|+`, which is not worth supporting here.
    if (lines[lines.length - 1] === '') return undefined
    indicator = '|'
  } else {
    indicator = '|-'
  }
  // A literal block loses trailing and whitespace-only-line spaces, so quote instead.
  if (lines.some(line => line !== line.trimEnd() || (line !== '' && line.trim() === ''))) return undefined
  return { indicator, lines }
}

/**
 * Render a mapping key.
 * @param {string} key - key text.
 * @returns {string} YAML key.
 */
function renderKey(key) {
  return isPlainSafe(key) ? key : renderString(key)
}

/**
 * Render one inline (non-block) scalar value.
 * @param {unknown} value - scalar, `null`, or {@link JsExpression}.
 * @returns {string} YAML scalar.
 */
function renderScalar(value) {
  if (isJsExpression(value)) return `!!js ${doubleQuote(value.expression)}`
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`cannot render a non-finite number as YAML: ${String(value)}`)
    return String(value)
  }
  if (value === null) return 'null'
  if (typeof value === 'string') return renderString(value)
  throw new Error(`cannot render ${typeof value} as a YAML scalar: ${String(value)}`)
}

/**
 * Render a block-scalar body line: empty lines stay empty, other lines get the
 * content indentation.
 * @param {string} line - content line.
 * @param {number} indent - content indentation.
 * @returns {string} rendered line.
 */
function renderBlockLine(line, indent) {
  return line === '' ? '' : `${' '.repeat(indent)}${line}`
}

/**
 * Render a mapping at the given indentation.
 * @param {Record<string, unknown>} object - mapping to render.
 * @param {number} indent - indentation of the keys.
 * @returns {string[]} rendered lines.
 */
function renderMapping(object, indent) {
  const pad = ' '.repeat(indent)
  /** @type {string[]} */
  const lines = []
  for (const [key, value] of Object.entries(object)) {
    const prefix = `${pad}${renderKey(key)}:`
    if (typeof value === 'string') {
      const block = literalBlock(value)
      if (block !== undefined) {
        lines.push(`${prefix} ${block.indicator}`)
        for (const line of block.lines) lines.push(renderBlockLine(line, indent + 2))
        continue
      }
    }
    if (isJsExpression(value) || !isMapping(value) && !Array.isArray(value)) {
      lines.push(`${prefix} ${renderScalar(value)}`)
      continue
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${prefix} []`)
        continue
      }
      lines.push(prefix)
      lines.push(...renderSequence(value, indent + 2))
      continue
    }
    if (Object.keys(value).length === 0) {
      lines.push(`${prefix} {}`)
      continue
    }
    lines.push(prefix)
    lines.push(...renderMapping(value, indent + 2))
  }
  return lines
}

/**
 * Render a sequence at the given indentation. A mapping item keeps its first
 * key on the dash line (`- id: ...`) for readability.
 * @param {unknown[]} array - sequence to render.
 * @param {number} indent - indentation of the dashes.
 * @returns {string[]} rendered lines.
 */
function renderSequence(array, indent) {
  const pad = ' '.repeat(indent)
  /** @type {string[]} */
  const lines = []
  for (const item of array) {
    if (typeof item === 'string') {
      const block = literalBlock(item)
      if (block !== undefined) {
        lines.push(`${pad}- ${block.indicator}`)
        for (const line of block.lines) lines.push(renderBlockLine(line, indent + 2))
        continue
      }
    }
    if (isJsExpression(item) || !isMapping(item) && !Array.isArray(item)) {
      lines.push(`${pad}- ${renderScalar(item)}`)
      continue
    }
    if (Array.isArray(item)) {
      if (item.length === 0) {
        lines.push(`${pad}- []`)
        continue
      }
      lines.push(`${pad}-`)
      lines.push(...renderSequence(item, indent + 2))
      continue
    }
    if (Object.keys(item).length === 0) {
      lines.push(`${pad}- {}`)
      continue
    }
    const nested = renderMapping(item, indent + 2)
    const [first, ...rest] = nested
    lines.push(`${pad}- ${first.slice(indent + 2)}`)
    lines.push(...rest)
  }
  return lines
}

/**
 * Render the generated patch document (header comments + rows) as YAML text.
 * @param {Array<Record<string, unknown>>} rows - patch document model.
 * @param {{ dshVersion: string, sourceLabel: string }} meta - target DSH version and snapshot provenance for the header.
 * @returns {string} the document text, ending with exactly one newline.
 */
export function renderPatch(rows, meta = { dshVersion: 'unknown', sourceLabel: 'unknown' }) {
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error('renderPatch: 至少需要一行 patch')
  }
  /** @type {string[]} */
  const lines = [...HEADER_LINES, headerVersionLine(meta), '', '# ---- host 层 ----']
  let wrotePresetSection = false
  for (const row of rows) {
    const preset = isMapping(row) && typeof row.id === 'string' && row.id.startsWith('preset-')
      ? row.id.slice('preset-'.length)
      : undefined
    if (preset !== undefined) {
      if (!wrotePresetSection) {
        lines.push('', `# ---- preset 覆盖（快照自 presets/*.patch.yml，目标 DSH ${meta.dshVersion}）----`)
        wrotePresetSection = true
      } else {
        lines.push('')
      }
      lines.push(`# preset ${preset} <- presets/${preset}.patch.yml (DSH ${meta.dshVersion})`)
    }
    lines.push(...renderSequence([row], 0))
  }
  return `${lines.join('\n')}\n`
}

/**
 * Generate the patch document from a preset snapshot or DSH source checkout.
 * @param {{ source?: string }} [options] - source override (defaults to the checked-in {@link DEFAULT_SOURCE} snapshot).
 * @returns {{ source: string, dshVersion: string, presetConfigs: Array<unknown>, model: Array<Record<string, unknown>>, text: string }} generated document.
 */
export function generatePatch(options = {}) {
  const source = resolve(options.source ?? DEFAULT_SOURCE)
  if (!existsSync(source)) {
    throw new Error(`preset 来源不存在：${source}\n--source 应指向本仓库的 presets/ 快照目录（默认 ${DEFAULT_SOURCE}）或匹配版本的 DSH 源码检出`)
  }
  const dshVersion = readDshVersion(source)
  const snapshotHashes = verifySnapshotHashes(source)
  const relativeSource = relative(REPO_ROOT, source)
  const sourceLabel = relativeSource === '' || relativeSource.startsWith('..') ? source : relativeSource
  const presetConfigs = COVERED_PRESETS.map(preset => readPresetConfig(source, preset))
  const model = buildPatchModel(presetConfigs)
  return { source, dshVersion, snapshotHashes, presetConfigs, model, text: renderPatch(model, { dshVersion, sourceLabel }) }
}

/**
 * Locate the first line where two texts differ.
 * @param {string} actualText - current file content.
 * @param {string} expectedText - freshly rendered content.
 * @returns {undefined | { line: number, actual: string, expected: string, actualLines: string[], expectedLines: string[] }} the difference, or undefined when equal.
 */
export function compareTexts(actualText, expectedText) {
  if (actualText === expectedText) return undefined
  const actualLines = actualText.split('\n')
  const expectedLines = expectedText.split('\n')
  const lineCount = Math.max(actualLines.length, expectedLines.length)
  let line = 1
  while (line <= lineCount) {
    if ((actualLines[line - 1] ?? '') !== (expectedLines[line - 1] ?? '')) break
    line += 1
  }
  return {
    line,
    actual: actualLines[line - 1] ?? '<文件结束>',
    expected: expectedLines[line - 1] ?? '<文件结束>',
    actualLines,
    expectedLines,
  }
}

/**
 * Print a human-readable diff report for one difference.
 * @param {{ line: number, actual: string, expected: string, expectedLines: string[] }} difference - first difference.
 * @returns {void}
 */
export function printDifference(difference) {
  const { line, actual, expected, expectedLines } = difference
  console.error(`  首处差异在第 ${line} 行：`)
  console.error(`    期望（生成结果）: ${JSON.stringify(expected)}`)
  console.error(`    实际（磁盘文件）: ${JSON.stringify(actual)}`)
  const start = Math.max(0, line - 3)
  const end = Math.min(expectedLines.length, line + 2)
  if (start < end) {
    console.error('  生成结果上下文：')
    for (let index = start; index < end; index += 1) {
      const marker = index + 1 === line ? '>' : ' '
      console.error(`   ${marker} ${String(index + 1).padStart(4, ' ')} | ${expectedLines[index] ?? ''}`)
    }
  }
}

/** @param {string} text - document text. @returns {number} number of lines. */
function lineCount(text) {
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

/**
 * Parse the generator's command line.
 * @param {string[]} argv - arguments after the script path.
 * @returns {{ source: string, out: string, check: boolean, help: boolean }} parsed options.
 */
function parseArgs(argv) {
  const options = { source: DEFAULT_SOURCE, out: DEFAULT_OUT, check: false, help: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--check') {
      options.check = true
    } else if (arg === '-h' || arg === '--help') {
      options.help = true
    } else if (arg === '--source' || arg === '--out') {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith('--')) throw new Error(`${arg} 缺少参数值`)
      if (arg === '--source') options.source = value
      else options.out = value
      index += 1
    } else if (arg.startsWith('--source=')) {
      options.source = arg.slice('--source='.length)
    } else if (arg.startsWith('--out=')) {
      options.out = arg.slice('--out='.length)
    } else {
      throw new Error(`未知参数：${arg}（支持 --source、--out、--check、--help）`)
    }
  }
  return options
}

/** Print the command usage. @returns {void} */
function printUsage() {
  console.log([
    'usage: node scripts/gen-preset-patch.mjs [--source <preset snapshot | DSH checkout>] [--out <file>] [--check]',
    '',
    `  --source <dir>   preset 快照目录（默认 ${DEFAULT_SOURCE}），或匹配版本的 DSH 源码检出`,
    `  --out <file>     输出路径（默认 ${DEFAULT_OUT}）`,
    '  --check          只比较现有文件与生成结果，不写文件；不一致时退出码 1',
    '  --help           打印本帮助',
  ].join('\n'))
}

/**
 * Run the generator CLI.
 * @returns {void}
 */
function main() {
  let options
  try {
    options = parseArgs(process.argv.slice(2))
  } catch (error) {
    console.error(`gen-preset-patch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
    return
  }
  if (options.help) {
    printUsage()
    return
  }
  let generated
  try {
    generated = generatePatch({ source: options.source })
  } catch (error) {
    console.error(`gen-preset-patch: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
    return
  }
  const out = resolve(options.out)
  if (options.check) {
    let actual
    try {
      actual = readFileSync(out, 'utf8')
    } catch (error) {
      console.error(`gen-preset-patch: --check 无法读取 ${out}：${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
      return
    }
    if (actual === generated.text) {
      console.log(`gen-preset-patch: check PASS — ${out} 与生成结果一致（${lineCount(generated.text)} 行）`)
      return
    }
    console.error(`gen-preset-patch: check FAIL — ${out} 与生成结果不一致（生成结果 ${lineCount(generated.text)} 行，磁盘文件 ${lineCount(actual)} 行）`)
    printDifference(compareTexts(actual, generated.text))
    console.error('  → 重新运行 pnpm run gen:patch 并审阅 git diff（docs/design.md §8）。')
    process.exitCode = 1
    return
  }
  writeFileSync(out, generated.text, 'utf8')
  console.log(`gen-preset-patch: wrote ${out}（${lineCount(generated.text)} 行，${Buffer.byteLength(generated.text, 'utf8')} 字节；source ${generated.source}）`)
}

const invokedDirectly = process.argv[1] !== undefined
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) main()
