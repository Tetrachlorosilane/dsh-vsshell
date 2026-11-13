# dsh-vsshell

[![GitHub topic: dsh-plugin](https://img.shields.io/badge/topic-dsh--plugin-blue)](https://github.com/topics/dsh-plugin)

为 Windows 上的 DeepSeek Harness 提供**可配置的 bash 执行器**，并让内置的 `bash` 工具取代 `pwsh` 工具。

- 包名：`@dsh-external/dsh-vsshell`
- 仓库：<https://github.com/Tetrachlorosilane/dsh-vsshell>（GitHub 话题：`dsh-plugin`）
- 目标平台：Windows 10 / 11
- 支持来源：Git for Windows（MSYS2）、WSL、Cygwin、自定义路径

> **安全提醒（必读）**：本插件的 `bash` 工具执行的命令**不受** DSH 文件沙箱约束（文件工具仍受限）。工具 schema 中会出现 `sandbox_permissions` / `justification` 参数——那只是 DSH 权限预设要求的执行器能力声明，**对本 bash 不生效**：传入任何升级请求都不会改变约束，也不会让命令变得受沙箱保护。若你需要真正的 shell 沙箱，请不要使用本插件（或等待后续版本）。详见 §8.1。

## 1. 这个插件解决什么问题

在 Windows 上，DSH 的默认组合是「PowerShell 优先」：`bash-sandbox` 被禁用、`pwsh-sandbox` 启用（提供 `ctx.shell`），内置 `tool-bash` 被禁用、`tool-pwsh` 启用。结果是模型只能拿到 `pwsh` 工具。

本插件做四件事：

1. 提供一个 host 层的 bash 执行器（行 id `dsh-vsshell`，仅 win32 启用），替代 `pwsh-sandbox` 提供的 `ctx.shell`，把命令交给用户选定的 bash；
2. 通过 `cordis.patch.yml` 在 host 层禁用 `pwsh-sandbox` 与 `tool-pwsh`，并让内置 `tool-bash` 常开（Web/preset 组合里由 preset 的同名行在 agent scope 遮蔽）；
3. 把三个内置 agent preset（`standard` / `ptc` / `cordis`）的 `config.plugins` 整份覆盖为「`tool-bash` 启用、`tool-pwsh` 禁用」；
4. 提供一个 Web 设置面板（设置 → Bash 执行器），可视化编辑上述 6 个字段并把结果写回 profile 用户层（见 4.4）。

执行循环直接复用 DSH 自带的 `@deepseek-ai/dsh-bash-local`（`LocalBashExecutor`），因此超时、取消、输出截断、后台任务、输出溢写等语义与内置 bash 工具一致；本插件只替换「用哪个 bash、怎么起进程、路径怎么翻译」。

## 2. 环境要求

| 项 | 要求 |
|---|---|
| 操作系统 | Windows 10 / 11（x64） |
| DSH | **0.2.2-rc.3（精确固定）**，Desktop Web profile；CLI / headless 亦兼容 |
| Node.js | ≥ 22（运行时用 DSH 内置 Node；仅构建/开发时需要本机 Node） |
| bash 来源 | 可选其一：Git for Windows（推荐）、WSL 发行版、Cygwin、自定义 bash 路径 |
| 权限 | 安装 bundle 需要 DSH 会话的 full-access 审批 |

本插件**不跨 DSH 版本兼容**，目标版本精确固定为 0.2.2-rc.3：

- `presets/` 里保存该版本安装自带的 `standard` / `ptc` / `cordis` 三份 preset 原文，`presets/source.json` 记录 `dshVersion`、提取来源与三份文件的 `sha256`（生成器与测试逐字节校验，手改内容会被拒绝）；
- `package.json` 的 `devDependencies` 精确固定 `0.2.2-rc.3`，`peerDependencies` 里的 `@deepseek-ai/dsh-*` 也写**精确版本** `0.2.2-rc.3`（`@deepseek-ai/cordis` 精确跟随该 DSH 附带的 `4.1.0`）。DSH 升到其它版本时兼容性检查会**拒绝**本插件，而不是静默套用错版本的 preset 形状；
- `pnpm run check:patch` 断言「生成物头部的目标版本 = preset 快照版本 = `@deepseek-ai/dsh-bash-local` devDependency 版本」，三者不一致直接失败；
- 不要用**开发源码检出**里的 preset 生成 patch：发行安装的 preset 才是唯一依据。0.2.2 系列**改过两次 preset 形状**：rc.1 是 minor 变更（`tool-subagent-list-agents` 并入 `tool-subagent-control`、`modelSelectionSettings` 换成 `modelSelection`/`modelDiscovery`、ptc 改用 `tool-executor-ptc` 取代 `tool-presentation`、新增 `tool-plugin-market`/`applyPatch` 配置），rc.3 又新增 `tool-office`（standard/ptc）、standard 的 `skill-filesystem.customSkillDirs`、`tool-subagent-control.interrupt: false` 并更新 cordis persona 文本。两次升级都已整份替换快照、更新 sha256 与测试指纹；**不要假设 patch 版本不会改 preset**。

`@deepseek-ai/*` 依赖以 `peerDependencies` 形式声明，运行时由 profile 的模块解析映射到 DSH 安装目录，不需要在 DSH 里单独安装这些包。

本插件只面向 Windows：bundle patch 里 `dsh-vsshell` 行带 `disabled: !!js "process.platform !== 'win32'"`，非 win32 平台上该执行器不会加载（POSIX 继续由 shipped `bash-sandbox` 提供 `ctx.shell`，避免重复注册 provider）。

## 3. 安装

### 3.1 构建并自检

```powershell
git clone https://github.com/Tetrachlorosilane/dsh-vsshell.git
cd dsh-vsshell
pnpm install
pnpm run build
pnpm run check
```

`pnpm run check` 的完整门禁顺序是：typecheck → build → 产物语法检查（含 `client.js`）→ 单测（52 个用例）→ `cordis.patch.yml` 结构 / 目标版本 / 生成物一致性校验；全绿后再安装。

**自包含**：`cordis.patch.yml` 从仓库内的 `presets/` 快照生成，`pnpm run check` 不需要 DSH 源码检出。

**必须先 `pnpm run build`**：`lib/` 是构建产物，安装后 DSH 直接加载 `lib/index.js`，不走构建。改了 `src/` 却没重新构建就安装，等于装了个旧版本。

注意：`pnpm install` 末尾可能以非零码退出并提示 `ERR_PNPM_IGNORED_BUILDS`（pnpm 不执行依赖的 build script）。这**不影响**依赖安装、构建与单测，可以继续。

### 3.2 安装到 DSH profile

在 DSH 会话里调用 `plugin_manager` 的 `install_bundle`，目标用本目录的**绝对路径**（例如上面的 clone 目录）：

```
action: install_bundle
target: <本仓库的绝对路径>
```

该操作需要 danger-full-access 权限（会请求审批）。安装完成后**重启 DSH**（或重载 profile），让 host 行与 preset 覆盖生效。

也可以直接从 GitHub 仓库安装（`target: https://github.com/Tetrachlorosilane/dsh-vsshell` 或 `github:Tetrachlorosilane/dsh-vsshell`）。**热安装时** DSH 会把新 bundle 叠到正在运行的组合上：旧的 `pwsh-sandbox` 可能还占着 `ctx.shell`，本插件的执行器会**等待旧 provider 卸载后自动挂载**，不会抛重复服务错误；如果旧 provider 直到重启才卸载，则 `bash` 工具会在重启后出现。详见 9.10。

> 从 URL 安装会触发 pnpm 重算 profile 依赖树，**不在 profile `package.json` 依赖里的手工插件会被移动到 `node_modules/.ignored`**（典型现象：`sandbox-extra-roots` 报 `ERR_MODULE_NOT_FOUND` warning）。装之前先把这类本地插件写成 `link:` 依赖，见 9.10。

> 如果这个 profile 之前用 Web 编辑器保存过 preset，它的 `cordis.patch.yml` 里可能已有 `preset-*` 覆盖行，会整份盖掉本 bundle 的修正（装完仍是 pwsh、`list_agents` / PTC 呈现消失）。装之前或装之后发现异常，先看 9.9。

### 3.3 安装后验证清单

| 检查项 | 期望结果 |
|---|---|
| `bash` 工具 | 工具列表中存在 `bash` |
| `pwsh` 工具 | 不存在（被禁用） |
| 当前 preset | `standard` / `cordis` / `ptc` 之一（三者已被覆盖） |
| `list_agents` 工具 | 存在。0.2.2-rc.3 由 preset 的 delegation 里 `tool-subagent-control` 提供（旧 rc.2–rc.5 是独立的 `tool-subagent-list-agents` 行），preset 被整份覆盖后仍然保留 |
| `ptc` preset 的 PTC 呈现 | 仍在。0.2.2-rc.3 用 `tool-executor-ptc`（旧版是 `tool-presentation`），preset 覆盖不会丢掉它 |
| 执行 `echo hello` | 返回 `hello` |
| 执行 `pwd` | 按来源显示：Git Bash `/c/Users/...`、WSL `/mnt/c/Users/...`、Cygwin `/cygdrive/c/Users/...` |
| 退出码 | `exit 42` 能正确回传 42 |

补充说明：

- host 层的 `tool-bash` 行是**常开**（`disabled: false`），Web/preset 组合里由 preset 的 agent-scope 同名 `tool-bash` 行遮蔽它；两条行不同层，不冲突。
- 上表前三项同时成立，才说明 host 行与 preset 覆盖都已生效；`list_agents` 或 PTC 呈现不见时见 9.9。
- 若 `bash` 工具存在但每次调用都报找不到 bash，见第 9 节排障。

### 3.4 卸载与回退

```
action: remove_bundle
target: @dsh-external/dsh-vsshell
```

然后重启 DSH。**没有「一条命令切回 pwsh」**：本 bundle 的 patch 在 host 层禁用了 `pwsh-sandbox` 与 `tool-pwsh`，并把三个 preset 的工具组合覆盖成 `tool-bash`。所以要回到默认的 pwsh，需要

1. 卸载本 bundle（`remove_bundle`）并重启，让 host 层与 preset 恢复默认；**或者**
2. 手工在 profile 的 `cordis.patch.yml` 里恢复 host 行：重新启用 `pwsh-sandbox` / `tool-pwsh`、禁用 `dsh-vsshell`，并撤销三份 preset 覆盖（覆盖是整份 `config.plugins` 快照，需要自己换回带 `tool-pwsh` 的列表）。

只把 `- id: dsh-vsshell` 设成 `disabled: true` 并不能回退：那样 `ctx.shell` 没人提供，`tool-bash` 会因缺少执行器而不可用，而 `tool-pwsh`/`pwsh-sandbox` 仍被本 bundle 禁用。

## 4. 配置

配置写在 profile 的 `cordis.patch.yml` 中（profile 用户层在 bundle 层之后叠加，因此用户层覆盖 bundle 内的默认配置）。最小写法：

```yaml
- id: dsh-vsshell
  config:
    source: auto
```

不写 `config` 时全部使用 schema 默认值（等价于 `source: auto`）。bundle 自带的 patch 里这一行就是 `config: {}`，因此不做任何配置也能用；需要改行为时在 profile 用户层写上面那段覆盖即可。

### 4.1 配置字段

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `source` | `'auto' \| 'wsl' \| 'git-bash' \| 'cygwin' \| 'custom'` | `'auto'` | bash 来源。`auto` 依次探测 Git Bash → Cygwin → WSL |
| `bashPath` | string | `''` | 显式可执行文件路径。`custom` 时必填；`wsl` 时可指向 `wsl.exe` 或旧版 `bash.exe`；其他来源下非空时**只用该路径**（不再枚举候选）。`verify: true`（默认）时仍会存在性检查 + 探测一次；`verify: false` 时完全不校验、直接使用 |
| `wslDistro` | string | `''` | WSL 发行版名（对应 `wsl.exe -d`），空 = 默认发行版。对**任何最终走 WSL launcher 的来源**生效（包括 `source: auto` 回落到 WSL）；纯 native 来源（git-bash / cygwin）不会使用它 |
| `loginShell` | boolean | `true` | `true` 用 `-lc`（加载用户 profile，PATH 更完整、冷启动更慢）；`false` 用 `-c` |
| `verify` | boolean | `true` | 解析时探测选中的 bash（插件加载后即在后台开始，首次调用会等待）：确认能启动、识别 shell 家族，并在失败时给出可用错误。`false` 时信任「第一个存在的路径」，跳过探测延迟；若同时给了 `bashPath`，则该路径连存在性检查都不做、直接使用（见 4.3） |
| `probeTimeoutMs` | number | `15000` | 单个候选的探测超时（毫秒），必须是正有限数 |
| `cwd` | string | 未设置（用 `process.cwd()`） | 默认工作目录 |
| `timeoutMs` | number | `120000` | 前台命令默认超时 |
| `maxTimeoutMs` | number | `600000` | 单次调用允许的最大超时 |
| `maxOutputBytes` | number | `64000` | 每路输出在内存中的上限（超出落 spill 文件） |
| `maxSpillBytes` | number | `64 MiB`（67108864） | spill 文件容量上限 |
| `graceMs` | number | `3000` | 发送终止信号后等待进程退出的宽限期 |

本插件自定义 6 个字段（`source` / `bashPath` / `wslDistro` / `loginShell` / `verify` / `probeTimeoutMs`）；表格最后 6 行是继承来的预算字段，从 `LocalBashExecutor.Config` 原样复制（与上游 `@deepseek-ai/dsh-bash-local` 逐字段同步），其取值校验由父类在解析请求时完成。

配置校验（在插件构造时发生，错误进 host 日志，不静默降级）：

| 情况 | 行为 |
|---|---|
| `source: custom` 但 `bashPath` 为空 | 抛错：`vsshell: source "custom" requires a non-empty bashPath` |
| `probeTimeoutMs <= 0` 或非有限数 | 抛错：`vsshell: probeTimeoutMs must be a positive finite number` |

`wslDistro` 现在对 `auto` 也生效，因此不再有「只有 `source: wsl` 才可用」的告警；如果最终没用上 WSL launcher，它只是被忽略。

### 4.2 示例

```yaml
# 1) auto（默认）：按 Git Bash → Cygwin → WSL 顺序探测
- id: dsh-vsshell
  config:
    source: auto
```

```yaml
# 2) Git for Windows：只用 MSYS2 bash
- id: dsh-vsshell
  config:
    source: git-bash
```

```yaml
# 3) WSL：可指定发行版
- id: dsh-vsshell
  config:
    source: wsl
    wslDistro: Ubuntu-22.04
```

```yaml
# 4) Cygwin
- id: dsh-vsshell
  config:
    source: cygwin
```

```yaml
# 5) custom：完全自定义可执行文件路径（必填 bashPath）
- id: dsh-vsshell
  config:
    source: custom
    bashPath: C:\tools\git\bin\bash.exe
```

常用组合调整：

```yaml
# 不加载用户 profile，冷启动更快
- id: dsh-vsshell
  config:
    source: auto
    loginShell: false

# auto 探测太慢时缩短单候选超时
- id: dsh-vsshell
  config:
    source: auto
    probeTimeoutMs: 5000

# auto 回落到 WSL 时也指定发行版（wslDistro 对 auto 同样生效）
- id: dsh-vsshell
  config:
    source: auto
    wslDistro: Ubuntu-22.04

# 跳过首次探测、直接信任路径（见 4.3）
- id: dsh-vsshell
  config:
    source: wsl
    wslDistro: Ubuntu-22.04
    verify: false
```

### 4.3 `verify`：探测还是信任

`verify: true`（默认）会在首次使用前探测选中的 bash：确认它真能启动、从 `$OSTYPE` 识别 shell 家族，探测失败时给出「候选 + 失败原因」的可用错误（见第 9 节）。

`verify: false` 跳过探测，行为变成：

| 配置 | `verify: false` 下的行为 |
|---|---|
| 给出了 `bashPath` | **完全不校验**：不探测，也不做存在性检查，直接按路径使用 |
| 未给 `bashPath`（走候选列表） | 信任**第一个存在的**路径（仍做存在性检查） |

代价与适用场景：

- 适合 `wsl.exe` / Git Bash 冷启动慢、探测拖慢启动的场景；
- 此时 shell 家族未知（`unknown`），系统提示词会明确写「未探测，家族与路径语法未验证」，不会编造家族；
- 失败信息会退化：不再有「候选 + 探测原因」的聚合错误，而是在命令执行阶段直接报 spawn 错误（例如路径写错时是 `ENOENT`）；
- 如果只是探测超时，优先考虑调大 `probeTimeoutMs` 而不是关掉 `verify`。

### 4.4 Web 配置面板

安装并重启 DSH 后，**设置 → Bash 执行器（dsh-vsshell）** 会多出一个配置页（由 bundle 插入的 `dsh-vsshell-panel` host 行 + `client.js` browser half 提供）：

- 编辑 `source`（下拉）、`bashPath`、`wslDistro`、`loginShell`、`verify`、`probeTimeoutMs`；
- 顶部显示**当前生效的 shell**（来源/家族/可执行文件；解析失败时显示首行原因）与警告（例如 bashPath 不存在、当前值仍来自 bundle 默认值）；
- **保存**通过 DSH 的 `configEditor` 写入 profile 用户层（`cordis.patch.yml`），由 Loader 热应用；面板自己**不手写 YAML**，所以已有注释、字段顺序和其它配置键都会保留。若工具没有立即切换，重启 DSH；
- 面板只改这 6 个字段，预算字段（`timeoutMs` 等）保持原值。

**引号兼容**：从 `cordis.patch.yml` 读取时引号由 YAML 层处理（单引号 / 双引号 / 裸值都等价）；在面板输入框里粘贴带引号的值也会被归一化，例如下面三种写法等价：

```yaml
bashPath: C:\cygwin64\bin\bash.exe
bashPath: 'C:\cygwin64\bin\bash.exe'
bashPath: "C:\\cygwin64\\bin\\bash.exe"
```

数字/布尔字段接受带引号的字符串（如 `"false"`、`'9000'`），保存时统一落成正常类型。面板路由只接受**同源**请求（`Origin` 校验 + 每次启动生成的页面令牌），并只监听本机 DSH Web 端口（见 8.1 的安全提醒）。

## 5. bash 来源与选择顺序

| `source` | 候选路径（按顺序） | 调用方式 |
|---|---|---|
| `git-bash` | `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles%\Git\usr\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`、`%LOCALAPPDATA%\Programs\Git\bin\bash.exe`、`%USERPROFILE%\scoop\apps\git\current\bin\bash.exe` | `<bash> -lc <command>`（`loginShell: false` 时为 `-c`） |
| `cygwin` | `%SystemDrive%\cygwin64\bin\bash.exe`、`%SystemDrive%\cygwin\bin\bash.exe`、`%ProgramFiles%\Cygwin64\bin\bash.exe`、`%ProgramFiles%\Cygwin\bin\bash.exe` | 同上 |
| `wsl` | `%SystemRoot%\System32\wsl.exe`、`%SystemRoot%\System32\bash.exe` | `wsl.exe [-d <distro>] --exec bash -lc <command>`；旧版 `bash.exe` 直接 `<bash.exe> -lc <command>`。`auto` 回落到 WSL 时 `wslDistro` 同样生效 |
| `auto` | 以上三段拼接并去重，顺序 Git Bash → Cygwin → WSL | 同上，按命中来源 |
| `custom` | 只用 `bashPath` | `source: wsl` 或「`auto` + 路径名为 `wsl.exe`」按 WSL 调用，其余按 native 调用；探测到 `linux-gnu` 且路径位于 `System32` 时会自动纠正为 WSL 语义 |

解析时机：插件加载时**在后台**开始解析（不阻塞 host 启动），首次工具调用会等待它完成；解析成功后结果被缓存，之后每次调用直接复用。解析失败不会缓存，**下一次调用会重新解析**（装好 bash 后无需重启即可自愈）。

等待解析的过程受**本次调用自己的超时与取消**约束：前台调用的超时会中断等待并报

```
vsshell: bash resolution did not finish within <n>ms; raise probeTimeoutMs or set verify: false
```

调用方取消（abort）也会立即中断等待。也就是说慢探测不会让一次调用超过它自己的 `timeoutMs`。

默认 `verify: true` 时，候选逐个「存在性检查 → 探测」，第一个探测成功者即目标。探测命令固定为：

```bash
printf '__vsshell_probe__:%s\n' "${OSTYPE:-unknown}"
```

探测用 `-c`（不加载 profile，快且不影响判定），并强制 `NO_COLOR=1`；探测 WSL 启动器时额外设 `WSL_UTF8=1`。命中 marker 且退出码为 0 才算成功。若探测到的 `$OSTYPE` 是 `linux-gnu` 且可执行文件位于 `System32`（例如把 `%SystemRoot%\System32\bash.exe` 写进 `bashPath`），即使它被配置成 native 也会被纠正为 WSL 语义调用。

`verify: false` 时不做探测：按候选顺序取**第一个存在的路径**，若有显式 `bashPath` 则完全不校验、直接使用（详见 4.3）。

## 6. 路径语义

### 6.1 每次调用都是全新 shell

每次工具调用都是一个新的、非交互的 bash 进程：没有持久状态，`cd` 不会跨调用保留，环境变量导出也不会。要指定目录，用工具的 `workdir` 参数，不要在命令里依赖上一条命令的 `cd`。

### 6.2 `workdir` 用 Windows 路径

`workdir` 参数按 Windows 路径传，例如 `C:\Users\me\projects\app`。插件把它翻译成 Windows 路径后作为进程的 `cwd` 交给 bash，bash 自己会显示成对应家族的 POSIX 形式：

| 来源 | 同样的 `C:\Users\me` 在 bash 里显示为 |
|---|---|
| Git Bash（MSYS2） | `/c/Users/me` |
| WSL | `/mnt/c/Users/me` |
| Cygwin | `/cygdrive/c/Users/me` |

因此**写在命令里的路径要按来源用对应的 POSIX 写法**：

```bash
# Git Bash
cd /c/Users/me/projects/app && ls

# WSL
cd /mnt/c/Users/me/projects/app && ls

# Cygwin
cd /cygdrive/c/Users/me/projects/app && ls
```

### 6.3 `workdir` 的自动翻译

如果在 `workdir` 里写了 POSIX 形式，插件会做一次尽力翻译：

| `workdir` 输入 | 翻译结果 | 生效条件 |
|---|---|---|
| `/mnt/c/Users/me/app` | `C:\Users\me\app` | 任意来源（形状无歧义） |
| `/cygdrive/c/Users/me/app` | `C:\Users\me\app` | 任意来源（形状无歧义） |
| `/c/Users/me/app` | `C:\Users\me\app` | 仅当 `source` 显式配置为 `git-bash` 或 `cygwin` |
| `C:\Users\me\app` | 原样 | — |
| `/home/user` | 原样（不做猜测） | — |

`/c/...` 这种单字母形态只在 `source` 显式为 `git-bash` / `cygwin` 时翻译：在 `auto` 下同一个形状也可能是「当前盘根目录」，翻译会误伤 `/home`、`/tmp` 这类真实路径。也就是说 `source: auto` 解析到 Git Bash 时，**`/c/...` 不会被翻译**。

建议优先用 Windows 路径，自动翻译只作为容错。

另外，`execute` 在 spawn 之前会校验 `workdir` 是否真实存在：不存在时直接返回可读错误（包含解析到的来源/家族/可执行文件，以及可接受的 POSIX 前缀），而不是让模型看到一个无法区分「bash 缺失」还是「目录写错」的裸 `ENOENT`。

### 6.4 `loginShell`

| 取值 | 行为 | 影响 |
|---|---|---|
| `true`（默认） | `-lc`：login shell | 加载 `/etc/profile`、`~/.bash_profile`、`~/.profile` 等；PATH 更接近用户交互环境；冷启动更慢；用户 profile 里的脚本副作用会生效 |
| `false` | `-c`：非 login shell | 启动更快；PATH 可能缺少用户自定义目录 |

Cygwin 的 `/etc/profile` 会把 login shell `cd` 到 `$HOME`，这会悄悄破坏 `workdir`。执行器对所有 native bash 启动都导出 `CHERE_INVOKING=1`（Cygwin 的标准约定，Git Bash 忽略该变量），所以 `workdir` 在 Cygwin login shell 下仍然生效；WSL 启动不带该变量。

## 7. 生效范围

| 位置 | 本插件的影响 |
|---|---|
| host 层 `pwsh-sandbox` | 禁用，不再提供 `ctx.shell` |
| host 层 `dsh-vsshell` | 插入，提供 bash 执行器；仅 win32 启用（POSIX 由 `bash-sandbox` 继续提供 `ctx.shell`） |
| host 层 `dsh-vsshell/panel` | 插入，配置面板的 Host 半（同源 JSON 路由 + profile 配置读写）；仅 win32 启用，随配置面板使用 |
| host 层 `tool-bash` | **常开**（`disabled: false`）。CLI / headless 组合直接由这一行提供 `bash` 工具；Web/preset 组合里同名的 preset 行在 agent scope 内遮蔽它（只在同一 scope 内重名才是错误） |
| host 层 `tool-pwsh` | 禁用 |
| `preset-standard` | 整份覆盖，改为启用 `tool-bash`、禁用 `tool-pwsh` |
| `preset-cordis` | 同上 |
| `preset-ptc` | 同上（0.2.2-rc.3 的 `tool-executor-ptc` 等其它子插件原样保留） |
| `preset-minimal` | **不覆盖**。它使用 persistent PTY shell（`tool-bash-persistent` + `terminal-bash`），是另一条 seam，本插件 v1 不接管 |
| 用户自建 preset（如 `.agent-presets/` 下的自定义 preset） | **不覆盖**。其自带插件列表原样保留；不过 host 层 `tool-bash` 常开，所以默认仍会继承全局 `bash` 工具（除非该 preset 自己用 `tools.restrict` 排除了它，或自带私有 shell 机制） |

Web profile 的 host 层工具行被 `dsh-web-app` 统一禁用，模型可见的工具由 agent preset 提供，所以三个内置 preset 被整份覆盖；host 的 `tool-bash` 常开行在这个组合里被 preset 的同名行遮蔽（它并非「仅 CLI 启用」，而是常开、由 agent scope 遮蔽）。CLI / headless 没有 agent preset，直接用 host 行。

## 8. 限制与安全

### 8.1 bash 不受 harness 文件沙箱约束（重要）

DSH 在 Windows 上用受限令牌实现文件沙箱。实测该受限令牌内 Git Bash 启动即报 `couldn't create signal pipe, Win32 error 5`，WSL 报 `Wsl/E_ACCESSDENIED`——**bash 无法在受限令牌内运行**，所以 `bash` 工具执行的命令不受 harness 文件沙箱约束。

这里有两个必须分开理解的事实：

1. **执行不设限**：执行器不调用 `ctx.sandbox.confine`，`resolve()` 会丢弃调用方的 `sandboxPolicy`，结果也不携带任何 sandbox enforcement 信息。
2. **`sandboxMode` 仍然有值**：DSH 的 `permission-presets` 拒绝在 `sandboxMode === undefined` 的 shell 执行器上组合（否则 GUI 的权限预设切换与投影不可用），并把该值当作会话默认 sandbox 模式。因此执行器把 `sandboxMode` 镜像为 `ctx.sandboxPolicy.defaultMode`（即本部署的默认文件策略，通常 `workspace-write`）——它描述的是**部署默认的 FILE 策略**，不是 bash 的约束能力。

连带影响：`bash` 工具会像其它受限执行器一样广告 `sandbox_permissions` / `justification` 参数，但本执行器不会执行该策略（传了就丢弃）：这两个参数对 bash **完全无效**，**不要依赖它判断命令是否被约束、或试图用它换取约束**。模型侧的系统提示词也明确写着「bash 不设限、executor 报 sandbox 模式只为 permission presets 组合、sandbox_permissions 参数不生效」。

这意味着：

- 通过 `bash` 执行的命令**不受** harness 文件沙箱的读写限制；
- 文件工具（读/写/编辑、`glob`、`grep` 等）**仍然**受 harness 沙箱约束；
- 这是用户已确认接受的能力弱化，插件也会在系统提示词里向模型如实说明这一点。

如果这条弱化不可接受，请卸载本插件（见 3.4）。

### 8.2 WSL 环境变量是白名单转发

WSL 不会继承 Windows 环境变量。插件通过 `WSLENV` 只转发这些变量**名**（值仍取自 Windows 侧环境）：`DSH_*` 变量、调用方传入的环境变量键、终端覆盖变量（`NO_COLOR`、`TERM`、`PAGER`、`GIT_PAGER`），以及已有的 `WSLENV` 条目（去重保留在前），并附加 `WSL_UTF8=1` 让诊断信息按 UTF-8 输出。其余 Windows 环境变量不会进入 WSL。

### 8.3 已知现象与限制

| 项目 | 说明 |
|---|---|
| `wsl.exe` 代理横幅 | 机器上配置了 localhost 代理时，`wsl.exe` 每次会往 stderr 打一行 `wsl: 检测到 localhost 代理配置...`。这是 launcher 横幅，不是命令错误；插件不过滤 stderr（过滤会篡改命令真实输出），因此它会出现在工具输出里 |
| `sandbox_permissions` 参数 | 工具 schema 会显示该参数（DSH 权限预设需要执行器声明部署模式），但对 bash **无效**：执行器会丢弃任何策略，传入升级请求不会改变约束。不要用它判断命令是否被沙箱约束（见 8.1） |
| `workdir` 不存在/路径语法不对 | 在 spawn 前被拒绝，错误会写明 `Resolved shell: source "...", family, exe` 和可接受的前缀（`/cygdrive/<d>`、`/<d>`、`/mnt/<d>`），便于模型自行纠正；不会出现只报 `ENOENT` 的情况 |
| `verify: false` | 跳过探测：shell 家族未知、路径语法提示缺失，路径写错也不会被提前发现（见 4.3） |
| `loginShell: true` 的副作用 | 会执行用户 profile 脚本，可能带来额外输出、环境变量变化或更慢的冷启动 |
| preset 覆盖是快照 | 三个内置 preset 的插件列表整份复制自 `presets/` 里的 0.2.2-rc.3 安装原文（0.2.2 起形状变了，rc.2–rc.5 之间才是逐字节相同）；DSH 升级后不会自动合并新行，必须替换快照并重新生成（见 10.4） |
| 快照版本固定 | `presets/source.json` 的 `dshVersion` 必须等于 `@deepseek-ai/dsh-bash-local` 的 devDependency；`check:patch` 会在三者不一致时失败，防止用错版本的 preset 静默生成 |
| prompt section 是 host 全局的 | 本插件的系统提示词 section 在 host 层注册，所以 `minimal` preset（persistent PTY shell）的会话也会看到这段「bash 工具每次全新 shell」的通用说明；在 minimal 下它不描述实际 shell 行为 |
| `wslDistro` 不命中 | 配了 `wslDistro` 但最终解析到 native bash（如 Git Bash）时它不生效，也不会告警 |
| minimal preset | 不支持，见第 7 节 |
| 用户自建 preset | 不覆盖；默认继承 host 层全局 `bash`（除非其用 `tools.restrict` 排除或自带私有 shell） |
| DSH internals | 本插件依赖 `LocalBashExecutor` 的 `protected` 方法（`resolve` / `executeArgv`），DSH 升级若改动这些 internals 需要适配，`pnpm run typecheck` 会先报错 |

## 9. 排障

### 9.1 提示找不到 bash

当所有候选都失败时，工具调用返回聚合错误：先给出配置的 `source`，再逐行列候选的 `标签: 路径 (失败原因)`。失败原因是探测命令 stderr（无 stderr 时用 stdout）压成单行后的尾部摘要，最多 300 字符（实际输出示例）：

```text
vsshell: no usable bash found for source "auto". Tried:
  git-bash: C:\Program Files\Git\bin\bash.exe (not found)
  git-bash: C:\Program Files\Git\usr\bin\bash.exe (not found)
  cygwin: C:\cygwin64\bin\bash.exe (not found)
  wsl: C:\Windows\System32\wsl.exe (Wsl/E_ACCESSDENIED)
```

（示例节选；实际会按解析顺序列出全部候选。）

其他常见形态：

| 错误开头 | 含义 |
|---|---|
| `vsshell: no usable bash found for source "<source>". Tried:` | 所有候选都不存在或探测失败，见下面的逐行原因 |
| `... (<候选>) exit code N without the probe marker` | 可执行文件启动了，但没跑成 bash（例如指向了别的 exe） |
| `... (<候选>) probe timed out after <n>ms` | 探测超时，可调大 `probeTimeoutMs` |
| `vsshell: no bash candidate is available for source "<source>" on <platform>` | 非 Windows 平台（或 `custom` 却没有候选），本插件只面向 win32 |

对应处理：

1. 按错误里的候选路径确认对应 bash 是否安装；
2. 装好 Git Bash / WSL 后直接重试即可（失败不缓存，下次调用重新探测）；
3. 或把 `source` / `bashPath` 指到实际存在的可执行文件。

### 9.2 确认当前用了哪个 bash

- 直接执行 `pwd`：输出 `/c/...` 是 Git Bash，`/mnt/c/...` 是 WSL，`/cygdrive/c/...` 是 Cygwin；
- 执行 `printf '%s\n' "$OSTYPE"`：`msys*` = Git Bash，`cygwin` = Cygwin，`linux-gnu` = WSL；
- 插件解析成功时会写 host 日志；插件的系统提示词也会写明当前生效的来源、可执行文件与家族，可以问模型「现在用的是哪个 bash」；
- 命令失败时错误信息里带候选列表与 stderr 尾部，也可用于定位。

### 9.3 检查 WSL

```powershell
wsl -l -v          # 列出发行版与状态
wsl -d Ubuntu-22.04 --exec bash -lc "echo ok"
```

`-l -v` 列出的名称要原样写进 `wslDistro`。

### 9.4 检查 Git Bash

```powershell
Test-Path 'C:\Program Files\Git\bin\bash.exe'
& 'C:\Program Files\Git\bin\bash.exe' -lc 'echo ok; pwd'
```

### 9.5 强制指定 bash

```yaml
- id: dsh-vsshell
  config:
    source: custom
    bashPath: C:\Program Files\Git\bin\bash.exe
```

```yaml
# WSL 也可以显式指定 wsl.exe 或旧版 bash.exe
- id: dsh-vsshell
  config:
    source: wsl
    bashPath: C:\Windows\System32\wsl.exe
    wslDistro: Ubuntu-22.04
```

非 `custom` 来源下 `bashPath` 也有效：非空时只使用该路径（不再枚举候选）；`verify: true` 时仍会做存在性检查与探测，`verify: false` 时不做任何校验（见 4.3）。

### 9.6 探测慢、启动卡住

`wsl.exe` 或 Git Bash 的冷启动可能很慢，探测会拖慢第一次调用。可选：

1. 调大 `probeTimeoutMs`（默认 `15000`，单位毫秒）；
2. 或设 `verify: false` 跳过探测，直接信任路径。代价见 4.3：失败信息退化为命令执行期的 spawn 错误（如路径写错时是 `ENOENT`），且系统提示词会标注「未探测，家族与路径语法未验证」。

注意：`verify: false` 且给了 `bashPath` 时，该路径**连存在性检查都不做**，写错不会被提前发现。

等待解析也受本次调用自己的 `timeoutMs` 约束：超时会报 `vsshell: bash resolution did not finish within <n>ms; raise probeTimeoutMs or set verify: false`（见第 5 节），这不是命令执行失败。

### 9.7 命令在 stderr 多一行 `wsl:` 警告

见 8.3：这是 `wsl.exe` 的 launcher 横幅，与命令结果无关，不要据此判定命令失败。

### 9.8 回退

没有一条命令能切回 pwsh。正确做法见 3.4：

1. 首选 `plugin_manager` 执行 `remove_bundle @dsh-external/dsh-vsshell` 并重启；
2. 或者手工在 profile 的 `cordis.patch.yml` 里恢复 host 行（重新启用 `pwsh-sandbox` / `tool-pwsh`、禁用 `dsh-vsshell`）并撤销三份 preset 覆盖。

只把 `- id: dsh-vsshell` 设成 `disabled: true` **不是**回退：会变成没有 `ctx.shell`，`bash` 工具不可用而 pwsh 仍被禁用。

### 9.9 安装后仍是 pwsh、`list_agents` 或 PTC 呈现消失

**按症状分开排查：**

| 症状 | 最可能原因 | 排查/修法 |
|---|---|---|
| 仍是 `pwsh`、没有 `bash` | profile 用户层已有 `preset-*` 覆盖行（Web 编辑器保存过 preset），整份 `config.plugins` 盖掉本 bundle 的修正；或安装的是旧 `lib/` | 见下面的 A/B |
| `list_agents` 工具消失、或 `ptc` preset 的 PTC 呈现异常 | 生成/安装的 preset 覆盖来自**旧版本快照或开发源码检出**（0.2.2-rc.3 的 delegation 是 `tool-subagent-control` + `modelSelection`/`modelDiscovery`，ptc 用 `tool-executor-ptc`；旧 rc.5 及以前的快照是 `tool-subagent-list-agents` + `modelSelectionSettings` + `tool-presentation`，混用会丢行） | 检查生成物头部的「目标 DSH 版本」与 `presets/source.json`；按 10.4 换成 0.2.2-rc.3 **安装自带**的快照并重新生成/安装 |
| 设置里没有「Bash 执行器」页，或面板显示「读取配置失败」 | 安装/升级后未重启（host 行 `dsh-vsshell-panel` 与 `client.js` 都只在重启后加载）；或运行在非 Windows 平台（该页仅 win32 启用） | 重启 DSH；确认 `bundles` 里仍有 `@dsh-external/dsh-vsshell` 且 `cordis.patch.yml` 的 insert 含 `dsh-vsshell-panel` 行（见 7 节） |

**A. profile 里有旧的 preset 覆盖**：打开 profile 的 `cordis.patch.yml`，搜索 `- id: preset-standard` / `preset-ptc` / `preset-cordis`。profile 用户层在 bundle 层之后叠加，preset 覆盖又是「整份 `config.plugins` 快照」，所以旧快照会整份替换掉本 bundle 的修正 → `tool-pwsh` 又出现。
修法：删除这三类覆盖行（只保留你确实需要的配置，例如 `- id: dsh-vsshell` + `config`）后重启；或安装/升级后在 Web 编辑器里重新保存 preset，让覆盖行基于当前组合重新生成。

**B. 装的是旧 `lib/`**：改了 `src/` 但没 `pnpm run build`，或 build 失败后仍安装。修法：重新 build，`remove_bundle` 后重新 `install_bundle` 并重启。

**复核办法**：看**合成后**的 preset 内容——`tool-pwsh` 应为 `disabled: true`、`tool-bash` 不应带 `disabled`；0.2.2-rc.3 的 delegation 里应有 `tool-subagent-control`，`tool-subagent` 带 `modelSelection: true`/`modelDiscovery: true`，ptc 应有 `tool-executor-ptc`；生成物头部版本行应为 `0.2.2-rc.3`。

### 9.10 从 GitHub 安装/热安装后的 shell 冲突与本地插件丢失

**症状 A：** 安装时或启动日志出现
`Error: service "shell" has been registered at <SandboxPwshExecutor>`，随后 `bash`/`pwsh` 都没有。

- 原因：`plugin_manager install_bundle` 是**热安装**。本 bundle 的 patch 会禁用 `pwsh-sandbox`，但旧进程里它的执行器可能还没卸载；Cordis 同一 context 只允许一个 `shell` 服务，直接注册就会抛这个错。
- 0.3.2 起插件入口改成**延迟挂载**：检测到 `ctx.shell` 仍被占用时先等待（每 200ms 检查，5s 后输出一条可操作 warning），旧 provider 卸载后自动挂载执行器，**不会再因为这个竞态使整个插件激活失败**。
- 处理：等几秒看 `bash` 工具是否出现；若旧 provider 一直不卸载，**完全退出 DSH 再启动**（重启时组合顺序干净，`pwsh-sandbox` 先被 patch 禁用，不会冲突）。
- 若重启后仍报同一错误：说明还有别的层在提供 `ctx.shell`。在 profile 用户层（最后生效）显式加：
  ```yaml
  - id: pwsh-sandbox
    name: "@deepseek-ai/dsh-pwsh-sandbox"
    disabled: true
  - id: tool-pwsh
    name: "@deepseek-ai/dsh-tool-pwsh"
    disabled: true
  ```
  并确认 profile `package.json` / `bundles` 里 `@dsh-external/dsh-vsshell` 只有一份。

**症状 B：** warning `Cannot find package '@dsh-external/sandbox-extra-roots' imported from ...\profiles\desktop\`，或其它本地插件在安装后消失。

- 原因：pnpm 重算依赖树时，**不是 profile `package.json` 依赖**的手工插件会被移到 `node_modules/.ignored`。这是 pnpm 的行为，与本文插件无关。
- 修复：把该插件写成 profile 依赖再安装一次，例如：
  ```jsonc
  // C:\Users\HP\.dsh\profiles\desktop\package.json
  "dependencies": {
    "@dsh-external/sandbox-extra-roots": "link:../../plugins/sandbox-extra-roots"
  }
  ```
  然后在 profile 目录 `pnpm install`、重启。不再需要它的话，删掉 profile `cordis.patch.yml` 里对应的 `insert` 行即可。

## 10. 开发

### 10.1 仓库结构

| 路径 | 内容 |
|---|---|
| `src/index.ts` | 插件入口：Config schema、`VsshellBashExecutor`（延迟挂载 wrapper）、`VsshellService`（真正的执行器）、系统提示词 section、`describeResolved()`（供面板显示） |
| `src/detect.ts` | 纯函数：候选路径、探测、workdir 翻译、argv 与 `WSLENV` 构造 |
| `src/panel.ts` | 配置面板 Host 半：`/dsh-vsshell-panel` 同源 JSON 路由、引号归一化、经 `configEditor` 写回 profile |
| `client.js` | 配置面板 browser half（Module Loader 懒工厂）：注册 `settings.section` 页面、调用上面的 JSON 路由 |
| `locale/en.json`、`locale/zh.json` | 插件在 Plugin Manager / 设置里的标题与描述（`meta.title` / `meta.description`） |
| `icon.svg` | 插件图标（Plugin Manager / 设置列表） |
| `presets/standard.patch.yml`、`presets/ptc.patch.yml`、`presets/cordis.patch.yml` | 目标 DSH 版本（0.2.2-rc.3）安装自带的 shipped preset **原文快照** |
| `presets/source.json` | 快照清单：`dshVersion`、提取来源、`files` 映射、三份文件的 `sha256`；版本与逐字节断言都以这里为准 |
| `scripts/gen-preset-patch.mjs` | 从 `presets/` 快照（或 `--source` 指定的 DSH 检出）生成 `cordis.patch.yml`（`gen:patch`） |
| `scripts/check.mjs` | `check` 的编排：typecheck → build → 产物语法 → 单测 → patch 校验 |
| `scripts/check-patch.mjs` | 校验 `cordis.patch.yml`：结构断言 + 目标版本断言 + 与生成器输出逐字比较（`check:patch`） |
| `scripts/test.mjs` | 单进程内 import 全部 `tests/*.test.mjs`（沙箱内不能逐文件 spawn） |
| `scripts/smoke-executor.mjs` | 真机冒烟：唯一真正启动 bash 的脚本 |
| `tests/detect.test.mjs` | `detect.ts` 纯函数单测（注入假 `exists` / `probe`） |
| `tests/executor.test.mjs` | 执行器接线单测（假 `subprocess` / `systemPrompt`，`verify: false` 保证零 spawn；含 `execute()` 的 native / WSL 路径，以及热安装时等待旧 `ctx.shell` provider 卸载的 lifecycle 用例） |
| `tests/patch.test.mjs` | patch 结构 / 目标版本 / 目标版本指纹（0.2.2-rc.3 安装形状；rc.2–rc.5 之间才逐字节相同）/ 生成物一致性断言（不写文件、不起 shell） |
| `tests/panel.test.mjs` | 配置面板单测：引号/裸值归一化、校验错误、同源路由的 GET/POST/token/跨站拒绝（假 `webServer` + 假 `configEditor`，零真实网络） |
| `.gitattributes` | 固定 LF（`* text=auto eol=lf`），保证生成物逐字比较不被 CRLF 干扰 |
| `docs/design.md` | 设计与实现约束（事实来源） |
| `cordis.patch.yml` | **生成物**：host 行 + preset 覆盖，不要手改 |

说明：`presets/` 是生成的**输入**（运行时插件不读它），但它也在 `package.json` 的 `files` 白名单里，这样无论是 `link:` 目录安装还是打包后的安装副本，都能用同一份快照复现 `gen:patch` / `check:patch`。

### 10.2 常用命令

| 命令 | 作用 |
|---|---|
| `pnpm run build` | `tsc` 编译到 `lib/`（ESM + 类型声明）；测试与安装都读 `lib/` |
| `pnpm run typecheck` | `tsc --noEmit`，DSH 升级后先跑这个 |
| `pnpm run test` | 单进程内跑 52 个用例（`detect` / `executor` / `patch` / `panel` 四份，**不启动任何真实进程**；先 build） |
| `pnpm run check:patch` | 三段校验：结构（host 行、win32-only insert、三个 preset 覆盖、无 `preset-minimal` 行）+ 目标版本（生成物头部 = `presets/source.json` = devDependency）+ 与生成器输出逐字一致 |
| `pnpm run check` | 提交前的完整门禁：typecheck → build → 产物语法检查 → 单测 → patch 三段校验；自包含，不需要 DSH 源码检出 |
| `pnpm run smoke` | 真机冒烟：起最小 cordis app，跑 `echo` / `pwd` / 退出码 / 双流 / `DSH_*` / 超时 / 后台；必须在**非受限令牌**（danger-full-access）下运行 |
| `pnpm run gen:patch` | 重新生成 `cordis.patch.yml`；默认读 `presets/` 快照，`--source` 可指向其它快照目录或 DSH 源码检出，另有 `--out`、`--check` |

`pnpm run smoke` 支持用环境变量覆盖配置，便于逐来源验证：

```powershell
$env:VSSHELL_SOURCE = 'wsl'; $env:VSSHELL_DISTRO = 'Ubuntu-22.04'; pnpm run smoke
$env:VSSHELL_SOURCE = 'custom'; $env:VSSHELL_BASH_PATH = 'D:\tools\git\bin\bash.exe'; pnpm run smoke
```

（`VSSHELL_LOGIN=0` 可关掉 login shell。）

### 10.3 重新生成 `cordis.patch.yml`

`cordis.patch.yml` 由 `scripts/gen-preset-patch.mjs` 生成，**默认输入是仓库内的 `presets/` 快照**（0.2.2-rc.3 安装自带的 preset 原文），因此日常重新生成不需要任何外部源码检出：

```powershell
pnpm run gen:patch            # 读 presets/，写 cordis.patch.yml
pnpm run gen:patch --check    # 只比较，不写文件；不一致退出码 1
pnpm run check:patch          # 结构 + 目标版本 + 生成物一致性
```

生成规则：读取 preset 的 `insert[0].config`（`id`、`order`、`plugins`）整份复制，对 `tool-bash` 删掉 `disabled`、对 `tool-pwsh` 改成 `disabled: true`，`!!js` 表达式与多行块原样保留。

生成物头部有一行记录目标版本：

```
# 目标 DSH 版本：0.2.2-rc.3；preset 快照来源：presets
```

`--source` 只在升级或临时比对时使用，可以指向另一个 preset 快照目录，或一份 DSH 源码检出（脚本会在其 `packages/bundle/web-app/presets/` 下找 `standard/ptc/cordis.patch.yml`，并用该检出 `package.json` 的 `version` 作为目标版本）：

```powershell
pnpm run gen:patch --source <preset 快照目录或 DSH 源码检出>
```

注意：用外部检出生成却不更新 `presets/` 与 `source.json`，`check:patch` 的版本断言会失败（这是刻意的）。

生成后务必 `git diff cordis.patch.yml` 审核，再跑 `pnpm run check:patch`。

### 10.4 DSH 升级后的流程

目标版本由 `presets/` 快照固定：升级 = **换快照 + 换依赖版本 + 重新生成**，三者必须同一版本。按顺序做：

1. **换快照**：从新版本安装里取出 shipped preset 原文 —— `<安装目录>/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/{standard,ptc,cordis}.patch.yml`，逐字覆盖 `presets/` 下同名文件；更新 `presets/source.json` 的 `dshVersion`、`origin`、`extractedAt`，并用 `Get-FileHash -Algorithm SHA256`（或 `sha256sum`）重算三份文件填入 `sha256`。不要用别的版本的源码检出拼一份「差不多」的快照；sha256 不由你自己算的话，生成器会报「快照被改动」。**minor 升级（如 0.2.1→0.2.2）会改变 preset 形状**（本轮 rc.1：list-agents→tool-subagent-control、modelSelection/modelDiscovery、ptc 用 tool-executor-ptc、新增 plugin-market 等），必须整份替换快照 + 重算 sha256 + 更新测试指纹；只有 rc.2–rc.5 之间是字节相同的。
2. **换依赖版本**：`devDependencies` 里 `@deepseek-ai/dsh-*` 精确改成新版本；`peerDependencies` 也写**精确版本**（不是 `~`）；`@deepseek-ai/cordis` 同步到该 DSH 附带的版本。跑 `pnpm install`。
3. **重新生成**：`pnpm run gen:patch`（默认读 `presets/`），生成物头部版本应自动变成新版本。
4. **跑检查**：`pnpm run check`。`check:patch` 的三段断言会挡住「快照 / 依赖版本 / 生成物」不一致；`typecheck` 会第一个暴露 `LocalBashExecutor` internals 的变化（预算字段有变化按 AGENTS §4.3 同步）。**minor 升级还要核对面板的客户端契约**：本轮 0.2.2-rc.3 的 `settings.section` 只接受 `id`/`order`/`label`，`client.js` 已把原来的 `locale`/`inject` 注册选项改成闭包 + `ctx.locale.subscribe`。
5. **diff 审阅**：`git diff presets/ cordis.patch.yml package.json`，逐项确认新增/删除的 preset 行、`tool-bash` 仍启用、`tool-pwsh` 仍 `disabled: true`、`!!js` 与多行块原样保留、insert 行仍 win32-only。重点核对**版本特征**：0.2.2-rc.3 的指纹是 delegation 里的 `tool-subagent-control` + `modelSelection`/`modelDiscovery`、ptc 的 `tool-executor-ptc`、standard 的 `tool-plugin-manager` 走 `!!js "!ctx.get('profileContext')"`、`tool-fs.applyPatch: false`、`tool-plugin-market`；`tests/patch.test.mjs` 必须按新版本**安装**的真实形状更新。若误用旧/开发源码快照，会出现缺失或旧字段（`tool-subagent-list-agents`、`modelSelectionSettings`、`tool-presentation`）。
6. **重装并插入检查**：`pnpm run build` 后重新 `install_bundle`（或重装 bundle）并重启，按 3.3 的清单验证，重点看 `list_agents` 与 PTC 呈现是否随新 preset 保留。
