// Browser half of the dsh-vsshell settings panel.
//
// Plain-JS Module Loader factory (no build step): registers a `settings.section`
// page and talks to the Host half (`lib/panel.js`) over one same-origin JSON
// route. Visible text goes through the Client locale service.
window.__ModuleLoader__.load({
  id: '@dsh-external/dsh-vsshell',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_PATH = '/dsh-vsshell-panel';

    const EN = {
      label: 'Bash executor',
      title: 'Bash executor (dsh-vsshell)',
      intro: 'Choose which bash the built-in `bash` tool runs. Changes are saved to the profile patch layer and applied through the Loader; if the tool does not pick them up, restart DSH.',
      source: 'Shell source',
      bashPath: 'bash path (optional; required for "custom")',
      bashPathHint: 'Quote characters are optional: D:\\Git\\bin\\bash.exe, \'D:\\Git\\bin\\bash.exe\' and "D:\\Git\\bin\\bash.exe" are equivalent.',
      wslDistro: 'WSL distribution (optional)',
      loginShell: 'Login shell (-lc)',
      verify: 'Probe the shell at startup (verify)',
      probeTimeoutMs: 'Probe timeout (ms)',
      save: 'Save',
      reload: 'Reload',
      saved: 'Saved. The row was written to the profile patch layer.',
      shellReady: 'Active shell',
      shellPending: 'Resolving the shell…',
      shellFailed: 'Resolution failed',
      shellUnavailable: 'No bash executor is mounted right now',
      profileDefault: 'Currently inherited from the bundle defaults',
      noWarnings: '',
      loading: 'Loading…',
      loadFailed: 'Could not load the configuration: {error}',
      saveFailed: 'Save failed: {error}',
      note: 'The panel only edits this plugin\'s six fields. Budgets and other config keys stay untouched.',
    };
    const ZH = {
      label: 'Bash 执行器',
      title: 'Bash 执行器（dsh-vsshell）',
      intro: '选择内置 `bash` 工具实际调用的 bash。保存后写入 profile 用户层，并通过 Loader 热应用；若工具未立即切换，请重启 DSH。',
      source: 'Shell 来源',
      bashPath: 'bash 路径（可选；source=custom 时必填）',
      bashPathHint: '引号可有可无：D:\\Git\\bin\\bash.exe、\'D:\\Git\\bin\\bash.exe\'、"D:\\Git\\bin\\bash.exe" 等价。',
      wslDistro: 'WSL 发行版（可选）',
      loginShell: '登录 shell（-lc）',
      verify: '启动时探测（verify）',
      probeTimeoutMs: '探测超时（毫秒）',
      save: '保存',
      reload: '重新读取',
      saved: '已保存，已写入 profile 用户层。',
      shellReady: '当前生效',
      shellPending: '正在解析 shell…',
      shellFailed: '解析失败',
      shellUnavailable: '当前没有挂载的 bash 执行器',
      profileDefault: '当前值继承自 bundle 默认值',
      noWarnings: '',
      loading: '读取中…',
      loadFailed: '读取配置失败：{error}',
      saveFailed: '保存失败：{error}',
      note: '面板只修改本插件的六个字段；预算等其它配置键保持不变。',
    };

    const TOKENS = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      borderStrong: 'var(--dsw-alias-border-l2)',
      surface: 'var(--dsw-alias-bg-layer-1)',
      field: 'var(--dsw-alias-bg-layer-2)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
      warn: 'var(--dsw-alias-state-warn-primary)',
    };

    let token = '';

    async function request(method, body) {
      const headers = {};
      if (body !== undefined) {
        headers['content-type'] = 'application/json';
        headers['x-dsh-vsshell-token'] = token;
      }
      const response = await fetch(PANEL_PATH, {
        method,
        headers,
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (error) {
        throw new Error('HTTP ' + response.status);
      }
      if (!response.ok) throw new Error(payload && payload.error ? payload.error : 'HTTP ' + response.status);
      if (typeof payload.token === 'string' && payload.token !== '') token = payload.token;
      return payload;
    }

    function shellLine(state, t) {
      const shell = state.shell;
      if (shell === undefined || shell.status === 'unavailable') return t('shellUnavailable');
      if (shell.status === 'pending') return t('shellPending');
      if (shell.status === 'failed') return t('shellFailed') + (shell.detail ? ': ' + shell.detail : '');
      return t('shellReady') + ': ' + (shell.label || shell.family || 'bash') + (shell.exe ? ' — ' + shell.exe : '');
    }

    // Set by apply(): the panel component reads them through this closure, so
    // the slot registration needs only the documented id/order/label options
    // (0.2.2-rc.1's settings.section contract has no per-registration inject).
    let runtime = null;

    function Panel() {
      const t = runtime.t;
      const [, forceRender] = React.useReducer(value => value + 1, 0);
      React.useEffect(() => {
        // `label`/copy follow the active locale; re-render when it changes.
        const stop = runtime.ctx.locale.subscribe(() => forceRender());
        return stop;
      }, []);
      const [state, setState] = React.useState(null);
      const [form, setForm] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const [message, setMessage] = React.useState(null);

      const applyPayload = React.useCallback(payload => {
        setState(payload);
        setForm({
          source: payload.config.source,
          bashPath: payload.config.bashPath,
          wslDistro: payload.config.wslDistro,
          loginShell: payload.config.loginShell,
          verify: payload.config.verify,
          probeTimeoutMs: String(payload.config.probeTimeoutMs),
        });
      }, []);

      const load = React.useCallback(async () => {
        setBusy(true);
        setMessage(null);
        try {
          applyPayload(await request('GET'));
        } catch (error) {
          setMessage({ kind: 'error', text: t('loadFailed', { error: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy(false);
        }
      }, [applyPayload, t]);

      React.useEffect(() => { void load(); }, [load]);

      if (form === null || state === null) {
        return h('div', { style: { color: TOKENS.muted, padding: '8px 0' } },
          busy ? t('loading') : message !== null ? message.text : '');
      }

      const update = key => event => {
        const value = event.target.type === 'checkbox' ? event.target.checked : event.target.value;
        setForm(current => ({ ...current, [key]: value }));
      };
      const save = async () => {
        setBusy(true);
        setMessage(null);
        try {
          const payload = await request('POST', {
            ...form,
            probeTimeoutMs: Number(form.probeTimeoutMs),
          });
          applyPayload(payload);
          setMessage({ kind: 'success', text: t('saved') });
        } catch (error) {
          setMessage({ kind: 'error', text: t('saveFailed', { error: String(error && error.message ? error.message : error) }) });
        } finally {
          setBusy(false);
        }
      };

      const row = (label, control, hint) => h('div', { style: { display: 'grid', gridTemplateColumns: '200px minmax(0, 1fr)', gap: '12px', alignItems: 'center', padding: '8px 0', borderTop: '1px solid ' + TOKENS.border } },
        h('div', { style: { color: TOKENS.text, fontSize: '13px' } }, label),
        h('div', { style: { display: 'grid', gap: '4px' } }, control, hint ? h('div', { style: { color: TOKENS.muted, fontSize: '12px', lineHeight: '1.4' } }, hint) : null));

      const inputStyle = {
        width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: '13px',
        color: TOKENS.text, background: TOKENS.field, border: '1px solid ' + TOKENS.borderStrong,
        borderRadius: '6px', outline: 'none',
      };
      const buttonStyle = {
        padding: '6px 14px', fontSize: '13px', borderRadius: '6px', cursor: busy ? 'default' : 'pointer',
        color: TOKENS.text, background: TOKENS.field, border: '1px solid ' + TOKENS.borderStrong,
        opacity: busy ? 0.6 : 1,
      };
      const primaryButtonStyle = Object.assign({}, buttonStyle, { borderColor: TOKENS.brand, color: TOKENS.brand, fontWeight: 600 });

      return h('div', { style: { display: 'grid', gap: '10px', color: TOKENS.text, fontSize: '13px', maxWidth: '760px', padding: '4px 0' } },
        h('div', { style: { fontSize: '16px', fontWeight: 600 } }, t('title')),
        h('div', { style: { color: TOKENS.muted, lineHeight: '1.5' } }, t('intro')),
        h('div', {
          style: {
            padding: '8px 10px', borderRadius: '8px', background: TOKENS.surface,
            border: '1px solid ' + TOKENS.border, color: state.shell && state.shell.status === 'failed' ? TOKENS.error : TOKENS.muted,
            fontSize: '12px', lineHeight: '1.5',
          },
        }, shellLine(state, t)),
        state.warnings && state.warnings.length > 0
          ? h('div', { style: { display: 'grid', gap: '4px' } },
            ...state.warnings.map((warning, index) => h('div', { key: index, style: { color: TOKENS.warn, fontSize: '12px' } }, warning)))
          : null,
        h('div', { style: { borderTop: '1px solid ' + TOKENS.border, marginTop: '4px' } }),
        row(t('source'),
          h('select', { value: form.source, onChange: update('source'), style: inputStyle },
            ...state.sources.map(source => h('option', { key: source, value: source }, source)))),
        row(t('bashPath'),
          h('input', { value: form.bashPath, onChange: update('bashPath'), spellCheck: false, placeholder: 'C:\\cygwin64\\bin\\bash.exe', style: inputStyle }),
          t('bashPathHint')),
        row(t('wslDistro'),
          h('input', { value: form.wslDistro, onChange: update('wslDistro'), spellCheck: false, placeholder: 'Ubuntu', style: inputStyle })),
        row(t('probeTimeoutMs'),
          h('input', { value: form.probeTimeoutMs, onChange: update('probeTimeoutMs'), inputMode: 'numeric', style: inputStyle })),
        row(t('loginShell'),
          h('input', { type: 'checkbox', checked: Boolean(form.loginShell), onChange: update('loginShell') })),
        row(t('verify'),
          h('input', { type: 'checkbox', checked: Boolean(form.verify), onChange: update('verify') })),
        h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', paddingTop: '8px' } },
          h('button', { type: 'button', onClick: save, disabled: busy, style: primaryButtonStyle }, t('save')),
          h('button', { type: 'button', onClick: load, disabled: busy, style: buttonStyle }, t('reload')),
          message === null ? null : h('span', {
            style: {
              color: message.kind === 'error' ? TOKENS.error : TOKENS.success,
              fontSize: '12px', lineHeight: '1.5',
            },
          }, message.text)),
        h('div', { style: { color: TOKENS.muted, fontSize: '12px', lineHeight: '1.5' } }, t('note')));
    }

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      runtime = { t: ctx.locale.bind('vsshell'), ctx };
      ctx.effect(() => ctx.locale.register('vsshell', { en: EN, zh: ZH }), 'dsh-vsshell: panel locale');
      ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'dsh-vsshell',
        order: 55,
        label: () => ctx.locale.bind('vsshell')('label'),
      }, Panel)), 'dsh-vsshell: settings section');
    }

    return { inject, apply };
  },
});
