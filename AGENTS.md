# AGENTS.md — 本仓库的开发约定

写给**在本仓库改代码的 agent（或人）**。使用者文档见 [README.md](README.md)，设计与规划的事实来源见
[docs/design.md](docs/design.md)。改行为之前先读 design.md，改完同步更新它（若代码与 design.md 冲突，以代码为准，
并先修正 design.md）。

文档用中文；代码注释与标识符用英文。

---

## 1. 这个仓库是干什么的（一句话架构）

本包是 DSH 的 **host 插件**，注册 `ctx.shell`（一个可配置的 bash 执行器），替代 win32 上默认的 pwsh，
并让内置 `tool-bash` 真正可用。**目标 DSH 版本精确固定为 `0.2.2-rc.5`**（见 §4.8）。

实现方式：继承 `@deepseek-ai/dsh-bash-local` 的 `LocalBashExecutor`，**只覆盖 `resolve()` 与 `execute()`**
（外加一次 bash 目标解析与一条 system-prompt section）。子进程生命周期、超时/取消、输出收集与 spill、
后台任务语义**全部继承父类**，本仓库不重复实现。

`cordis.patch.yml` 是 bundle patch，做五件事：host 层禁用 `pwsh-sandbox` / `tool-pwsh`、host `tool-bash` 常开、
插入本插件两行（执行器 `dsh-vsshell` + 配置面板 Host 半 `dsh-vsshell/panel`，均**仅 win32**）、
整份覆盖 shipped preset 的 `config.plugins`（启用 `tool-bash`、禁用 `tool-pwsh`）；browser half 由
`package.json` 的 `dsh.client` 从 `client.js` 加载，向设置页注册一个配置 section。

```
host 层（全局 scope）
  dsh-vsshell       → ctx.shell = VsshellBashExecutor（仅 win32：disabled: process.platform !== 'win32'）
  dsh-vsshell/panel → /dsh-vsshell-panel 同源 JSON 路由；经 configEditor 读写 profile 用户层（仅 win32）
  tool-bash         → 常开（disabled: false）；消费 ctx.shell 提供 bash 工具
  pwsh-sandbox      → 禁用
  tool-pwsh     → 禁用
preset 层（standard / ptc / cordis；agent scope）
  config.plugins 整份覆盖：tool-bash 启用、tool-pwsh 禁用
  同名 tool-bash 行在 agent scope 遮蔽 host 行；只有同一 scope 内重名才报错
```

插件初始化的几个固定事实（改之前先读 `src/index.ts`）：

- `static inject = ['subprocess', 'systemPrompt', 'sandboxPolicy']`；
- **默认导出是延迟挂载 wrapper**（`VsshellBashExecutor`）：`ctx.shell` 空闲时立即构造 `VsshellService`，被旧 provider 占用时等待其卸载后挂载（见 4.14、design.md §7.6）；
- 构造时启动一次后台解析（不阻塞 host 启动），供 prompt section 尽早说出真实 shell；
- `sandboxMode` getter 镜像 `ctx.sandboxPolicy.defaultMode`（构造时捕获）：这是 DSH `permission-presets` 的组合前提（它拒绝 `sandboxMode === undefined` 的 shell 执行器，并把该值当会话默认 sandbox 模式），**不代表本执行器 confine**；
- native bash（Git Bash/Cygwin/自定义）启动时导出 `CHERE_INVOKING=1`：Cygwin 的 `/etc/profile` 否则会把 login shell `cd` 到 `$HOME`，破坏 `workdir`；WSL 启动不带它；
- `execute()` 通过 `awaitTarget(spec)` 等目标：**等待受本次调用的 `signal` 与前台 `timeoutMs` 约束**
  （超时/取消都会终止等待并给出可用错误），不会让一次慢探测越过调用方的超时；
- prompt section：`name: 'shell:vsshell'`，`order = getSectionOrder('TOOL_BASH') + 1`，`text` 是快照函数，
  就绪后输出一行 `Shell:`（来源/家族 + **真实调用形态**，含 WSL 的 `-d <distro> --exec bash`）加短路径提示、`DSH_*` 与沙箱事实（最小化原则见 4.12）；
- `resolve()` 显式把 `sandboxPolicy` 置 `undefined`（丢弃调用方策略，而不是假装执行它）；
- `wslDistro` 对任何最终走 WSL launcher 的解析都生效（含 `source: auto` 回退到 WSL 的情况）。

---

## 2. 目录职责

| 路径 | 职责 | 能否手改 |
|---|---|---|
| `src/index.ts` | 插件入口：`Config` schema、`VsshellBashExecutor`（延迟挂载 wrapper）、`VsshellService`（`resolve` / `execute` / `awaitTarget` / `describeResolved`）、prompt section | 可改（遵守 §4） |
| `src/panel.ts` | 配置面板 Host 半：`/dsh-vsshell-panel` 同源 JSON 路由、引号归一化与校验、经 `configEditor` 写回 profile | 可改（遵守 §4） |
| `client.js` | 配置面板 browser half（Module Loader 懒工厂、无构建）：注册 `settings.section`，fetch 上面的路由 | 可改（遵守 §4） |
| `locale/en.json`、`locale/zh.json`、`icon.svg` | 插件在 Plugin Manager / 设置里的标题、描述与图标 | 可改 |
| `src/detect.ts` | 纯函数层：候选路径、探测 argv、探测结果解析、目标解析、argv 构造、workdir 翻译、WSL 环境转发、真实 probe 实现 | 可改（遵守 §6） |
| `presets/standard.patch.yml`、`ptc.patch.yml`、`cordis.patch.yml` | **目标版 DSH 的 shipped preset 原文快照**：`gen:patch` 的默认输入 | **禁止改内容**，只在升级时整份替换（§5、§8） |
| `presets/source.json` | 快照清单：`dshVersion` / `origin` / `extractedAt` / `files` / `sha256` / `notes` | 升级时更新版本、来源与**三份文件的 sha256**（§8） |
| `scripts/gen-preset-patch.mjs` | 从 `presets/` 快照（或 `--source` 指定的 DSH 源码检出）生成 `cordis.patch.yml`（`gen:patch`） | 可改 |
| `scripts/check-patch.mjs` | 三段校验：结构 + 目标版本 + 生成物一致性（`check:patch`，自包含） | 可改，但不要为变绿而放松断言 |
| `scripts/check.mjs` | `check` 的编排：typecheck → build → 产物语法 → 单测 → patch 校验 | 可改 |
| `scripts/test.mjs` | 在一个进程内 import 所有 `tests/*.test.mjs`（见 §7 原因） | 可改 |
| `scripts/smoke-executor.mjs` | 真机冒烟：唯一真正启动 bash 的脚本 | 可改 |
| `tests/detect.test.mjs` | detect 纯函数单测（`node:test`，注入假 exists/probe） | 可改 |
| `tests/executor.test.mjs` | 执行器接线单测：裸 cordis Context + 假 `systemPrompt`；假 `subprocess` 既用于"禁止 spawn"断言，也用于捕获 `execute()` 交给底层的 argv/env | 可改 |
| `tests/patch.test.mjs` | `cordis.patch.yml` 结构 + 目标版本 + 目标版本指纹（当前 0.2.2-rc.5 安装形状）+ 生成物一致性（自包含，不写文件、不起 shell） | 可改，但不要为变绿而放松断言 |
| `cordis.patch.yml` | **生成物**：host 行 + preset 覆盖，头注释含目标 DSH 版本 | **禁止手改**（§5） |
| `lib/` | **构建产物**（`tsc` 输出 `index.js` / `detect.js` / `.d.ts`） | 不手改；随仓库提交（§8） |
| `docs/design.md` | 设计规划与约束，README / AGENTS / 代码的共同事实来源 | 改行为时同步更新 |
| `scratch/` | 真机探测脚本，不发布 | 可改，不要进构建产物 |

---

## 3. 命令

| 命令 | 实际执行 | 何时跑 |
|---|---|---|
| `pnpm install` | 装依赖到本仓库 `node_modules/`（已 gitignore） | 首次检出、依赖变更后 |
| `pnpm run build` | `tsc -p tsconfig.json` → `lib/` | 改了 `src/` 之后（测试与安装都读 `lib/`） |
| `pnpm run typecheck` | `tsc -p tsconfig.json --noEmit` | 每次改代码 |
| `pnpm run test` | `node scripts/test.mjs`（单进程 import `tests/*.test.mjs`，不启动任何真实进程） | 每次改代码（**先 build**） |
| `pnpm run check:patch` | `node scripts/check-patch.mjs [--file <patch.yml>] [--source <preset 快照目录或 DSH 检出>]`：三段 PASS | 改生成器 / 改快照 / 改版本后 |
| `pnpm run check` | `node scripts/check.mjs`：typecheck → build → `node --check` 产物 → 单测 → patch 校验 | **提交前必跑，必须全绿** |
| `pnpm run gen:patch` | `node scripts/gen-preset-patch.mjs`，默认 `--source=presets/`（仓库内快照）；也可 `--source <DSH 源码检出>`、`--out <file>`、`--check`（只比较不写，不一致退出码 1） | 改生成逻辑 / 升级 DSH 后（§8） |
| `pnpm run smoke` | `node scripts/smoke-executor.mjs`：起最小 cordis app，跑 echo/pwd/退出码/双流/`DSH_*`/超时/后台 | 改动执行路径后，**非受限令牌下** |

脚本名与实际行为一律以 `package.json` 的 `scripts` 为准；本表与之冲突时改本表。

`client.js` 是浏览器的 Module Loader 懒工厂（无构建），`scripts/check.mjs` 只做 `node --check client.js` 语法检查；它依赖的运行时 React/`window.__ModuleLoader__` 只在 DSH Web 页面里存在，不要在本机 Node 里 import 它。

关于本地环境：

- **Node**：`>=22`（`src/index.ts` 使用 `Promise.withResolvers`；以 `package.json` 的 `engines` 为准）。
- **pnpm**：系统 PATH 上没有时用 harness 自带的 pnpm —— `node <pnpm.mjs 绝对路径> install`（路径可由
  `load_workspace_dependencies` 查到）。**不要**为了跑构建去安装全局 pnpm 或改全局环境。
- **`.npmrc` 固定 `node-linker=hoisted`**：立着装的 `node_modules` 让本地直接 `node` 跑的脚本能解析
  `@deepseek-ai/*` 及其传递依赖；pnpm 的隔离布局会让 Node 的 ESM 解析走不过 junction。**不要**删这条。
- **`pnpm run test` 先 `build`**：`detect.test.mjs` / `executor.test.mjs` import 的是 `../lib/*.js`，不是
  `src/*.ts`（`patch.test.mjs` 例外，它 import 生成器/校验脚本）；先跑 `pnpm run check`
  （内部已按 typecheck → build → test 排序）最省事。
- **`check` / `check:patch` / `test` 都是自包含的**：`presets/` 快照在仓库里，**不需要**兄弟目录
  `../deepseek-harness` 也能全绿（`--source` 只在升级或临时比对时才指向外部检出）。
- **`pnpm install` 以 `ERR_PNPM_IGNORED_BUILDS` 非零退出是已知现象**，不代表依赖没装好：pnpm 会拦下
  `dsh-subprocess-local` / `koffi` / `node-pty` 等包的 build script。三个事实：依赖装好了、`tsc` 与单测
  照常跑、`pnpm run check` 全绿。**不要**因此去 `pnpm approve-builds`、删 `node_modules` 或重装；只有
  `pnpm run smoke` 确实报原生绑定缺失时才回来处理（那时改的是本机环境，不是仓库）。
- **`pnpm run smoke` 必须在非受限令牌（`danger-full-access`）下运行**。原因（已实测）：DSH 的 Windows ACL
  沙箱用受限令牌，其内 Git Bash 启动即报 `couldn't create signal pipe, Win32 error 5`，WSL 报
  `Wsl/E_ACCESSDENIED`；两者都无法在受限令牌内启动。所以在工具沙箱里跑 smoke 失败**不是**代码回归。
- `scripts/test.mjs` 之所以在一个进程里 import、而不是 `node --test` 逐文件跑：逐文件会为每个文件开子进程，
  而 DSH 沙箱内子进程管道创建会 `EPERM`。同理 `scripts/check.mjs` 用直接子进程 + 继承 stdio，不套 shell。
- `presets/` 是**生成输入**而非运行时资产，但它随 `package.json` 的 `files` 一起发布：这样无论是
  `link:` 目录还是打包后的安装副本，都能用同一份快照复现 `gen:patch` / `check:patch`。运行时插件本身
  不读 `presets/`（只读 `cordis.patch.yml` 与 `lib/`）。

---

## 4. 硬性不变量（违反即回退）

| # | 不变量 | 为什么 |
|---|---|---|
| 4.1 | `sandboxMode` getter **必须**返回 `ctx.sandboxPolicy.defaultMode`（构造时捕获），不要改回 `undefined`，也不要硬编码 | `permission-presets` 在 `sandboxMode === undefined` 时拒绝激活（Web 权限预设切换/投影失效，安装结果为 `application: failed`）；该值是部署默认 FILE 策略，不是 bash 的约束能力，因此必须同时保留 prompt/README 的「bash 不设限」披露 |
| 4.2 | 不复制 `bash-local` 的执行循环 | 父类 `executeArgv()` 已覆盖生命周期/env/输出/截止/取消；复制会与上游漂移，升级时先烂在这里 |
| 4.3 | 预算字段与上游 schema 逐字段同步 | 见下表；上游变了而这里没跟，配置会静默错位 |
| 4.4 | 不修改命令输出：禁止过滤/包装 stderr，禁止重写 stdout 文本 | 输出是命令的真实结果。典型例子：`wsl.exe` 在 localhost 代理环境下会打一行警告到 stderr —— 属已知现象，照样透传 |
| 4.5 | 不伪造 sandbox **执行**能力：`resolve()` 把 `sandboxPolicy` 置 `undefined`；结果不带 `sandbox` facts；prompt section 必须保留「does NOT confine」，并**明确写出 `sandbox_permissions` / `justification` 对 bash 无效**；README 必须有醒目安全提醒。4.1 的声明是组合事实，不是执行承诺 | 沙箱确实没做（用户已确认接受该弱化）。只声明组合所需的部署默认模式可以，但不得让工具结果/文档暗示命令被约束 |
| 4.6 | 解析失败不阻塞 host 启动，也不静默降级到 pwsh | 失败要进 prompt section 与工具调用错误（含候选与原因），让用户能自己修环境 |
| 4.7 | 生成物插入的 `dsh-vsshell` 与 `dsh-vsshell-panel` 两行都必须 `disabled: !!js "process.platform !== 'win32'"` | POSIX 上 shipped `bash-sandbox` 已提供 `ctx.shell`，再挂一个 provider 就是重复服务注册；面板也没有可配置的执行器 |
| 4.8 | **目标版本固定**：`presets/source.json` 的 `dshVersion` 必须等于 `package.json` 的 `devDependencies["@deepseek-ai/dsh-bash-local"]`（比较时剥掉 `~`/`^`），也必须等于生成物头部的 `# 目标 DSH 版本：<X>；`。`peerDependencies` 里的 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 也用**精确版本**（不是 `~`/`^`），让 DSH 的兼容性检查在其它版本上**拒绝**本插件；`check:patch` 的 `peerPinProblems()` 会机器断言这一点（范围或版本不一致直接 fail）。`check` 的版本断言**不得放宽或删除** | 三处版本一旦不一致，说明 patch 由别的 DSH 版本（或开发源码检出）生成，装上去会静默丢行/多行。**0.2.2 系列改过两次 preset 形状**：rc.1 是 minor 变更（list-agents 并入 tool-subagent-control、modelSelection/modelDiscovery、ptc 改用 tool-executor-ptc、plugin-market 等），rc.3 又新增 tool-office（standard/ptc）、standard 的 skill-filesystem customSkillDirs、tool-subagent-control 的 `interrupt: false` 与 cordis persona 文本；两次都已整份替换快照并同步 sha256 与指纹。**不要假设 patch 版本快照不变**；开发源码检出的 preset 形状也可能不同，不能当安装快照。peer 用范围会让后续版本静默放行（例如 `~0.2.1-rc.2` 对 `0.2.1-rc.5`/`0.2.2-rc.5` 也 satisfies，导致升级后 bundle 未被兼容检查放行、工具回退到 pwsh） |
| 4.9 | **host `tool-bash` 行常开**（`disabled: false`），不要改回 `!!js` 门控 | 曾用 `!!js "!!ctx.get('agentPresets')"` 做"仅 CLI 启用"，但 Loader 在同层服务 active 前求值该表达式，结果恒 `false` → 门控形同虚设（Web 上 host `tool-bash` 也会启用）；且 Web/preset 组合里 preset 的 agent-scope 同名行会遮蔽 host 行，**同 scope 重名才报错**，所以常开是安全且诚实的 |
| 4.10 | 等待目标解析必须受本次调用约束（`awaitTarget(spec)`：`signal` + 前台 `timeoutMs`） | 只 `await` 后台 Promise 会让一次冷启动/WSL 慢探测无视调用方的超时与取消；这条曾修过一次，别退回去 |
| 4.11 | `execute()` 必须先校验 `workdir` 存在（`assertWorkdir`），错误要写明来源/家族/exe 与可接受的 POSIX 前缀；不要让 `spawn ... ENOENT` 裸奔 | 模型分不清 `ENOENT` 是 bash 缺失还是工作目录写错，就无法自行纠正；失败原因必须可读 |
| 4.12 | **prompt section 最小化**：只放每次调用都需要的差异事实（Shell/invocation、路径提示、`DSH_*`、沙箱事实），**不要重复** tool-bash 原生 description 的内容（fresh shell、用 `workdir` 代替 `cd`）；失败细节只进错误消息；长度上限由 executor 单测断言（ready 状态 ≤ 600 字符） | 该 section 会进入每一轮 system prompt，冗余即持续的上下文负担；失败信息只在真失败时消耗 token 才符合最小原则 |
| 4.13 | **配置面板只经 `configEditor` 写 profile 用户层**，不要手写 YAML；路由仅同源（`Origin` 校验 + 页面 token，POST 需要 `x-dsh-vsshell-token`）；输入先做引号归一化（单/双/裸值等价，数字/布尔允许带引号字符串）；只改 6 个自定义字段，不动预算键；browser half 保持无构建的 Module Loader 工厂。0.2.2-rc.5 的 `settings.section` 注册契约只含 `id`/`order`/`label`：组件通过 factory 闭包拿 `t`/`ctx`，并用 `ctx.locale.subscribe()` 触发本地化重渲染，不要再传 `locale`/`inject` 注册选项 | 面板是用户直接改运行配置的入口：手写 YAML 会破坏注释/顺序；不校验来源就是任意本地页面可改 shell 路径；引号差异是用户从 patch 复制值时最常见的输入形态；slot 契约变化会让旧注册选项失效 |
| 4.14 | **默认导出必须是延迟挂载 wrapper**：`VsshellBashExecutor` 只做 config 校验 + 在 `ctx.shell` 空闲时构造 `VsshellService`；被占用时用 200ms 轮询等待旧 provider 卸载（5s 后 warn 一次），**禁止把 `Service` 子类直接作为默认导出**，也禁止在等待路径里 throw | `plugin_manager install_bundle` 是热安装：新 bundle 叠加时旧 `pwsh-sandbox` 的 `SandboxPwshExecutor` 可能仍占着 `ctx.shell`；Cordis 同一 context 只允许一个 `shell` 服务，直接注册会抛 `service "shell" has been registered`，导致整个 executor 激活失败、连 `pwsh` 也已被 patch 禁用 → 没有任何 shell 工具。回归测试见 `tests/executor.test.mjs` 的 lifecycle 两条用例 |

### 4.3 配置字段同步清单

`src/index.ts` 的 `static Config` 把 `LocalBashExecutor.Config` 的字段**原样复制**；字段与默认值必须与上游一致：

| 字段 | 上游默认 | 含义 |
|---|---|---|
| `cwd` | 无默认（`process.cwd()`） | 命令默认工作目录 |
| `timeoutMs` | `120000` | 前台默认超时 |
| `maxTimeoutMs` | `600000` | 单次调用超时上限 |
| `maxOutputBytes` | `64000` | 每流内存输出上限，溢出落 spill 文件 |
| `maxSpillBytes` | `64 MiB` | spill 文件上限 |
| `graceMs` | `3000` | SIGTERM→SIGKILL 宽限，且不得超过 `MAX_TIMER_DELAY_MS` |

上游文件：`<dsh-source>/packages/shell/bash-local/src/index.ts`（`static Config` 与 `assertServiceableBashConfig`）。取值可用性校验由父类在 `resolve()` 里做，
**不要**在子类里重写一遍校验逻辑 —— 重写必然与上游漂移。`Config` 接口用 `extends LocalBashConfig`
（类型层面），schema 用逐字段复制（运行时层面），两边都要跟。

本插件自己新增的字段只有六个：`source` / `bashPath` / `wslDistro` / `loginShell` / `verify` / `probeTimeoutMs`
（默认见 `src/index.ts`）。它们不属于上游，改这里不用回头改上游，但要同步 design.md §5。

`verify`（默认 `true`）的语义要记准：`true` 表示解析时**探测**每个候选（确认能启动、从 `$OSTYPE` 识别家族、
失败时给出可用错误）；`false` 表示**信任**第一个存在的路径、显式 `bashPath` 完全不校验，跳过探测延迟。
`false` 时 target 的 `family` 是 `'unknown'`，prompt section 会明说"未探测、家族与路径语法未验证"，
不会伪造家族信息。`ResolveOptions.verify` 由 `src/detect.ts` 的 `resolveBashTarget()` 消费，
单测靠它做到零探测（见 §7）。`wslDistro` 不是只对 `source: wsl` 生效：`auto` 最终落到 WSL launcher 时同样使用。

---

## 5. 生成物纪律（`cordis.patch.yml`）

1. `cordis.patch.yml` **只能**由 `scripts/gen-preset-patch.mjs` 生成，**禁止手改**。手改会在下次生成时被覆盖，
   或先被 `check:patch` 判为不一致。
2. **输入默认是仓库内的 `presets/` 快照**（`--source=presets`）。只有升级或临时比对时才把 `--source` 指向
   新版 DSH 源码检出；那种情况下**必须同时整份替换 `presets/` 并更新 `source.json`**，否则版本断言必红。
   改了生成逻辑或换了快照 → 重跑 `pnpm run gen:patch`，把生成物一起提交，并在提交说明里写"重新生成 + diff 审阅结论"。
3. `pnpm run check:patch` **三段**，缺一不可：
   - `patch structure`：host 行（`pwsh-sandbox`/`tool-pwsh` 禁用、`tool-bash` 常开）、`insert` 恰好两行
     （`dsh-vsshell` 执行器 + `dsh-vsshell/panel` 面板 Host 半，均 `config: {}`、win32-only）、standard/ptc/cordis 覆盖（tool-bash 启用、tool-pwsh 禁用）、
     且**没有** `preset-minimal` 行；
   - `target version`：生成物头部版本 = `presets/source.json.dshVersion` =
     `package.json.devDependencies["@deepseek-ai/dsh-bash-local"]`（剥 `~`/`^`）；
     同时 `peerPinProblems()` 断言 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis` 的 peer 是**精确版本**
     且等于对应 devDependency 值（范围、缺失或不一致都 fail）；
   - `generated`：与 `gen:patch` 从当前快照的渲染结果**逐字**一致。
   **不要**为了让检查变绿去放松或绕过任何一个断言 —— 那是把唯一的防线拆了。
4. 生成物的固定形状（改生成器时保持）：
   - 固定中文头注释（写明"生成物，禁止手改"、重新生成与校验命令），并必含一行
     `# 目标 DSH 版本：<version>；preset 快照来源：<presets 或 checkout 路径>`；
   - host 行：`pwsh-sandbox` / `tool-pwsh` → `disabled: true`；`tool-bash` → `disabled: false`（常开，理由见 4.9）；
   - `insert` 两行：`dsh-vsshell`（执行器）与 `dsh-vsshell/panel`（面板 Host 半），都
     `disabled: !!js "process.platform !== 'win32'"`、`config: {}`（**用 schema 默认值**，不要把本机配置写进生成物）；
   - 随后按 `standard` / `ptc` / `cordis` 顺序整份覆盖 preset；`!!js` 表达式与多行块标量逐字保留。
5. `presets/` 的快照纪律：
   - 三份 YAML 必须**逐字**取自目标版本安装（`resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/*.patch.yml`），
     **禁止手改内容**（改了就等于伪造目标版本的 preset 形状）；
   - `source.json.sha256` 记录三份文件的 SHA-256，`gen:patch` 与 `tests/patch.test.mjs` 会逐字节校验：
     快照内容与清单不一致时生成器直接拒绝（`verifySnapshotHashes`），改坏快照再 regen 也不会静默通过；
   - 只在升级时**整份替换**这三份文件，并更新 `source.json` 的 `dshVersion` / `origin` / `extractedAt` / `sha256`；
   - `source.json.dshVersion` 是版本断言的锚点，不要用版本范围或占位值。
6. 覆盖范围**只有** shipped preset 的 `standard` / `ptc` / `cordis`：
   - `minimal` 不动 —— 它走 persistent-shell（`tool-bash-persistent` + PTY `terminal-bash`）这条不同 seam，v1 不支持。
   - `.agent-presets/` 下用户自建 preset 不动 —— 若它们自带 shell 机制，由用户自行处理。
7. 已知风险：**安装前用户若在 Web 编辑器里保存过某个 preset**，profile 的 `cordis.patch.yml` 会带一份整份
   `config.plugins` 快照，而用户层覆盖 bundle 层 —— 它会盖掉本包对 `tool-bash`/`tool-pwsh` 的修正。
   装之前先检查 profile 是否已有 `preset-*` 的 `config.plugins` 覆盖；装之后发现工具没换，先查这一层。
8. preset 覆盖是**快照**：整份复制 `config.plugins`，DSH 升级不会自动合并新行（design.md §10 风险 1）。
   升级流程必须整份替换快照、重新生成并 diff（§8）。

---

## 6. 代码规范

- **TypeScript + ESM + NodeNext**：`tsconfig.json` 用 `module`/`moduleResolution: nodenext`，`rootDir: src`，
  `outDir: lib`，`declaration: true`，`strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`
  + `noImplicitOverride`（重写父类方法要写 `override`）。
- 源码里的相对 import **必须带 `.js` 后缀**（NodeNext 的硬要求）：`import ... from './detect.js'`。
- `src/detect.ts` **必须是纯函数 + 依赖注入**：
  - 真实副作用（`existsSync`、`spawn`）只出现在 `defaultResolveDeps()` / `probeCandidate()` 这两个"生产实现"里；
  - 纯函数通过参数拿 `env` / `platform` / `exists` / `probe`（见 `ResolveDeps`），可以带默认参数指向真实实现，
    但**不得在函数体内重新读取全局状态**；
  - 这样单测才能在不启动任何 bash 的前提下覆盖四条来源、失败聚合、路径翻译、环境转发。
- 错误信息：说明**哪个环节失败**、**候选列表**、**每个候选的失败原因**（含 stderr/stdout 摘要：单行、
  上限约 300 字符、**保留尾部**，因为真正的原因常在最后几行）；**不含**敏感信息（令牌、密钥、完整 env 快照）。
- workdir 翻译只看配置的 `source`，不看解析出来的 target：`/mnt/<d>/...` 与 `/cygdrive/<d>/...` 总是翻译；
  `/<d>/...`（含盘符根 `/c`、`/c/`）仅在 `source` 显式为 `git-bash` 或 `cygwin` 时翻译（`auto` 下不翻译，避免误伤 `/home`、`/tmp`）。
- 注释与标识符英文；用户可见文案（工具描述、prompt section、README/AGENTS）中文。
- 新增运行时依赖前先自问：能否用 `node:` 内置解决。确需引入就在 `package.json` 放到正确区块
  （`peerDependencies` 由 profile 运行时解析；`devDependencies` 只给本地 tsc/脚本用）并在提交说明里写理由。
  当前唯一非内置的运行时工具依赖是 `yaml`，且只被生成/校验脚本使用，不进插件运行时。

---

## 7. 测试规范

- **单测不真正启动任何进程，四个测试文件分工如下**：
  - `tests/detect.test.mjs`（import `../lib/detect.js`）：注入假 `exists` / `probe`，覆盖 `candidatePaths`、
    `probeArgv`、`parseProbe`、`buildInvocation`、`translateWorkdir`（含盘符根 `/c`、`/c/`）、`buildWslEnv`、
    `resolveBashTarget` 的成功路径、`verify: false` 的信任路径，以及"全部候选失败"的聚合错误。
  - `tests/executor.test.mjs`（import `../lib/index.js`）：裸 `cordis` `Context` + 假 `systemPrompt`（捕获 section）
    + 假 `subprocess`。既断言"注册时不 spawn"，也**捕获 `execute()` 交给底层的 spec**：
    native 的 `-lc` argv 与 `NO_COLOR`/`TERM`/`DSH_*`、WSL 的 `wsl.exe -d <distro> --exec bash -c` argv 与
    `WSLENV`/`WSL_UTF8`、prompt section 的 `name`/`order`/`text` 与真实调用形态；另覆盖 `resolve()` 的
    workdir 翻译与 `sandboxPolicy` 置空、两种构造期配置错误；以及 `workdir` 不存在时 `assertWorkdir` 在 spawn 前
    给出含来源/家族/可接受前缀的可读错误（§4.11）。全部以 `verify: false` 建插件（`execute` 的两个
    用例还显式给了 `bashPath`），**零探测**。
  - `tests/patch.test.mjs`（import `../scripts/gen-preset-patch.mjs` 与 `../scripts/check-patch.mjs`）：
    **自包含**（快照在仓库里，没有跳过用例），断言结构、目标版本三处一致、生成物逐字一致，
    并用**目标版本指纹**确认快照没被换成别的版本（当前 0.2.2-rc.5 安装形状）：三个 preset 的 delegation 组都含
    `tool-subagent-control`（`config.interrupt: false`）、`tool-subagent` 用 `modelSelection`/`modelDiscovery`（不再有独立的 `tool-subagent-list-agents` 行与 `modelSelectionSettings`）；
    ptc 带 `tool-executor-ptc` 且没有 `tool-presentation`；standard/cordis 的 `tool-plugin-manager` 都走
    `!!js "!ctx.get('profileContext')"`（ptc 仍为字面 `disabled: true`）；standard 的 `tool-fs.applyPatch: false`、`tool-plugin-market` 存在；
    standard/ptc 有 `tool-office` 行；standard 的 `skill-filesystem` 带 `customSkillDirs`；cordis 的 persona 含「You help the user customize DeepSeek Harness itself.」。
    升级 DSH 时必须按 §8 同步更新这些指纹。
    另有 `preset 快照逐字节校验` 用例（`verifySnapshotHashes` 与 `source.json.sha256` 一致），
    以及 `peerDependencies 必须是精确版本` 用例（直接测 `peerPinProblems()`：真实 manifest 无问题，
    范围值/版本不一致都会被拒）。
  - `tests/panel.test.mjs`（import `../lib/panel.js`）：配置面板纯逻辑与路由——引号/裸值归一化、校验错误、
    假 `webServer` + 假 `configEditor` 下的 GET/POST、页面 token、跨站拒绝；**不启动真实网络/进程**。
  - `tests/executor.test.mjs` 还覆盖 `awaitTarget` 的**超时/取消**分支：通过 `ctx.shell.internals.deps`
    注入永不 settle 的假 probe、把 `state` 置为 failed 触发重试，验证前台 `timeoutMs` 与调用方 abort
    都会终止等待——改 §4.10 的等待语义必须保留这两条用例。
  - `tests/executor.test.mjs` 的 **lifecycle 用例**：预先 `ctx.provide('shell', stale)` 模拟热安装时旧
    `pwsh-sandbox` 仍占用服务槽，断言插件加载不抛 duplicate-service、旧 provider 释放后自动挂载
    `VsshellService`（prompt section 也在挂载后才出现），以及“被占用时无效配置仍然在 load 阶段被拒绝”。
    改 §4.14 的延迟挂载必须保留这两条用例。
- **改 `src/detect.ts` 就必须同步补/改 `tests/detect.test.mjs`**（新增来源、新增翻译规则、新增转发变量都算）；
  改 `src/index.ts` 的注册/`resolve()`/`execute()`/prompt 文本就同步补/改 `tests/executor.test.mjs`；
  改生成规则、快照或目标版本就同步补/改 `tests/patch.test.mjs`（含版本指纹）。
- 单测 import 的是 `lib/`（`patch.test.mjs` 例外，它要生成器/校验器的真实模块）：**先 build 再 test**，
  否则测的是旧产物（`pnpm run check` 内部按 typecheck → build → test 排序，直接跑 `pnpm run check` 最省事）。
- 改 patch 生成器/快照 → 让 `pnpm run check:patch` 与 `tests/patch.test.mjs` 一起保持通过，并用
  `git diff cordis.patch.yml` 证明只改了预期部分；不要用改测试/改校验的方式绕过不一致。
- `scripts/smoke-executor.mjs` 是唯一会真正拉起 bash 的地方，**只在 `danger-full-access` 下有意义**（§3）；
  它支持 `VSSHELL_SOURCE` / `VSSHELL_BASH_PATH` / `VSSHELL_DISTRO` / `VSSHELL_LOGIN` 覆盖配置。
- 判定标准：`pnpm run check` 全绿。清单里没有"这条本来就会红"的项；红了就修，不要解释成环境问题
  （除非能复现为受限令牌导致，见 §3）。

---

## 8. DSH 版本升级流程

目标版本由 `presets/` 快照固定；升级 = 换快照 + 换依赖版本 + 重新生成，三者必须同一版本。按顺序做，不要跳步：

1. **换快照**：从新版本安装里取出 shipped preset 原文 ——
   `<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/{standard,ptc,cordis}.patch.yml`，
   逐字覆盖 `presets/` 下同名文件；更新 `presets/source.json` 的 `dshVersion`、`origin`、`extractedAt`
   与 `sha256`（`Get-FileHash -Algorithm SHA256` / `sha256sum` 重算三份文件）。**不要用别的版本的源码检出拼一份"差不多"的快照。**
2. **换依赖版本**：`devDependencies` 里 `@deepseek-ai/dsh-*` 精确改成新版本；`peerDependencies` 也写
   **精确版本**（不是 `~`，否则 0.2.1 系列内会静默放行）；`@deepseek-ai/cordis` 同步到该 DSH 附带的版本。跑 `pnpm install`。
3. **重新生成**：`pnpm run gen:patch`（默认读 `presets/`）。生成物头部应自动变成新版本。
4. **跑检查**：`pnpm run check`。`check:patch` 三段必须 PASS（版本断言会挡住"快照/依赖/生成物三处不一致"）；
   `typecheck` 会第一个暴露 `LocalBashExecutor` 内部变化（`protected executeArgv` / `resolve` 的签名或语义），
   预算字段有变化就按 §4.3 同步。
5. **diff 审阅**：`git diff presets/ cordis.patch.yml package.json`，逐项确认 —— 新增/删除的 preset 行、
   `tool-bash` 仍启用、`tool-pwsh` 仍 `disabled: true`、`!!js` 与多行块原样保留、insert 行仍 win32-only；
   `tests/patch.test.mjs` 的**版本指纹**要按新版本**安装**的真实形状更新（0.2.2-rc.5 的 delegation 是 `tool-subagent-control` + `modelSelection`/`modelDiscovery`，ptc 用 `tool-executor-ptc`，standard/cordis 的 `tool-plugin-manager` 走 `!!js`；若误用旧或开发源码快照，会看到 `tool-subagent-list-agents`、`modelSelectionSettings`、`tool-presentation` 等旧形状）。
6. **重装 + 插入检查（第二阶段）**：`pnpm run build` 后重新 `plugin_manager install_bundle`（或重装 bundle）
   并重启，验证 `bash` 工具存在、`pwsh` 不存在、四个来源可切换、后台任务/超时/输出截断正常。

**升级实例 1（0.2.1-rc.2 → 0.2.1-rc.3，2026-10-24）**：桌面端升级后工具回退为 `pwsh`——原因是 bundle 的 peer 精确固定 rc.2，被 rc.3 运行时兼容检查拒绝。按本流程处理后：rc.3 **安装**的 shipped preset 与 rc.2 逐字节相同（sha256 不变，只改 `source.json` 的 `dshVersion`/`origin`）；`package.json` 的 DSH dev/peer 全部精确改 rc.3（cordis 仍 4.0.5）；`gen:patch` 后生成物仅版本行变化；`check` 全绿；rc.3 依赖下 smoke 10/10。rc.3 的 `permission-presets`/`tool-bash` seam 未变，`src/` 无需修改。

**升级实例 2（0.2.1-rc.3 → 0.2.1-rc.5，2026-10-31）**：同样因 peer 精确固定 rc.3 被 rc.5 兼容检查拒绝（工具回退 `pwsh`）。rc.5 **安装**的 shipped preset 仍与 rc.2/rc.3 逐字节相同（三份 sha256 不变）；`package.json` 的 dev/peer 精确改 rc.5（cordis 仍 4.0.5、schemastery 3.18.5）；重新 `pnpm install` 后 typecheck 直接通过（`LocalBashExecutor`/`ShellExecutor` API 未变）；`gen:patch` 只改版本行；`check` 50/50 PASS；rc.5 依赖下 smoke 10/10。另外核对了 rc.5 的 `permission-presets`（仍要求 `sandboxMode` 非空）、`tool-bash`（sandboxPolicy seam 未变）、`configEditor.edit` 与 `webServer.register/getOrigin`（面板接口未变）。

**升级实例 3（0.2.1-rc.5 → 0.2.2-rc.1，2026-11-04）**：这是 **minor 升级**，不止版本号：shipped preset 形状变了（list-agents 并入 `tool-subagent-control`、`modelSelection`/`modelDiscovery`、ptc 改 `tool-executor-ptc`、`tool-plugin-market`、`tool-fs.applyPatch`），且 cordis 4.0.5 → **4.1.0**、schemastery 3.18.5 → 3.19.0。按流程整份替换快照 + 更新三份 sha256/`source.json` + 重写 `tests/patch.test.mjs` 指纹；`package.json` dev/peer 精确改 `0.2.2-rc.1`、cordis `4.1.0`、schemastery dev `3.19.0`/peer `^3.19.0`；typecheck 通过；`gen:patch` 与新 preset 一致；`check` 50/50 PASS；smoke custom/Cygwin 10/10。**客户端契约也变了**：0.2.2-rc.1 的 `settings.section` 注册只接受 `id`/`order`/`label`（旧的 `locale`/`inject` 选项不再文档化），`client.js` 已改为闭包传 `t`/`ctx` + `ctx.locale.subscribe()` 触发重渲染。`permission-presets`、`tool-bash`、`configEditor`、`webServer` 的服务 seam 仍未变。

**升级实例 4（0.2.2-rc.1 → 0.2.2-rc.3，2026-11-13）**：**patch 版本也会改 shipped preset**：standard/ptc 新增 `tool-office`，standard 的 `skill-filesystem` 增加 `customSkillDirs`，delegation 的 `tool-subagent-control` 增加 `interrupt: false`，cordis persona 文本更新。处理：整份替换三份快照（sha256 全变）、更新 `source.json`、DSH dev/peer 精确改 `0.2.2-rc.3`、插件版本 `0.3.2`（生命周期修复另计）、扩充测试指纹（tool-office/customSkillDirs/interrupt/persona）；`check` 50/50 PASS、smoke custom/Cygwin 10/10 PASS。

**升级实例 5（0.2.2-rc.3 → 0.2.2-rc.5，2026-11-18）**：rc.5 的 **shipped preset 与 rc.3 逐字节相同**（三份 sha256 不变），cordis 仍 4.1.0、schemastery 3.19.0；`permission-presets`（仍要求 `sandboxMode`）、`tool-bash`（sandboxMode/escalation seam）、`configEditor.edit`、`webServer.register/getOrigin` 均未变。处理：只更新 `presets/source.json` 的 `dshVersion`/`origin`/`extractedAt`、`package.json` 的 DSH dev/peer 精确改 `0.2.2-rc.5`、插件版本 `0.3.3`，重跑 `gen:patch`（仅版本行变化）；`check` 52/52 PASS、smoke custom/Cygwin 10/10 PASS。**结论**：patch 版本升级也要先提取安装快照比对，确认边界后再决定是否替换；不能凭版本号假设。

关于 `lib/`：它是构建产物，但**随仓库提交**。原因：安装时 profile 拿到的是 `link:` 指向本仓库的目录，
DSH 直接加载 `lib/index.js`，不走构建。**改了 `src/` 不 `pnpm run build` 就 install，等于装了个旧版本。**

---

## 9. 禁止事项

- **不要**为了"顺便装好"去改 DSH profile 的 `package.json` / `cordis.patch.yml`；安装走
  `plugin_manager install_bundle`（需要审批），卸载走 `remove_bundle`。
- **不要**手改 `cordis.patch.yml`（§5）；**不要**手改 `presets/` 三份快照内容（只允许整份替换）。
- **不要**放宽 `check:patch` 的结构/版本/一致性断言，也不要为了让 `tests/patch.test.mjs` 变绿去改指纹
  （改指纹只在升级 DSH、且快照已整份替换之后）。
- **不要**把 host `tool-bash` 改回 `!!js` 门控（§4.9），也不要给 insert 的 `dsh-vsshell` 去掉 win32-only（§4.7）。
- **不要**在受限令牌沙箱里跑 `pnpm run smoke` 然后据此判断代码坏了（§3）。
- **不要** `git commit` 与当前任务无关的内容：临时脚本、`scratch/` 输出、`node_modules/`、`.pnpm-store/`、日志。
- **不要**为了适配本插件去改上游 DSH 源码；要改就改本仓库，并把上游行为记录在 `docs/design.md`。
- **不要**引入新依赖除非确有必要，且必须说明理由（§6）。
- **不要**承诺未实现的能力：不做沙箱、不支持 persistent shell、不覆盖 `minimal` 与用户自建 preset ——
  这些都要在提示词与文档里如实披露，而不是含糊过去。

---

## 10. 改动地图

| 想做什么 | 改哪里 | 必跑 |
|---|---|---|
| 改 bash 来源/候选路径/探测 | `src/detect.ts` + `tests/detect.test.mjs` | `pnpm run check` |
| 改 workdir 翻译或 WSL 环境转发 | `src/detect.ts` + `tests/detect.test.mjs` + design.md §6 | `pnpm run check` |
| 改执行器行为或配置 schema | `src/index.ts`（预算字段按 §4.3、等待语义按 §4.10）+ design.md §5/§7 | `pnpm run check` |
| 改系统提示词披露的内容 | `src/index.ts` 的 prompt section + design.md §7 | `pnpm run check` |
| 改配置面板（字段/路由/文案/引号归一化） | `src/panel.ts` + `client.js` + `tests/panel.test.mjs` + design.md §7.5/§8 | `pnpm run check`（client.js 语法检查也包含在内） |
| 改 preset 快照 / 生成逻辑 | `presets/*.patch.yml` + `presets/source.json` + `scripts/gen-preset-patch.mjs` → `pnpm run gen:patch` | `pnpm run check:patch` + `pnpm run test` + `git diff presets/ cordis.patch.yml` |
| 改 patch 校验规则 | `scripts/check-patch.mjs` + `tests/patch.test.mjs` | `pnpm run check:patch` + `pnpm run test` |
| 真机验证执行路径 | `scripts/smoke-executor.mjs` | `pnpm run smoke`（`danger-full-access`） |
| 升级 DSH | `presets/` 三份快照 + `source.json` + `package.json` 版本 + `gen:patch` | §8 全流程（`check` 三段 PASS + diff 审阅 + 重装） |
