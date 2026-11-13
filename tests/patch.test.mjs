/**
 * Assertions for the generated `cordis.patch.yml`, the checked-in preset
 * snapshot, and the generator/checker modules that own them
 * (AGENTS.md section 5, docs/design.md section 8/9).
 *
 * Everything here is self-contained: the preset snapshot is committed, so the
 * tests need no external DSH checkout. They never write a file and never launch
 * a shell.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  COVERED_PRESETS,
  DEFAULT_OUT,
  DEFAULT_SOURCE,
  SNAPSHOT_MANIFEST,
  compareTexts,
  generatePatch,
  isJsExpression,
  parsePatchYaml,
  presetFilePath,
  readDshVersion,
  verifySnapshotHashes,
} from '../scripts/gen-preset-patch.mjs'
import { checkPatch, peerPinProblems, validatePatchStructure, validateTargetVersion } from '../scripts/check-patch.mjs'

/** Repository root (this file lives in `<repo>/tests`). */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Read and parse the committed patch. @returns {unknown[]} top-level rows. */
function readPatchRows() {
  return parsePatchYaml(readFileSync(DEFAULT_OUT, 'utf8'), DEFAULT_OUT)
}

/**
 * Find one preset's override row.
 * @param {unknown[]} rows - parsed patch rows.
 * @param {string} preset - preset name.
 * @returns {any} the row.
 */
function presetRow(rows, preset) {
  const row = rows.find(candidate => candidate?.id === `preset-${preset}`)
  assert.ok(row, `missing preset row preset-${preset}`)
  return row
}

/**
 * Find one child plugin row inside a preset override.
 * @param {any} row - preset override row.
 * @param {string} id - child row id.
 * @returns {any} the child row.
 */
function pluginRow(row, id) {
  const child = row.config.plugins.find(plugin => plugin?.id === id)
  assert.ok(child, `preset ${row.config.id}: missing ${id}`)
  return child
}

/**
 * Read one preset's plugin list from the committed preset snapshot.
 * @param {string} preset - preset name.
 * @returns {unknown[]} plugin rows.
 */
function readSnapshotPlugins(preset) {
  const file = presetFilePath(DEFAULT_SOURCE, preset)
  const rows = parsePatchYaml(readFileSync(file, 'utf8'), file)
  return rows[0].insert[0].config.plugins
}

test('cordis.patch.yml 结构断言全部通过', () => {
  const rows = readPatchRows()
  assert.deepEqual(validatePatchStructure(rows), [])
})

test('目标版本断言通过：生成物、preset 快照、devDependency 指向同一 DSH 版本', () => {
  const text = readFileSync(DEFAULT_OUT, 'utf8')
  const version = validateTargetVersion(text, DEFAULT_SOURCE)
  assert.deepEqual(version.problems, [])
  assert.equal(version.declared, version.snapshot)
  assert.equal(version.snapshot, version.pinned)
  const result = checkPatch({ file: DEFAULT_OUT, source: DEFAULT_SOURCE })
  assert.deepEqual(result.versionProblems, [])
})

test('peerDependencies 必须是精确版本（阻止 semver range 放行后续版本）', () => {
  const real = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'))
  assert.deepEqual(peerPinProblems(real), [], '真实 package.json 的 DSH peer 必须全部精确固定')

  // A range is a real defect: `~0.2.1-rc.5` also satisfies a later prerelease.
  const ranged = {
    devDependencies: {
      '@deepseek-ai/dsh-bash-local': '0.2.1-rc.5',
      '@deepseek-ai/cordis': '4.0.5',
    },
    peerDependencies: {
      '@deepseek-ai/dsh-bash-local': '~0.2.1-rc.5',
      '@deepseek-ai/cordis': '^4.0.5',
    },
  }
  const problems = peerPinProblems(ranged)
  assert.equal(problems.length, 2)
  assert.match(problems[0], /精确版本/u)

  // Exact but mismatched versions are caught too.
  const mismatched = {
    devDependencies: {
      '@deepseek-ai/dsh-bash-local': '0.2.1-rc.5',
      '@deepseek-ai/cordis': '4.0.5',
    },
    peerDependencies: {
      '@deepseek-ai/dsh-shell': '0.2.1-rc.4',
      '@deepseek-ai/cordis': '4.0.5',
    },
  }
  assert.deepEqual(peerPinProblems(mismatched), ['peerDependencies["@deepseek-ai/dsh-shell"] 是 0.2.1-rc.4，应等于 devDependencies 的 0.2.1-rc.5'])
})

test('preset 快照清单存在且版本号可读', () => {
  assert.ok(existsSync(join(DEFAULT_SOURCE, SNAPSHOT_MANIFEST)), 'presets/source.json 必须存在')
  const manifest = JSON.parse(readFileSync(join(DEFAULT_SOURCE, SNAPSHOT_MANIFEST), 'utf8'))
  assert.equal(readDshVersion(DEFAULT_SOURCE), manifest.dshVersion)
  for (const preset of COVERED_PRESETS) {
    assert.ok(existsSync(presetFilePath(DEFAULT_SOURCE, preset)), `缺少快照 ${preset}.patch.yml`)
  }
})

test('preset 快照逐字节校验通过（sha256 与 source.json 一致）', () => {
  const manifest = JSON.parse(readFileSync(join(DEFAULT_SOURCE, SNAPSHOT_MANIFEST), 'utf8'))
  const verified = verifySnapshotHashes(DEFAULT_SOURCE)
  assert.deepEqual(Object.keys(verified).sort(), [...COVERED_PRESETS].sort())
  for (const preset of COVERED_PRESETS) {
    assert.equal(verified[preset], manifest.sha256[preset], `${preset} 快照 sha256 必须与清单一致`)
    assert.match(verified[preset], /^[0-9a-f]{64}$/u)
  }
})

test('host 层禁用 pwsh、插入 dsh-vsshell，tool-bash 常开', () => {
  const rows = readPatchRows()
  const disabled = rows.filter(row => row?.disabled === true && typeof row.id === 'string')
  assert.deepEqual(
    disabled.map(row => row.id).sort(),
    ['pwsh-sandbox', 'tool-pwsh'],
    'host 层应只禁用 pwsh-sandbox 与 tool-pwsh；tool-bash 常开（Web preset 的同名行在 agent scope 遮蔽）',
  )
  const bash = rows.find(row => row?.id === 'tool-bash')
  assert.ok(bash, 'missing host tool-bash row')
  assert.equal(bash.disabled, false, 'host tool-bash 必须 disabled: false')

  const insert = rows.filter(row => row?.insert !== undefined)
  assert.equal(insert.length, 1, '应恰好有一个 insert 行')
  const vsshell = insert[0].insert.find(row => row?.id === 'dsh-vsshell')
  assert.ok(vsshell, 'insert 中缺少 dsh-vsshell 行')
  assert.equal(vsshell.name, '@dsh-external/dsh-vsshell')
  assert.deepEqual(vsshell.config, {}, 'dsh-vsshell 行必须带 config（空映射也行）')
  assert.ok(isJsExpression(vsshell.disabled), 'dsh-vsshell 行必须限定在 win32')
  assert.match(vsshell.disabled.expression, /process\.platform/u)
})

test('preset 覆盖恰好是 standard/ptc/cordis，且启用 tool-bash、禁用 tool-pwsh', () => {
  const rows = readPatchRows()
  const covered = rows
    .filter(row => typeof row?.id === 'string' && row.id.startsWith('preset-'))
    .map(row => row.id)
  assert.deepEqual(covered.sort(), COVERED_PRESETS.map(preset => `preset-${preset}`).sort())
  assert.ok(!covered.includes('preset-minimal'), 'preset-minimal 不应被覆盖')
  assert.equal(
    COVERED_PRESETS.length,
    3,
    '覆盖范围是 design.md 约定的三个 shipped preset（minimal 走 persistent-shell seam）',
  )
  for (const preset of COVERED_PRESETS) {
    const row = presetRow(rows, preset)
    assert.equal(row.config.id, preset)
    assert.equal(typeof row.config.order, 'number')
    assert.ok(Array.isArray(row.config.plugins))

    const bash = pluginRow(row, 'tool-bash')
    assert.ok(!('disabled' in bash) || bash.disabled === false, `preset ${preset}: tool-bash 必须启用`)

    const pwsh = pluginRow(row, 'tool-pwsh')
    assert.equal(pwsh.disabled, true, `preset ${preset}: tool-pwsh 必须 disabled: true`)
  }
})

test('preset 快照是目标版本（0.2.2-rc.3 安装）的特征内容（版本指纹，升级 DSH 时按 AGENTS.md §8 同步）', () => {
  // 0.2.2 reshaped the shipped presets (list-agents folded into
  // tool-subagent-control, modelSelectionSettings became modelSelection +
  // modelDiscovery, ptc switched to tool-executor-ptc, plugin-market /
  // tool-fs applyPatch) and rc.3 adds tool-office, standard's
  // skill-filesystem customSkillDirs, interrupt:false on tool-subagent-control
  // and the cordis persona sentence.
  for (const preset of COVERED_PRESETS) {
    const row = presetRow(readPatchRows(), preset)
    const delegation = row.config.plugins.find(plugin => plugin?.id === 'delegation')
    assert.ok(delegation, `preset ${preset}: missing delegation group`)
    const control = delegation.config.find(plugin => plugin?.id === 'tool-subagent-control')
    assert.ok(control, `preset ${preset}: delegation must contain tool-subagent-control`)
    assert.equal(control.name, '@deepseek-ai/dsh-tool-subagent-control')
    assert.equal(control.config.interrupt, false, `preset ${preset}: 0.2.2-rc.3 disables subagent interrupt`)
    assert.ok(
      !delegation.config.some(plugin => plugin?.id === 'tool-subagent-list-agents'),
      `preset ${preset}: 0.2.2-rc.1 removes the separate list-agents row`,
    )
    const subagent = delegation.config.find(plugin => plugin?.id === 'tool-subagent')
    assert.equal(subagent.config.modelSelection, true, `preset ${preset}: target uses modelSelection`)
    assert.equal(subagent.config.modelDiscovery, true, `preset ${preset}: target uses modelDiscovery`)
    assert.equal(subagent.config.modelSelectionSettings, undefined, `preset ${preset}: legacy modelSelectionSettings is gone`)
  }
  const ptc = presetRow(readPatchRows(), 'ptc')
  assert.ok(pluginRow(ptc, 'tool-executor-ptc'), 'preset ptc: target carries tool-executor-ptc')
  assert.equal(pluginRow(ptc, 'tool-executor-ptc').name, '@deepseek-ai/dsh-tool-executor-ptc')
  assert.ok(
    !ptc.config.plugins.some(plugin => plugin?.id === 'tool-presentation'),
    'preset ptc: tool-presentation is gone in 0.2.2-rc.1',
  )
  assert.equal(pluginRow(ptc, 'tool-office').name, '@deepseek-ai/dsh-tool-office', 'preset ptc: rc.3 adds tool-office')
  const standard = presetRow(readPatchRows(), 'standard')
  assert.ok(
    isJsExpression(pluginRow(standard, 'tool-plugin-manager').disabled),
    'target standard now gates plugin-manager on profileContext',
  )
  assert.equal(pluginRow(standard, 'tool-fs').config.applyPatch, false)
  assert.equal(pluginRow(standard, 'tool-plugin-market').disabled, true)
  assert.equal(pluginRow(standard, 'tool-office').name, '@deepseek-ai/dsh-tool-office', 'preset standard: rc.3 adds tool-office')
  // rc.3 moved the agent-preset skills directory into standard's skill-filesystem.
  const shippedSkill = pluginRow(standard, 'skill-filesystem')
  assert.ok(Array.isArray(shippedSkill.config.customSkillDirs))
  assert.ok(isJsExpression(shippedSkill.config.customSkillDirs[0]))
  assert.match(shippedSkill.config.customSkillDirs[0].expression, /dsh-agent-preset\/package\.json/u)
  const cordis = presetRow(readPatchRows(), 'cordis')
  assert.ok(pluginRow(cordis, 'tool-cordis'), 'preset cordis: target carries tool-cordis')
  assert.match(
    pluginRow(cordis, 'persona').config.prefix,
    /You help the user customize DeepSeek Harness itself\./u,
    'preset cordis: rc.3 changes the persona sentence',
  )
})

test('!!js 表达式原样保留（plugin-manager、skill-filesystem）', () => {
  const rows = readPatchRows()

  // 0.2.2-rc.1: standard and cordis gate plugin-manager on profileContext; ptc keeps a literal true.
  const manager = pluginRow(presetRow(rows, 'cordis'), 'tool-plugin-manager')
  assert.ok(isJsExpression(manager.disabled), 'preset cordis: tool-plugin-manager 的条件必须是 !!js 表达式')
  assert.equal(manager.disabled.expression, "!ctx.get('profileContext')")
  assert.equal(
    pluginRow(presetRow(rows, 'standard'), 'tool-plugin-manager').disabled.expression,
    "!ctx.get('profileContext')",
    'preset standard: 0.2.2-rc.1 gates plugin-manager on profileContext too',
  )
  assert.equal(pluginRow(presetRow(rows, 'ptc'), 'tool-plugin-manager').disabled, true)

  // The gnarliest expression: a `!!js` sequence item under config.customSkillDirs
  // (cordis and, since 0.2.2-rc.3, standard).
  const skill = pluginRow(presetRow(rows, 'cordis'), 'skill-filesystem')
  assert.ok(Array.isArray(skill.config.customSkillDirs))
  assert.equal(skill.config.customSkillDirs.length, 1)
  assert.ok(isJsExpression(skill.config.customSkillDirs[0]), 'customSkillDirs 的表达式必须保持 !!js 形式')
  assert.match(skill.config.customSkillDirs[0].expression, /process\.getBuiltinModule\(/u)
  const shipped = readSnapshotPlugins('cordis').find(plugin => plugin?.id === 'skill-filesystem')
  assert.equal(
    skill.config.customSkillDirs[0].expression,
    shipped.config.customSkillDirs[0].expression,
    '表达式文本必须与快照逐字一致',
  )
})

test('plan-mode 的 section 多行块原样往返', () => {
  const generated = pluginRow(presetRow(readPatchRows(), 'cordis'), 'planning')
    .config.find(plugin => plugin?.id === 'plan-mode').config.section
  const shipped = readSnapshotPlugins('cordis')
    .find(plugin => plugin?.id === 'planning').config
    .find(plugin => plugin?.id === 'plan-mode').config.section
  assert.equal(typeof generated, 'string')
  assert.equal(generated, shipped, 'section 块标量必须与快照逐字一致')
  assert.match(generated, /\n\n/u, 'section 应保留段落间空行')
  assert.ok(generated.endsWith('\n'), 'section 应保留结尾换行')
})

test('生成物与生成器的渲染结果逐字一致', () => {
  const { text } = generatePatch({ source: DEFAULT_SOURCE })
  assert.equal(readFileSync(DEFAULT_OUT, 'utf8'), text)
})

test('渲染结果可被 YAML 重新解析回同一结构', () => {
  const { model, text } = generatePatch({ source: DEFAULT_SOURCE })
  assert.deepEqual(parsePatchYaml(text), model)
})

test('checkPatch 报告结构、版本与生成物全部 PASS', () => {
  const result = checkPatch({ file: DEFAULT_OUT, source: DEFAULT_SOURCE })
  assert.equal(result.file, DEFAULT_OUT)
  assert.deepEqual(result.structureProblems, [])
  assert.deepEqual(result.versionProblems, [])
  assert.deepEqual(result.generation.problems, [])
})

test('compareTexts 定位首个差异行，相同文本返回 undefined', () => {
  assert.equal(compareTexts('same\n', 'same\n'), undefined)
  const difference = compareTexts('a\nb\nc\n', 'a\nx\nc\n')
  assert.ok(difference)
  assert.equal(difference.line, 2)
  assert.equal(difference.actual, 'b')
  assert.equal(difference.expected, 'x')
  const appended = compareTexts('a\n', 'a\nb\n')
  assert.ok(appended)
  assert.equal(appended.line, 2)
  assert.equal(appended.actual, '')
  assert.equal(appended.expected, 'b')
})

test('仓库根目录与生成物默认路径一致', () => {
  assert.equal(DEFAULT_OUT, join(REPO_ROOT, 'cordis.patch.yml'))
  assert.equal(DEFAULT_SOURCE, resolve(REPO_ROOT, 'presets'))
})
