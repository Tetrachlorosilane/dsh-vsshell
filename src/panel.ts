/**
 * Host half of the dsh-vsshell configuration panel.
 *
 * A tiny same-origin JSON route under `/dsh-vsshell-panel`: the browser half
 * (client.js) renders a settings section, reads the current effective config
 * with one GET, and writes it back with one POST. Writes go through the
 * profile's `configEditor`, so the YAML stays a Loader document (quotes,
 * order, comments survive) instead of being hand-edited by this plugin.
 *
 * Quote compatibility: values read from the profile patch are already
 * unquoted by the YAML layer; values typed in the panel may arrive wrapped in
 * `'...'` or `"..."` (users often paste them from `cordis.patch.yml`), so
 * {@link validatePanelConfig} normalizes every string field before writing.
 * @module @dsh-external/dsh-vsshell/panel
 */
import { existsSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SOURCES } from './detect.js'
import type { Source } from './detect.js'

/** Profile row id of the executor plugin this panel configures. */
export const ENTRY_ID = 'dsh-vsshell'

/** URL path of the panel's JSON endpoint. */
export const PANEL_PATH = '/dsh-vsshell-panel'

/** The six fields the panel owns (budgets stay in the profile/row as-is). */
export interface PanelConfig {
  source: Source
  bashPath: string
  wslDistro: string
  loginShell: boolean
  verify: boolean
  probeTimeoutMs: number
}

/** Live executor facts shown at the top of the panel. */
export interface PanelShell {
  status: 'ready' | 'pending' | 'failed' | 'unavailable'
  exe?: string
  family?: string
  label?: string
  source?: string
  detail?: string
}

/** One GET/POST response body. */
export interface PanelState {
  config: PanelConfig
  hasProfileOverride: boolean
  warnings: string[]
  sources: readonly string[]
  shell: PanelShell
}

/** Structural view of the fields this panel reads from a Loader entry. */
interface LoaderEntryLike {
  options: { id?: string; name?: string; config?: unknown }
}

/** Structural view of the `configEditor` service (avoids a hard type dependency). */
interface ConfigEditorLike {
  entries(): LoaderEntryLike[]
  configuration(): Array<{ entry: LoaderEntryLike; inherited: Record<string, unknown>; override: Record<string, unknown> }>
  edit(
    entry: LoaderEntryLike,
    change: (current: Record<string, unknown>, inherited: Record<string, unknown>) => Record<string, unknown>,
  ): Promise<void>
}

/** Structural view of the pieces of `webServer` this panel uses. */
interface WebServerLike {
  getOrigin(): string
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): () => void
}

/** Services this host plugin needs. */
export const inject = ['webServer', 'configEditor']

const SOURCE_SET = new Set<string>(SOURCES)
const DEFAULT_PROBE_TIMEOUT_MS = 15_000

/**
 * Strip one pair of matching YAML/JS quotes from a scalar, tolerating values
 * copied straight out of `cordis.patch.yml` (single quotes, double quotes, or
 * no quotes at all).
 * @param value - raw field value.
 * @returns the unquoted text; empty string for null/undefined.
 */
export function unquoteScalar(value: unknown): string {
  if (value === undefined || value === null) return ''
  const text = String(value).trim()
  if (text.length >= 2) {
    const first = text[0]
    const last = text[text.length - 1]
    if (first === last && (first === '"' || first === "'")) {
      const inner = text.slice(1, -1)
      return first === '"'
        ? inner.replace(/\\(["\\])/gu, '$1')
        : inner.replace(/''/gu, "'")
    }
  }
  return text
}

/** Read a boolean tolerating `true`/`false` strings (quoted or not). */
function readBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return value !== 0
  if (typeof value === 'string') {
    const text = unquoteScalar(value).toLowerCase()
    if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true
    if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false
  }
  return fallback
}

/** Read a number tolerating quoted numeric strings. */
function readNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Number(unquoteScalar(value))
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

/** Read a source value, falling back to `auto` for unknown text. */
function readSource(value: unknown): Source {
  const text = unquoteScalar(value).toLowerCase()
  return SOURCE_SET.has(text) ? text as Source : 'auto'
}

/** The raw panel fields of one effective row config (lenient, never throws). */
export function readPanelConfig(raw: unknown): PanelConfig {
  const row = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  return {
    source: readSource(row.source),
    bashPath: unquoteScalar(row.bashPath),
    wslDistro: unquoteScalar(row.wslDistro),
    loginShell: readBoolean(row.loginShell, true),
    verify: readBoolean(row.verify, true),
    probeTimeoutMs: readNumber(row.probeTimeoutMs, DEFAULT_PROBE_TIMEOUT_MS),
  }
}

/**
 * Normalize and validate one panel submission.
 * @param raw - request JSON (already parsed).
 * @returns the normalized config to persist.
 * @throws Error with a user-facing Chinese message when a field is invalid.
 */
export function validatePanelConfig(raw: unknown): PanelConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('配置必须是 JSON 对象')
  const row = raw as Record<string, unknown>
  if (row.source !== undefined && !SOURCE_SET.has(unquoteScalar(row.source).toLowerCase())) {
    throw new Error(`source 必须是 ${SOURCES.join(' / ')} 之一`)
  }
  const config = readPanelConfig(row)
  if (config.source === 'custom' && config.bashPath === '') {
    throw new Error('source=custom 时必须填写 bashPath')
  }
  if (row.probeTimeoutMs !== undefined) {
    const raw = typeof row.probeTimeoutMs === 'number' ? row.probeTimeoutMs : Number(unquoteScalar(row.probeTimeoutMs))
    if (!Number.isFinite(raw) || raw <= 0) throw new Error('probeTimeoutMs 必须是正数（毫秒）')
    config.probeTimeoutMs = raw
  }
  return config
}

/** Best-effort live shell facts for the status line. */
function shellSnapshot(ctx: Context): PanelShell {
  const shell = (ctx as unknown as { get(name: string): unknown }).get('shell')
  const describe = (shell as { describeResolved?: () => PanelShell } | undefined)?.describeResolved
  if (shell === undefined || typeof describe !== 'function') return { status: 'unavailable' }
  try {
    return describe.call(shell)
  } catch {
    return { status: 'unavailable' }
  }
}

/** Resolve the executor entry, or throw a diagnostic the panel shows verbatim. */
function findEntry(editor: ConfigEditorLike): LoaderEntryLike {
  const entry = editor.entries().find(candidate => candidate.options.id === ENTRY_ID)
  if (entry === undefined) throw new Error(`找不到 ${ENTRY_ID} 行（bundle 未启用或 profile 未安装）`)
  return entry
}

/** Read the effective config plus layer facts. */
function readState(ctx: Context, editor: ConfigEditorLike): PanelState {
  const entry = findEntry(editor)
  const config = readPanelConfig(entry.options.config)
  const layers = editor.configuration().find(candidate => candidate.entry.options.id === ENTRY_ID)
  const warnings: string[] = []
  if (config.source === 'custom' && config.bashPath === '') warnings.push('source=custom 需要 bashPath')
  if (config.bashPath !== '' && !existsSync(config.bashPath)) warnings.push(`bashPath 不存在：${config.bashPath}`)
  if (layers !== undefined && Object.keys(layers.override).length === 0) {
    warnings.push('当前值来自 bundle 默认值；保存后会写入 profile 用户层')
  }
  return {
    config,
    hasProfileOverride: layers !== undefined && Object.keys(layers.override).length > 0,
    warnings,
    sources: SOURCES,
    shell: shellSnapshot(ctx),
  }
}

/** Read and normalize a JSON request body (bounded). */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
    size += buffer.length
    if (size > 64 * 1024) throw new Error('请求体过大')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') throw new Error('请求体为空')
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** Same-origin guard: reject cross-site form posts and foreign origins. */
function guardOrigin(webServer: WebServerLike, req: IncomingMessage): void {
  const origin = req.headers.origin
  if (origin === undefined) return
  let expected: string
  try {
    expected = webServer.getOrigin()
  } catch {
    return
  }
  if (origin !== expected) throw new Error('拒绝跨站请求')
}

/** The panel's host plugin: one JSON route over the profile config editor. */
export function apply(ctx: Context): void {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const webServer = (ctx as unknown as { webServer: WebServerLike }).webServer
  const editor = (ctx as unknown as { configEditor: ConfigEditorLike }).configEditor
  const send = (res: ServerResponse, status: number, body: unknown): void => {
    const payload = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(payload)
  }
  const handler = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    try {
      guardOrigin(webServer, req)
      if (req.method === 'GET') {
        send(res, 200, { token, ...readState(ctx, editor) })
        return
      }
      if (req.method !== 'POST') {
        send(res, 405, { error: 'method not allowed' })
        return
      }
      if (req.headers['x-dsh-vsshell-token'] !== token) throw new Error('页面令牌不匹配，请刷新页面')
      const config = validatePanelConfig(await readJsonBody(req))
      const entry = findEntry(editor)
      await editor.edit(entry, current => ({
        ...current,
        source: config.source,
        bashPath: config.bashPath,
        wslDistro: config.wslDistro,
        loginShell: config.loginShell,
        verify: config.verify,
        probeTimeoutMs: config.probeTimeoutMs,
      }))
      send(res, 200, readState(ctx, editor))
    } catch (error) {
      send(res, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  }
  ctx.effect(() => webServer.register({ kind: 'exact', path: PANEL_PATH, handler }), 'dsh-vsshell: config panel route')
}
