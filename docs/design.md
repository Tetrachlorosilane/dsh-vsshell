# dsh-vsshell 设计规划（v1）

> 本文是 `dsh-vsshell` 插件包的实现规划与设计约束，也是 README / AGENTS / 代码的共同事实来源。
> 目标平台：Windows 上的 DeepSeek Harness（Desktop Web profile 为主，CLI/headless 兼容）。

## 1. 目标与验收

**目标**：为 Windows 上运行的 DeepSeek Harness 提供内置 `tool-bash` 工具的可用 bash 接入，并以 `bash` 工具取代 `pwsh` 工具。
用户可自行选择 bash 来源与可执行文件路径，至少兼容：

- WSL bash（`wsl.exe --exec bash`，或旧版 `%SystemRoot%\System32\bash.exe`）
- Git for Windows bash（MSYS2）
- Cygwin bash
- 自定义 bash 路径（`custom`）

**验收（第一阶段，静态）**：

1. `pnpm run build` 产出 `lib/index.js`（ESM）与 `lib/*.d.ts`，`pnpm run typecheck` 无错误。
2. `pnpm run check` 全绿：类型检查 + 单元测试 + `cordis.patch.yml` 结构校验 + 生成物一致性校验。
3. `cordis.patch.yml` 中：host 层 `pwsh-sandbox`/`tool-pwsh` 被禁用、插入 `dsh-vsshell` 执行器行；`preset-standard`/`preset-cordis`/`preset-ptc` 覆盖为 `tool-bash` 启用、`tool-pwsh` 禁用。
4. README.md 覆盖安装、配置、来源选择、路径语义、限制与排障；AGENTS.md 覆盖本仓库的开发约定。

**验收（第二阶段，插入检查，另行进行）**：在 desktop profile 中 `plugin_manager install_bundle` 安装，重启/重载后确认：`bash` 工具存在、`pwsh` 工具不存在、四个 bash 来源可切换、后台任务/超时/输出截断正常。

## 2. 背景事实（已在真机验证）

- DSH 基础组合在 win32 上：`bash-sandbox` 被禁用、`pwsh-sandbox` 启用（提供 `ctx.shell`），`tool-bash` 被禁用、`tool-pwsh` 启用。
- Web profile 的 host 层工具行被 `dsh-web-app` 统一禁用，模型可见的工具由 **agent preset**（`preset-standard` / `preset-cordis` / `preset-minimal` / `preset-ptc`）的 `config.plugins` 提供；preset 行是 `@deepseek-ai/dsh-agent-preset` 的声明行，只能用「整份 `config.plugins` 覆盖」的方式改（DSH 官方文档亦如此说明）。本 bundle 的 patch 会在这一层之后再覆盖三个 preset，并把 host 层的 `tool-bash` 重新打开（见下一条：Web 里它被 agent-scope 同名行遮蔽）。
- 外部 bundle 的 patch 层按 profile `dsh.profile.bundles` 顺序叠加，最后是 profile 自己的 `cordis.patch.yml`（用户层覆盖 bundle 层）。
- 外部插件在运行时 import 的 `@deepseek-ai/*` 包由 profile 的运行时解析拦截映射到 DSH 安装目录，因此只需声明 `peerDependencies`（兼容性检查依赖它们）与开发期 `devDependencies`（供 tsc 使用）。
- **目标版本精确固定为 0.2.2-rc.3**：`presets/` 保存该版本**安装**自带的 standard/ptc/cordis 三份 preset 原文（`source.json` 记录版本、来源与三份文件的 sha256），`package.json` 的 devDependencies 精确固定 0.2.2-rc.3、peerDependencies 也写**精确版本**（不是 `~`，否则后续版本会被兼容检查静默放行）；`check:patch` 断言「生成物头部目标版本 = 快照版本 = devDependency 版本」，生成器与测试逐字节校验 `sha256`。**0.2.2 系列改过两次 preset 形状**：rc.1 是 minor 变更（list-agents 并入 tool-subagent-control、modelSelection/modelDiscovery、ptc 改用 tool-executor-ptc、tool-plugin-market/applyPatch 等），rc.3 又加入 tool-office（standard/ptc）、standard 的 skill-filesystem customSkillDirs、tool-subagent-control 的 `interrupt: false` 与 cordis persona 文本；两次都已整份替换快照并更新 sha256 与测试指纹。**不要假设 patch 版本快照不变**，也不要用开发源码检出的 preset 生成 patch。
- host `tool-bash` 行**常开**（`disabled: false`）。曾用 `!!js "!!ctx.get('agentPresets')"` 做「仅 CLI 启用」的门控，但 Loader 在同层服务 active 前就求值该表达式、结果恒为 false；且 tools 注册表只在**同一 scope** 内拒绝重名，Web preset 的 agent-scope `bash` 会遮蔽 host 层同名行，因此常开是安全且诚实的做法。
- **实测（关键约束）**：在 DSH 的 Windows ACL 沙箱（受限令牌）内，Git Bash 启动即报 `couldn't create signal pipe, Win32 error 5`，WSL 报 `Wsl/E_ACCESSDENIED`；两者都**无法**在受限令牌内运行。因此 bash 执行**不做沙箱约束**——这是用户已确认接受的能力弱化。
- **但 `sandboxMode` 必须声明**：DSH 的 `permission-presets` 在 `sandboxMode === undefined` 的 shell 执行器上直接拒绝激活（实测安装结果 `application: failed`，GUI 权限预设/投影不可用），并把该值当作会话默认 sandbox 模式。因此执行器的 `sandboxMode` getter 镜像 `ctx.sandboxPolicy.defaultMode`（部署默认 FILE 策略，通常 `workspace-write`）。它**只表示组合事实，不表示 bash 被约束**：`resolve()` 丢弃 per-call `sandboxPolicy`、结果不带 sandbox facts、prompt 明确写「bash 不设限」；`bash` 工具因此会广告 `sandbox_permissions`，但传入的策略不会被执行。
- Cygwin 的 `/etc/profile` 会把 login shell `cd` 到 `$HOME`：native bash 启动统一导出 `CHERE_INVOKING=1`（Cygwin 标准约定，Git Bash 忽略）以保住 `workdir`；WSL 不带该变量。
- 实测其余语义（非受限令牌下）：
  - Git Bash：`spawn(exe, ['-lc', cmd], { cwd: 'C:\\...' })` 正常；`pwd` 输出 `/c/Users/...`；继承 Windows 环境变量（`DSH_*` 直接可见）；`OSTYPE=msys`；退出码原样传递；UTF-8 正常。
  - WSL：`spawn('wsl.exe', ['--exec','bash','-lc',cmd], { cwd: 'C:\\...' })` 正常；`pwd` 自动翻译为 `/mnt/c/...`；**不继承** Windows 环境变量，需 `WSLENV` 转发（实测 `DSH_X`/`TERM` 经 `WSLENV` 生效）；`OSTYPE=linux-gnu`；`WSL_UTF8=1` 避免诊断信息 UTF-16 乱码；退出码原样传递。
  - `wsl.exe` 在检测到本机 localhost 代理配置时会向 stderr 打一行 `wsl: 检测到 localhost 代理配置...` 警告（UTF-8 时为可读文本）。这是 launcher 横幅，不影响命令结果；v1 记录为已知现象，不做 stderr 过滤（过滤会篡改命令真实输出）。

## 3. 架构

```
profile 组合树（host 层）
├─ dsh-vsshell（本包，host 行）      ← 提供 ctx.shell：可配置 bash 执行器（替代 pwsh-sandbox）
├─ dsh-vsshell/panel（本包，host 行）← 配置面板 Host 半：/dsh-vsshell-panel JSON 路由 + configEditor 读写
├─ tool-bash（内置，host 行）        ← 常开；Web preset 的同名行在 agent scope 遮蔽它
├─ tool-pwsh / pwsh-sandbox          ← 禁用
└─ preset-*（@deepseek-ai/dsh-agent-preset）
      └─ plugins 覆盖：tool-bash 启用 + tool-pwsh 禁用
browser（dsh.client → client.js）
└─ settings.section「Bash 执行器」   ← 表单 + GET/POST /dsh-vsshell-panel（不引入 React 构建、无 iframe）
```

- 执行器复用 `@deepseek-ai/dsh-bash-local` 的 `LocalBashExecutor`（子进程生命周期、超时/取消、输出收集、spill、后台任务语义全部继承），只覆盖两处：
  - `resolve()`：继承父类默认值，附加 workdir 的 POSIX→Windows 翻译；
  - `execute()`：把 argv 换成解析后的 bash 调用，WSL 时注入 `WSLENV`/`WSL_UTF8`。
- 不复制 `bash-local` 的执行循环（约 200 行），避免与上游漂移。
- bash 目标解析在**构造时后台启动**（不阻塞 host 启动、便于 prompt section 尽早说出真实 shell），首次 `execute()` 等待它；等待受本次调用的取消信号与前台 deadline 约束（`awaitTarget`）。解析失败不缓存，下一次调用重试（装好 bash 后无需重启自愈）；失败信息通过工具调用错误返回（含候选列表与 stderr 尾部摘要）。
- host 插件额外注册一条全局 system-prompt section（order = `TOOL_BASH` + 1），向模型说明当前生效的 bash 家族与 invocation、路径写法，以及「bash 不受 harness 文件沙箱约束 / `sandbox_permissions` inert」这一事实；内容遵循最小化原则（§7）。该 section 是全局的：未覆盖的 `minimal` preset（persistent PTY shell）会话也会看到这段通用说明（README 已披露）。
- 配置面板拆成两个半：Host 半（`src/panel.ts`，作为 package 子路径 `./panel` 的第二条 insert 行）注册一条同源 JSON 路由；browser 半（根目录 `client.js`，由 `dsh.client` 加载）在 `settings.section` 注册表单。持久化只经 `configEditor.edit()`（Loader 文档读写，保留 YAML 注释/顺序/引号形态），不手写 profile patch；输入值先做引号归一化（§7.5）。

## 4. 文件布局

```
dsh-vsshell/
├─ package.json              # 包元数据、dsh.bundle.patch、peerDeps、devDeps、scripts
├─ tsconfig.json             # tsc: ESM/NodeNext → lib/
├─ presets/                  # 目标版 DSH 的 shipped preset 快照（standard/ptc/cordis + source.json）
├─ cordis.patch.yml          # 【生成物】host 行 + preset 覆盖（scripts/gen-preset-patch.mjs 生成，头注释含目标 DSH 版本）
├─ README.md                 # 用户文档（中文）
├─ AGENTS.md                 # 仓库开发约定（给后续 agent）
├─ docs/design.md            # 本文件
├─ src/
│  ├─ index.ts               # 插件入口：Config schema、VsshellBashExecutor、prompt section、describeResolved
│  ├─ detect.ts              # 纯函数：候选路径、探测、workdir 翻译、argv/WSLENV 构造
│  └─ panel.ts               # 配置面板 Host 半：/dsh-vsshell-panel 路由、引号归一化、configEditor 写入
├─ client.js                 # 配置面板 browser 半：Module Loader 懒工厂，注册 settings.section
├─ locale/en.json、locale/zh.json、icon.svg  # 插件显示元数据与图标
├─ tests/
│  ├─ detect.test.mjs        # detect 纯函数单测（node:test，注入假 exists/probe）
│  ├─ executor.test.mjs      # 插件 wire + execute 接线（裸 cordis + 假 subprocess，verify:false 不 spawn）
│  ├─ patch.test.mjs         # patch 结构、目标版本、目标版本特征、生成物一致性
│  └─ panel.test.mjs         # 面板：引号归一化、校验、假 webServer/configEditor 的 GET/POST/token/跨站
├─ scripts/
│  ├─ gen-preset-patch.mjs   # 从 presets/ 快照（或 --source 指定的 DSH 检出）生成 cordis.patch.yml（gen:patch）
│  ├─ check-patch.mjs        # 校验结构 + 目标版本 + 生成物一致性（check:patch，自包含）
│  ├─ check.mjs              # check 编排：typecheck → build → 产物语法 → 单测 → patch 校验
│  ├─ test.mjs               # 单进程 import tests/*.test.mjs（沙箱内不能 spawn 子进程）
│  └─ smoke-executor.mjs     # 真机冒烟（唯一启动真实 bash 的脚本，需非受限令牌）
├─ .npmrc                    # node-linker=hoisted（本地脚本可直接 node 解析 @deepseek-ai/*）
├─ .gitattributes            # 固定 LF，保证生成物逐字一致性校验不被 CRLF 破坏
├─ lib/                      # 【构建产物】
└─ scratch/                  # 真机探测脚本（不发布，最终可留档）
```

## 5. 配置 schema（`Config`）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `source` | `'auto' \| 'wsl' \| 'git-bash' \| 'cygwin' \| 'custom'` | `auto` | bash 来源。`auto` 按 git-bash → cygwin → wsl 顺序探测 |
| `bashPath` | string | `''` | 显式可执行文件路径。`wsl` 时可指向 `wsl.exe` 或 `bash.exe`；`custom` 时必填；其余来源下非空即作为**唯一候选**（默认仍做存在性检查与探测；仅 `verify: false` 时完全信任、不检查也不探测） |
| `wslDistro` | string | `''` | WSL 发行版名（对应 `wsl.exe -d`）；空 = 默认发行版。对任何最终走 WSL launcher 的来源生效（含 `auto` 回退到 WSL 时） |
| `loginShell` | boolean | `true` | `true` 用 `-lc`（加载 profile，PATH 更完整、冷启动更慢），`false` 用 `-c` |
| `verify` | boolean | `true` | 首次使用前探测 bash 可否启动并识别 `$OSTYPE` 家族；`false` 信任第一个存在的路径（显式 `bashPath` 完全不校验），跳过探测延迟，代价是失去家族识别与提前报错 |
| `probeTimeoutMs` | number | `15000` | 单候选探测超时（毫秒），需为正有限数 |
| `cwd` / `timeoutMs` / `maxTimeoutMs` / `maxOutputBytes` / `maxSpillBytes` / `graceMs` | 继承 `bash-local` | 同 `bash-local` | 执行预算；从 `LocalBashExecutor.Config` 原样复制到本插件 schema |

校验（构造时抛错，host 日志可见，不静默降级）：

- `source: custom` 且 `bashPath` 为空 → 错误。
- `probeTimeoutMs <= 0` 或非有限 → 错误。
- `wslDistro` 只影响 WSL 启动器；配给纯 native 来源时不被使用（不是错误）。

## 6. bash 来源解析（`src/detect.ts`）

纯函数 + 依赖注入，便于单测（不真的 spawn）：

```ts
type BashKind = 'native' | 'wsl'
interface BashCandidate { exe: string; kind: BashKind; label: string }
interface BashTarget { exe: string; kind: BashKind; label: string; family: string; loginShell: boolean; wslDistro: string; source: Source }
```

- `candidatePaths(source, env, platform)`：返回候选 `BashCandidate[]`（**纯路径枚举**，不做存在性检查；存在性由 `resolveBashTarget` 经注入的 `deps.exists` 逐个判断）。
  - git-bash：`%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles%\Git\usr\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`、`%USERPROFILE%\scoop\apps\git\current\bin\bash.exe`
  - cygwin：`%SystemDrive%\cygwin64\bin\bash.exe`、`%SystemDrive%\cygwin\bin\bash.exe`、`%ProgramFiles%\Cygwin64\bin\bash.exe`、`%ProgramFiles%\Cygwin\bin\bash.exe`
  - wsl：`%SystemRoot%\System32\wsl.exe`、`%SystemRoot%\System32\bash.exe`（后者为旧版 launcher，仍以 WSL 语义调用）
  - `auto`：git-bash → cygwin → wsl 三段拼接，去重。
- `probeArgv(candidate, wslDistro)`：探测 argv。命令固定为 `printf '__vsshell_probe__:%s\n' "${OSTYPE:-unknown}"`，恒用 `-c`（探测不加载 profile，快且不影响判定；`loginShell` 只影响正式调用的 `buildInvocation`）。
- `parseProbe(stdout)`：提取 `family`（`msys` / `cygwin` / `linux-gnu` / `unknown`）与是否命中 marker。
- `resolveBashTarget(options, deps)`：按候选顺序 `exists` → `probe`，首个成功者即目标；`verify: false` 时只做 `exists`（显式 `bashPath` 直接采用、完全不校验），家族记为 `unknown`；全部失败时抛出聚合错误（逐候选 `exe + 失败原因 + 单行尾部摘要`）。`deps` 默认实现用 `node:fs` + `node:child_process.spawn`，单测可注入假实现。
- `buildInvocation(target, command)`：
  - native：`[exe, login ? '-lc' : '-c', command]`
  - wsl + `wsl.exe`：`[exe, ...(distro ? ['-d', distro] : []), '--exec', 'bash', login ? '-lc' : '-c', command]`
  - wsl + `bash.exe`：`[exe, login ? '-lc' : '-c', command]`
- `translateWorkdir(workdir, source)`（纯函数）：
  - `/mnt/<d>/rest` → `<D>:\rest`（任何 source）
  - `/cygdrive/<d>/rest` → `<D>:\rest`（任何 source）
  - `/<d>/rest` → `<D>:\rest` **仅当** `source` 显式为 `'git-bash'` 或 `'cygwin'`（避免误伤 `/home`、`/tmp`）；盘符根 `/c`、`/c/` 同样翻译为 `C:\`
  - 其余原样返回；已含盘符的 Windows 路径原样返回。
- `buildWslEnv({ env, dshEnv, inheritedWslEnv })`：`WSLENV` = 既有 `process.env.WSLENV` 条目 + `DSH_*`（`spec.dshEnv`）+ `spec.env` 键 + `TerminalOverrides`（`NO_COLOR/TERM/PAGER/GIT_PAGER`），去重；再加 `WSL_UTF8=1`。仅 `kind === 'wsl'` 使用。

## 7. 执行器（`src/index.ts`）

```ts
export default class VsshellBashExecutor extends LocalBashExecutor {
  static override inject = ['subprocess', 'systemPrompt', 'sandboxPolicy']
  static override Config = z.object({ ...bashLocalBudgetFields, ...vsshellFields })
  resolve(request)        // super.resolve + translateWorkdir + 去掉 sandboxPolicy
  async execute(spec)     // target = await awaitTarget(spec)（受 signal/timeout 约束）；assertWorkdir（spawn 前给出可读原因）；argv = buildInvocation；native 注入 CHERE_INVOKING=1、wsl 注入 env；executeArgv
}
```

- `sandboxMode` getter 返回构造时捕获的 `ctx.sandboxPolicy.defaultMode`：这是 `permission-presets` 的组合前提（`undefined` 会被拒绝激活），**不代表执行器 confine**；`resolve()` 仍丢弃 `sandboxPolicy`、结果不带 sandbox facts，prompt 如实写明 bash 不设限（见 §2）。
- 首次 `execute` 通过 `awaitTarget()` 等待构造时启动的后台解析：等待受本次调用的 `signal` 与前台 `timeoutMs` 约束（超时/取消都终止等待并报可用错误），解析成功后写日志；失败后不缓存，下次调用重新探测（便于用户装好 WSL 后自愈）。
- system-prompt section 文本由状态快照函数生成（`text: () => ...`），遵循**最小化原则**（有长度上限测试），只放每次调用都需要的差异事实：
  - `Shell:` 一行：来源/家族 + 真实 invocation（可执行文件只出现一次，Git Bash → `/c/...`、WSL → `/mnt/c/...`、Cygwin → `/cygdrive/c/...`）；
  - 一条路径提示（按家族只给相关的那条）；
  - `DSH_*` 是否可用（WSL 经 `WSLENV` 转发）；
  - 一行沙箱事实：bash **不受**文件沙箱约束（文件工具仍受），`sandbox_permissions` / `justification` 对本工具 **inert**（升级请求不改变任何约束）。
  - **不重复** tool-bash 原生 description 已有的内容（如每个 shell 都是 fresh、用 `workdir` 代替 `cd`）；**失败细节不放进 prompt**，而是放在错误消息里（解析失败列候选与原因；`workdir` 缺失在 spawn 前列出可接受前缀），只在真正失败时消耗上下文。实测 ready 状态约 280–420 字符（旧版约 1.2k）。

## 7.5 配置面板（`src/panel.ts` + `client.js`）

目标：一个无需手写 YAML 的最小可视化配置入口，且不引入前端构建链。

- **Host 半**（`src/panel.ts`，package 子路径 `./panel`，bundle 的第二条 insert 行 `dsh-vsshell-panel`）：
  - `inject = ['webServer', 'configEditor']`；在 `webServer.register({ kind: 'exact', path: '/dsh-vsshell-panel' })` 注册一条同源 JSON 路由；
  - `GET` 返回 `{ token, config, hasProfileOverride, warnings, sources, shell }`，`shell` 来自执行器的 `describeResolved()`；
  - `POST` 校验字段后调用 `ctx.configEditor.edit(entry, current => ({ ...current, ...六个字段 }))`：由 Loader 写 profile patch 并热协调，YAML 注释/顺序/引号形态由 DSH 维护；
  - 安全边界：`Origin` 必须等于 `webServer.getOrigin()`；POST 需要本进程生成的 `x-dsh-vsshell-token`（GET 下发）；请求体上限 64 KiB；只监听本机 Web 端口。
- **Browser 半**（根目录 `client.js`，由 `dsh.client` 加载、无构建）：Module Loader 懒工厂，注册 `settings.section` 一个页面；表单字段与 Host 六字段一致；文案走 `ctx.locale.register/bind('vsshell')`；不写 DOM、不引入 Harness Client 包。**0.2.2-rc.3 的 `settings.section` 注册契约只含 `id`/`order`/`label`**（原来的 `locale`/`inject` 注册选项不在契约里），因此组件通过 factory 闭包拿 `t`/`ctx`，并在组件内用 `ctx.locale.subscribe()` 订阅语言变化触发重渲染；`label` 仍是 thunk，随投影重读。
- **引号兼容**：`unquoteScalar()` 去掉成对单/双引号（并处理 `\\`、`''` 转义），`readBoolean`/`readNumber` 接受带引号的字符串；`readPanelConfig` 对缺省/未知值回退默认；`validatePanelConfig` 在写入前统一归一化。读取路径完全交给 YAML 层（profile patch 里引号怎么写都能读），因此"引号有无"只影响用户输入框里的文本，不影响持久化格式。
- **不手写 YAML**：面板自己不做 profile patch 文本编辑；`configEditor` 是唯一写入通道（失败会回滚并抛错），面板把错误原文返回给表单。

## 7.6 插件安装生命周期（热安装与 `ctx.shell` 唯一性）

- Cordis 的 **一个 context 只允许一个 `shell` 服务**；`ShellExecutor` 子类在构造时立即通过 `ctx.provide('shell', …)` 注册。因此“执行器类”不能直接作为 bundle 的默认导出：`plugin_manager install_bundle` 是**热安装**，新 bundle 层叠加时旧 `pwsh-sandbox`（`SandboxPwshExecutor`）可能仍在当前 context 中占着 `ctx.shell`，直接 `new` 就会抛 `service "shell" has been registered at <SandboxPwshExecutor>`，并且此时 bundle patch 已经禁用了 `tool-pwsh` → 部署会变成**一个 shell 工具都没有**。
- 修复：默认导出 `VsshellBashExecutor` 只是一个**延迟挂载 wrapper**——
  - 先做与旧实现一致的 load-time 配置校验（`custom` 必须有 `bashPath`、`probeTimeoutMs` 必须为正），保证无效配置仍在插件加载阶段被拒绝；
  - `ctx.shell` 空闲时同步构造 `VsshellService`（真正的 `LocalBashExecutor` 子类），行为与之前完全一致；
  - 被占用时每 200ms 探测一次 `ctx.shell`（用非 strict `ctx.get('shell', false)` 能看见“仍挂载但正在被替换”的旧实现），旧 provider 卸载后自动挂载；5 秒后输出一条可操作 warning，但**不 throw**；
  - 轮询计时器挂在插件 fiber 的 `ctx.effect` 上，插件卸载即清理，避免 stale 回调在 bundle 卸载后再注册服务。
- 结果：热安装不再产生 duplicate-service 错误，也不会因竞态让 `bash` 永久不可用；若旧 provider 直到重启才释放，`bash` 工具会在重启后出现（旧 provider 与 `tool-pwsh` 的禁用不会让进程崩溃）。回归测试见 `tests/executor.test.mjs` 的两条 lifecycle 用例（占用时等待、占用时配置错误仍拒绝）。
- 与插件无关但同样属于“安装生命周期”的坑：pnpm 重算 profile 依赖树时，**不在 profile `package.json` 依赖里的手工插件会被移到 `node_modules/.ignored`**（例如 `sandbox-extra-roots` 的 `ERR_MODULE_NOT_FOUND` warning）。这类插件应以 `link:` 写进 profile 依赖；README §9.10 给出修复步骤。

## 8. `cordis.patch.yml`（生成物）结构

生成器 `scripts/gen-preset-patch.mjs` 由固定模板 + 仓库内 `presets/` 快照合成，输出固定头注释（含「目标 DSH 版本」行）。结构：

```yaml
# 目标 DSH 版本：0.2.2-rc.3；preset 快照来源：presets
# ---- host 层 ----
- id: pwsh-sandbox
  name: '@deepseek-ai/dsh-pwsh-sandbox'
  disabled: true
- id: tool-pwsh
  name: '@deepseek-ai/dsh-tool-pwsh'
  disabled: true
- id: tool-bash
  name: '@deepseek-ai/dsh-tool-bash'
  disabled: false                                # 常开；Web preset 的同名行在 agent scope 遮蔽
- insert:
    - id: dsh-vsshell
      name: '@dsh-external/dsh-vsshell'
      # Windows-only: POSIX 已由 shipped bash-sandbox 提供 ctx.shell，第二个 provider 会重复注册服务
      disabled: !!js "process.platform !== 'win32'"
      config: {}          # 用 schema 默认值；本机配置属于 profile patch，不进生成物
    - id: dsh-vsshell-panel
      name: '@dsh-external/dsh-vsshell/panel'
      # 配置面板 Host 半；仅 win32（POSIX 没有可配置的执行器）
      disabled: !!js "process.platform !== 'win32'"
      config: {}

# preset 覆盖（快照自 presets/{standard,ptc,cordis}.patch.yml，目标 DSH 0.2.2-rc.3）
- id: preset-standard
  name: '@deepseek-ai/dsh-agent-preset'
  config:
    id: standard
    order: 1
    plugins:
      - id: persona
        ...
      - id: tool-bash
        name: '@deepseek-ai/dsh-tool-bash'          # 去掉 win32 disabled
      - id: tool-pwsh
        name: '@deepseek-ai/dsh-tool-pwsh'
        disabled: true                               # 替代原 win32 条件
      ...
```

生成规则：

1. 读取 `--source`（默认仓库内 `presets/`；也可指向 DSH 源码检出，自动识别两种布局）下的 `{standard,ptc,cordis}.patch.yml`，取第一个 `insert[0].config`（`id`、`order`、`plugins`）。目标 DSH 版本取自快照的 `source.json.dshVersion`（检出模式取该检出 `package.json.version`）。
2. host 行固定为：`pwsh-sandbox`/`tool-pwsh` → `disabled: true`；`tool-bash` → `disabled: false`；insert 的两行（`dsh-vsshell` 执行器 + `dsh-vsshell/panel` 面板 Host 半）→ 都 `disabled: !!js "process.platform !== 'win32'"`（POSIX 由 shipped `bash-sandbox` 提供 `ctx.shell`，不能再挂第二个 provider；面板也没有可配置的执行器）且 `config: {}`。
3. 对 `plugins` 逐行处理：`id: tool-bash` 行删除 `disabled`；`id: tool-pwsh` 行改为 `disabled: true`；其余原样（保留 `cordis:group` 嵌套、`!!js` 表达式）。
4. 用 `yaml` 包解析（自定义 tag `!!js` 解析为 `JsExpression` 占位对象，绝不求值），自写最小 YAML 输出器（逐字保留 `!!js` 与块标量），输出 2 空格缩进、末尾换行。
5. `preset-minimal` **不覆盖**：它使用 persistent-shell（`@deepseek-ai/dsh-tool-bash-persistent` + PTY `terminal-bash`）这条不同 seam，v1 不支持，README 明确说明。
6. `--check` 模式：不写文件，只比较生成结果与现有文件，不一致时退出码 1（供 `pnpm run check` 用）。
7. **版本固定与快照保真**：`presets/` 是目标版本安装（`app.asar` 的 `dsh-web-app/presets`）的逐字快照，`source.json` 记录 `dshVersion`、来源与 `sha256`；生成器的 `verifySnapshotHashes()` 与测试会在快照内容与清单不一致时直接拒绝（改坏快照再 regen 不会静默通过）。生成物头部的版本行必须与快照版本、`package.json` devDependencies 的 `@deepseek-ai/dsh-bash-local` 三者一致，`check:patch` 强制断言；`peerDependencies` 用精确版本，避免其它 DSH 版本被静默放行。换版本只能整份替换快照并同步更新 `source.json`（含 sha256）与依赖版本。

## 9. 静态检查（本阶段）

| 命令 | 内容 |
|---|---|
| `pnpm run typecheck` | `tsc -p tsconfig.json --noEmit` |
| `pnpm run build` | `tsc -p tsconfig.json`（输出 lib/） |
| `pnpm run test` | `node scripts/test.mjs`：单进程 import `tests/*.test.mjs`（纯函数 + wire/execute 接线 + awaitTarget 超时/取消 + 热安装 lifecycle + patch/版本/sha256/peer 精确版本断言 + 面板引号/校验/假路由，不真的跑 bash；当前 52 个） |
| `pnpm run check:patch` | `node scripts/check-patch.mjs`：结构断言 + 目标版本断言（含 `peerPinProblems()` 的 peer 精确版本断言）+ 生成物逐字一致性（**自包含**，不需要外部 DSH 检出） |
| `pnpm run check` | `node scripts/check.mjs`：typecheck → build → `node --check` 产物 → 单测 → patch 校验 |
| `pnpm run smoke` | `node scripts/smoke-executor.mjs`：真机集成冒烟（**必须在非受限令牌下运行**，见下） |

说明：`node --test` 会为每个测试文件 spawn 子进程，而 DSH Windows 沙箱内子进程管道创建会 `EPERM`；因此测试统一由 `scripts/test.mjs` 在单进程内 import，`scripts/check.mjs` 也用直接子进程 + 继承 stdio。`.npmrc` 的 `node-linker=hoisted` 让本地 `node` 脚本能解析 `@deepseek-ai/*` 的传递依赖（pnpm 隔离布局的 junction 对 ESM 解析不可见）。本机 `pnpm install` 可能因 `ERR_PNPM_IGNORED_BUILDS`（subprocess-local/koffi/node-pty）以非零退出，但依赖已就绪，不影响 tsc 与单测。

冒烟脚本设计：用真实 `cordis` + `@deepseek-ai/dsh-subprocess-local` 起一个最小 app，加载本插件，执行 `echo hello` / `pwd` / 退出码 / 双流 / `DSH_*` / 超时 / 后台任务。注意：DSH 工具沙箱内的 pwsh 无法启动 bash（§2），冒烟需在 `danger-full-access` 权限下执行；它不安装任何东西，所以不属于「插入检查」。本阶段已执行：Git Bash 与 WSL 各 10 项全过（WSL 侧的 `DSH_PROBE` 经 `WSLENV` 进入 Linux 环境）。

## 10. 风险与已知限制

1. **preset 覆盖是快照，且版本固定**：`presets/` 是 0.2.2-rc.3 **安装**的逐字快照（minor 升级已换形状：delegation 用 tool-subagent-control + modelSelection/modelDiscovery，ptc 用 tool-executor-ptc，新增 tool-plugin-market/applyPatch）；DSH 升级后必须整份替换快照、更新 `source.json` 与依赖版本并重新 `gen:patch` + diff 审核。用其它版本或开发源码生成的 preset 会被 `check:patch` 的版本断言拒绝（源码检出形状可能不同，见 §2）。
2. **用户层 preset 编辑会覆盖本 bundle 的修正**：安装前在 Web 编辑器保存过 preset 时，profile 的 `cordis.patch.yml` 会有 `preset-*` 行按 id 整份覆盖 `config.plugins`（用户层最后生效），可能把 `tool-pwsh` 又开回来。排障：删掉 profile 里的这些 preset 行，或安装后重新保存 preset。README §9 给出步骤。
3. **host `tool-bash` 常开依赖 scope 遮蔽语义**：tools 注册表只在同一 scope 内拒绝重名，agent-scope 的 preset `bash` 遮蔽 host 层同名行；此结论来自对 DSH tools registry 源码的核对，需在插入检查时确认模型目录里只有一个 `bash`。
4. **用户自定义 preset 不覆盖**：`.agent-presets/` 下用户自建 preset（例如 router-standard）不在覆盖范围；这些 preset 若自带 shell 机制由用户自行处理。
5. **`minimal` preset 不支持**：它走 persistent PTY shell，本插件不接管。
6. **沙箱弱化**：bash 不受 harness 文件沙箱限制（已确认接受）；文件工具仍受约束；prompt 如实披露。`sandboxMode` 声明的是部署默认 FILE 策略（`permission-presets` 组合所需），不是执行约束——`sandbox_permissions` 会被工具广告但传入策略被丢弃，prompt 与 README 明确写出该参数对 bash 无效。
7. **Cygwin login profile 会 `cd $HOME`**：已用 `CHERE_INVOKING=1` 保住 `workdir`，但这依赖 Cygwin 的标准 `/etc/profile` 约定；使用自定义 profile 且忽略该变量时可能仍会丢 cwd（可用 `loginShell: false` 规避）。
8. **WSL 环境转发是白名单**：仅 `DSH_*`、调用方 env、终端覆盖变量与既有 `WSLENV` 条目；其余 Windows 环境变量不会进入 WSL。
9. **`wsl.exe` 代理横幅**：用户机若有 localhost 代理，命令 stderr 每次多一行 `wsl:` 警告；不属命令错误。
10. **`loginShell: true` 会执行用户 profile**：可能带来启动脚本副作用/更慢冷启动，可配置为 false。
11. DSH 升级可能改变 `LocalBashExecutor` 的 internals（`protected executeArgv` / `resolve`）；`pnpm run typecheck` 会首当其冲报错，升级时先跑检查。
12. **配置面板是运行配置的写入口**：保存会经 `configEditor` 触发 Loader 热协调（执行器行重载），因此面板 Host 半必须是**独立行**（`dsh-vsshell-panel`），执行器解析失败或重载时面板仍可用；若 DSH 未来改动 `configEditor`/`webServer` 服务签名，面板会先失效（执行器不受影响）。同源路由 + 页面 token 只防浏览器跨站，不防本机同用户进程；不要把它暴露到非环回监听地址（README §8.1）。
13. **从 GitHub 安装/热安装时旧 provider 仍占用 `ctx.shell`**：`install_bundle` 不重启进程，bundle patch 禁用 `pwsh-sandbox` 与新 executor 挂载之间没有“旧 provider 已卸载”的顺序保证；旧实现会在同一 context 二次注册 `shell` 并抛错，导致 patch 已禁用 pwsh 而新执行器没挂上 → 无 shell 工具。0.3.2 起由 wrapper 等待旧 provider 卸载后自动挂载（见 §7.6），失败时只 warn 不 throw；极端情况下仍需重启。
14. **从 URL/GitHub 安装会重算 profile 依赖树**：不在 profile `package.json` 里的手工插件会被 pnpm 移入 `node_modules/.ignored`（`ERR_MODULE_NOT_FOUND` warning）。这是 profile 安装方式的约束，不是本插件代码可修复的；README §9.10 建议把这类插件写成 `link:` 依赖。
15. **网页端面板未在本机做浏览器内验证**：交付验证到「route 单元测试 + client.js 语法 + 生成物/元数据静态检查」；实际渲染与点击保存需安装/重启后在 Web 设置页确认（见 §11）。

## 11. 阶段计划与状态

1. **规划**（本文件）→ 分配 README、AGENTS 编写任务。[完成]
2. **编码**：`src/detect.ts`、`src/index.ts`、`package.json`、`tsconfig.json`、生成器与结构校验。[完成]
3. **静态检查**：typecheck/build/test/check:patch，修到全绿。[完成：`node scripts/check.mjs` → 50/50 单测 + 结构/目标版本/生成物一致性，PASS]
4. **本地集成冒烟**（`danger-full-access`，不安装）：[完成] Git Bash 与 WSL 两条路径各 10 项检查全过（echo / pwd=cwd 翻译 / 退出码 42 / stdout+stderr 分流 / `DSH_*` 经 `WSLENV` 进入 WSL / `sleep 5` 超时分类 / 后台任务）。
5. **独立复核**（verifier teammate）：[完成两轮] 第一轮发现：① preset 快照版本错配（当时误用开发源码检出的形状 → 改用目标版本**安装**快照 + 版本断言）；② host `tool-bash` 的 `!!js` 门控失效（改为常开 + scope 遮蔽）；③ 若干 minor。第二轮确认修复成立，并建议：peer 用**精确版本**（防后续版本静默放行）、快照 sha256 机器校验、WSL prompt 去重、`awaitTarget` 回归测试、文档措辞修正——均已落地。
6. **插入检查（desktop profile）**：[完成] 已安装 bundle 并在 profile 用户层显式配置 `source: custom` + 一个 Cygwin bash 路径。过程中发现并修复：① `permission-presets` 拒绝 `sandboxMode === undefined` 的 shell 执行器（安装结果 `application: failed`）→ 执行器改为镜像 `ctx.sandboxPolicy.defaultMode` 并明确「只声明组合事实、不 confine」；② `pnpm add` 会把不在依赖树里的用户插件剪进 `.ignored` → 重新安装时需把它们移回 profile 的 `node_modules/@dsh-external/`；③ Cygwin login profile 会 `cd $HOME` 破坏 `workdir` → native bash 统一导出 `CHERE_INVOKING=1`（真实 `bash -lc` 与工具调用均验证 cwd 保持）。
   重启后实测：工具目录只有 `bash`（无 `pwsh`）、preset 覆盖未丢行、host 层 `permissionPresets` 等行均为 live；`bash` 工具的 `pwd` 落在仓库目录（workdir 生效）、退出码、stdout/stderr 分流、前台超时转后台任务、后台任务回收均正常；`scripts/smoke-executor.mjs` 以 `VSSHELL_SOURCE=custom` + Cygwin 路径跑出 10/10 PASS。未实测项：ptc preset 的 PTC 呈现（静态断言已覆盖，需单独用 ptc 会话复核）、`read-only` 模式的 permission 预设（基表未配置）。
7. **双模型审查后跟进（两个外部审查模型）**：[完成] 采纳「接受现状 + 强化披露」方案：prompt 明确写 `sandbox_permissions` / `justification` 对 bash 无效，README 顶部加醒目安全提醒并在 §8.1/§8.3 重复；同时修复 3 个 minor（`/c`、`/c/` 盘符根翻译 + 单测、`check:patch` 的 `peerDependencies` 精确版本断言 `peerPinProblems()` + 测试、design 文档漂移与序号）。另补「失败可读性」：`execute()` 在 spawn 前校验 `workdir`，错误写明来源/家族/exe 与可接受 POSIX 前缀，避免裸 `ENOENT`；prompt 增加 Failure hints。**明确不在本期提供更可靠的沙箱管理**（`ctx.sandbox.confine` 的 Windows runner 无法启动 MSYS/WSL；替代方案见审查记录，暂不实施）。
8. **升级 DSH 0.2.1-rc.3**：[完成] 升级后桌面端工具回退为 `pwsh`，原因是 bundle 的 peer 精确固定 rc.2 被 rc.3 运行时兼容检查拒绝。处理：从 rc.3 安装的 `app.asar` 提取 shipped preset（**与 rc.2 逐字节相同**，sha256 不变）→ `source.json` 仅更新 `dshVersion`/`origin` → `package.json` 的 dev/peer 依赖全部精确改 rc.3（cordis 仍 4.0.5、schemastery 3.18.5）→ `pnpm install`（rc.3 包，`ERR_PNPM_IGNORED_BUILDS` 仍属已知现象）→ `gen:patch`（生成物仅版本行变化）→ `node scripts/check.mjs` 全绿 → rc.3 依赖下 `smoke` 以 custom/Cygwin 10/10 PASS。源码层面 rc.3 的 `permission-presets` 仍要求 `sandboxMode` 非空、`tool-bash` seam 未变，因此 `src/` 无需改动。
9. **可视化配置面板**：[完成代码/静态验证，待重启后 UI 验证] Host 半 `src/panel.ts`（`/dsh-vsshell-panel` 同源 JSON 路由 + 引号归一化 + `configEditor` 写入）与 browser 半 `client.js`（`settings.section` 页面）已加入；插件版本 0.2.0，bundle insert 增加 `dsh-vsshell-panel` 行；`tests/panel.test.mjs` 覆盖引号/裸值归一化、校验、GET/POST/token/跨站拒绝；`check` 50/50 PASS。**未验证**：Web 页面里的实际渲染、保存后的热协调与重启后工具切换，等重启后确认（README 4.4 是验收清单）。
10. **升级 DSH 0.2.1-rc.5**：[完成代码/静态验证，待重启] 与 rc.3 升级同因：peer 精确固定 rc.3 被 rc.5 运行时兼容检查拒绝（工具回退 `pwsh`）。rc.5 安装的 shipped preset 仍与 rc.2/rc.3 逐字节相同（三份 sha256 不变）→ `source.json` 只改 `dshVersion`/`origin`/`extractedAt`；`package.json` 的 dev/peer 精确改 rc.5（cordis 仍 4.0.5、schemastery 3.18.5），插件版本升至 0.2.1；`pnpm install` 后 typecheck 直接通过；`gen:patch` 只改版本行；`check` 50/50 PASS；rc.5 依赖下 smoke custom/Cygwin 10/10 PASS。核对 rc.5 接口：`permission-presets` 仍要求 `sandboxMode` 非空、`tool-bash` sandboxPolicy seam 未变、`configEditor.edit`/`webServer.register` 未变 → `src/`、`client.js` 无需改动。
11. **升级 DSH 0.2.2-rc.1（minor）**：[完成代码/静态验证，待重启] 这次不是只改版本号：**shipped preset 形状变了**（`tool-subagent-list-agents` 并入 `tool-subagent-control`、`modelSelectionSettings` → `modelSelection`/`modelDiscovery`、ptc 改用 `tool-executor-ptc` 且去掉 `tool-presentation`、新增 `tool-plugin-market` 与 `tool-fs.applyPatch`、standard 的 `tool-plugin-manager` 也改走 `!!js`），且 **cordis 4.0.5 → 4.1.0**、schemastery 3.18.5 → 3.19.0。处理：从 0.2.2-rc.1 安装的 `app.asar` 提取三份 preset 整份替换快照（sha256 全变），`source.json` 更新版本/来源/哈希；`package.json` 的 DSH dev/peer 精确改 `0.2.2-rc.1`、cordis `4.1.0`、schemastery dev `3.19.0`/peer `^3.19.0`，插件版本 `0.3.0`；`pnpm install` 后 typecheck 直接通过；重写 `tests/patch.test.mjs` 的版本指纹；`gen:patch` 生成新生成物；`check` 50/50 PASS；依赖下 smoke custom/Cygwin 10/10 PASS。**客户端契约也变了**：`settings.section` 注册只接受 `id`/`order`/`label`，`client.js` 改为闭包传 `t`/`ctx` + `ctx.locale.subscribe()` 重渲染；`permission-presets`/`tool-bash`/`configEditor`/`webServer` 的服务 seam 未变。
12. **升级 DSH 0.2.2-rc.3（patch 版本也会改 preset）**：[完成代码/静态验证] rc.3 相对 rc.1 改动：standard/ptc 新增 `tool-office` 行、standard 的 `skill-filesystem` 增加 `customSkillDirs`、delegation 的 `tool-subagent-control` 增加 `interrupt: false`、cordis persona 文本更新。处理：整份替换三份快照（sha256 全变）、更新 `source.json`、DSH dev/peer 精确改 `0.2.2-rc.3`、插件版本 `0.3.1`；typecheck 通过；`gen:patch` 由 420 行变为 433 行；`check` 50/50 PASS；rc.3 依赖下 smoke custom/Cygwin 10/10 PASS。**结论**：patch 版本也可能改 preset 形状，升级必须逐次提取安装快照并跑 diff。
13. **修复热安装生命周期（duplicate `ctx.shell`）**：[完成] 用户从 GitHub URL 安装时，热安装让旧 `pwsh-sandbox` 仍占着 `ctx.shell`，而 bundle patch 已禁用 `tool-pwsh`，旧实现直接注册第二个 `shell` 服务导致激活失败、无任何 shell 工具。修复：默认导出改为延迟挂载 wrapper，等待旧 provider 释放后自动挂载（200ms 轮询、5s 后 warn、不 throw），保留 load-time 配置校验；`tests/executor.test.mjs` 增加两条 lifecycle 回归；插件版本 `0.3.2`，README §3.2/§9.10 与 AGENTS §4.14/§7 同步。`check` 52/52 PASS。
