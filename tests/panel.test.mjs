// Unit tests for the configuration panel's quote-tolerant normalization.
//
// The panel accepts values pasted from the profile patch (`'...'`, `"..."`, or
// bare) and must normalize them before comparing/writing, so these cases pin
// the exact behavior the Host half relies on.
import assert from 'node:assert/strict'
import test from 'node:test'

import { apply, readPanelConfig, unquoteScalar, validatePanelConfig } from '../lib/panel.js'

test('unquoteScalar: single, double, bare and escaped forms', () => {
  assert.equal(unquoteScalar('D:\\Git\\bin\\bash.exe'), 'D:\\Git\\bin\\bash.exe')
  assert.equal(unquoteScalar("'D:\\Git\\bin\\bash.exe'"), 'D:\\Git\\bin\\bash.exe')
  assert.equal(unquoteScalar('"D:\\Git\\bin\\bash.exe"'), 'D:\\Git\\bin\\bash.exe')
  assert.equal(unquoteScalar('"D:\\\\Git\\\\bin\\\\bash.exe"'), 'D:\\Git\\bin\\bash.exe')
  assert.equal(unquoteScalar("'it''s bash'"), "it's bash")
  assert.equal(unquoteScalar('  /usr/bin/bash  '), '/usr/bin/bash')
  assert.equal(unquoteScalar(undefined), '')
  assert.equal(unquoteScalar(null), '')
  // A mismatched pair is not a quoted scalar.
  assert.equal(unquoteScalar("'D:\\Git"), "'D:\\Git")
})

test('readPanelConfig: defaults and quote-tolerant booleans/numbers', () => {
  assert.deepEqual(readPanelConfig(undefined), {
    source: 'auto',
    bashPath: '',
    wslDistro: '',
    loginShell: true,
    verify: true,
    probeTimeoutMs: 15_000,
  })
  const config = readPanelConfig({
    source: "'custom'",
    bashPath: "'C:\\cygwin64\\bin\\bash.exe'",
    loginShell: "'false'",
    verify: '"true"',
    probeTimeoutMs: "'5000'",
  })
  assert.equal(config.source, 'custom')
  assert.equal(config.bashPath, 'C:\\cygwin64\\bin\\bash.exe')
  assert.equal(config.loginShell, false)
  assert.equal(config.verify, true)
  assert.equal(config.probeTimeoutMs, 5_000)
  // Unknown source text degrades to auto for display instead of throwing.
  assert.equal(readPanelConfig({ source: 'nonsense' }).source, 'auto')
})

test('validatePanelConfig: quoted values are accepted and normalized', () => {
  const config = validatePanelConfig({
    source: '"cygwin"',
    bashPath: "'C:\\cygwin64\\bin\\bash.exe'",
    wslDistro: "''",
    loginShell: 'false',
    verify: 'true',
    probeTimeoutMs: '15000',
  })
  assert.deepEqual(config, {
    source: 'cygwin',
    bashPath: 'C:\\cygwin64\\bin\\bash.exe',
    wslDistro: '',
    loginShell: false,
    verify: true,
    probeTimeoutMs: 15_000,
  })
})

test('validatePanelConfig: rejects invalid submissions with actionable text', () => {
  assert.throws(() => validatePanelConfig({ source: 'custom', bashPath: '' }), /source=custom 时必须填写 bashPath/u)
  assert.throws(() => validatePanelConfig({ source: 'fish' }), /source 必须是/u)
  assert.throws(() => validatePanelConfig({ source: 'auto', probeTimeoutMs: 0 }), /probeTimeoutMs 必须是正数/u)
  assert.throws(() => validatePanelConfig({ source: 'auto', probeTimeoutMs: 'NaN' }), /probeTimeoutMs 必须是正数/u)
  assert.throws(() => validatePanelConfig(null), /配置必须是 JSON 对象/u)
})

/** A fake `configEditor` that reads/writes one row config in memory. */
function fakeEditor(initialConfig) {
  let config = initialConfig
  const entry = { options: { id: 'dsh-vsshell', name: '@dsh-external/dsh-vsshell', config } }
  const edits = []
  return {
    edits,
    entries: () => [entry],
    configuration: () => [{ entry, inherited: {}, override: config }],
    async edit(target, change) {
      const next = change(structuredClone(config), {})
      edits.push(next)
      config = next
      entry.options.config = next
    },
  }
}

/** Build a minimal fake host context for the panel's route registration. */
function fakeHost(editor) {
  /** @type {{ handler: Function } | undefined} */
  let route
  const ctx = {
    effect: effect => effect(),
    webServer: {
      getOrigin: () => 'http://127.0.0.1:3080',
      register: registered => {
        route = registered
        return () => {}
      },
    },
    configEditor: editor,
    get: () => undefined,
  }
  apply(ctx)
  return () => route
}

/** Invoke the registered route with a fake request and response. */
async function call(route, method, body, headers = {}) {
  const req = {
    method,
    headers: { origin: 'http://127.0.0.1:3080', ...headers },
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body))
    },
  }
  const res = {
    writeHead(status, responseHeaders) {
      this.status = status
      this.headers = responseHeaders
    },
    end(payload) {
      this.payload = JSON.parse(payload)
    },
  }
  await route.handler(req, res)
  return res
}

test('panel route: GET normalizes quoted row values, POST persists unquoted config', async () => {
  const editor = fakeEditor({
    source: "'custom'",
    bashPath: "'C:\\cygwin64\\bin\\bash.exe'",
    loginShell: "'false'",
  })
  const route = fakeHost(editor)()
  assert.ok(route, 'the panel must register one web route')

  const got = await call(route, 'GET')
  assert.equal(got.status, 200)
  assert.equal(got.payload.config.source, 'custom')
  assert.equal(got.payload.config.bashPath, 'C:\\cygwin64\\bin\\bash.exe')
  assert.equal(got.payload.config.loginShell, false)
  assert.ok(got.payload.sources.includes('cygwin'))
  assert.ok(typeof got.payload.token === 'string' && got.payload.token.length > 0)

  const sent = await call(route, 'POST', {
    source: '"cygwin"',
    bashPath: "'C:\\cygwin64\\bin\\bash.exe'",
    wslDistro: "''",
    loginShell: 'true',
    verify: '"false"',
    probeTimeoutMs: "'9000'",
  }, { 'x-dsh-vsshell-token': got.payload.token })
  assert.equal(sent.status, 200)
  assert.equal(editor.edits.length, 1)
  assert.equal(editor.edits[0].source, 'cygwin')
  assert.equal(editor.edits[0].bashPath, 'C:\\cygwin64\\bin\\bash.exe')
  assert.equal(editor.edits[0].loginShell, true)
  assert.equal(editor.edits[0].verify, false)
  assert.equal(editor.edits[0].probeTimeoutMs, 9_000)
  assert.equal(sent.payload.config.source, 'cygwin')
})

test('panel route: rejects a bad token, a foreign origin and an invalid config', async () => {
  const editor = fakeEditor({ source: 'auto' })
  const route = fakeHost(editor)()

  const badToken = await call(route, 'POST', { source: 'auto' }, { 'x-dsh-vsshell-token': 'wrong' })
  assert.equal(badToken.status, 400)
  assert.match(badToken.payload.error, /令牌/u)

  const foreign = await call(route, 'GET', undefined, { origin: 'http://evil.example' })
  assert.equal(foreign.status, 400)
  assert.match(foreign.payload.error, /跨站/u)

  const got = await call(route, 'GET')
  const invalid = await call(route, 'POST', { source: 'custom', bashPath: '' }, { 'x-dsh-vsshell-token': got.payload.token })
  assert.equal(invalid.status, 400)
  assert.match(invalid.payload.error, /bashPath/u)
  assert.equal(editor.edits.length, 0)
})
