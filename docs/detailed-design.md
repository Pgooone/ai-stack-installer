# AI Stack Installer — 详细设计

> 按模块给出接口、数据结构、依赖与关键逻辑。子 Agent 实现某模块时只读本文件对应小节 + 设计文档。
> 项目根：`ai-stack-installer/`（即本仓库根）。运行环境：Node ≥ 20，TypeScript 编译产物 `dist/`。

## 共享模块

### src/types.ts（无依赖）

```ts
export type Platform = 'windows' | 'linux' | 'macos';
export interface DetectInfo {
  platform: Platform;
  isWsl: boolean;        // linux 且 /proc/version 含 microsoft
  arch: string;          // os.arch() 原样
  home: string;          // os.homedir()
}
export interface ToolSpec {
  id: string;            // 'claude-code'
  bin: string;           // 'claude'（check 用）
  check: string;         // 'claude --version'
  minVersion?: string;   // 语义化版本下限，不满足视为未装
  needsProxy?: boolean;  // 官方安装器直连海外，必须代理
  npmMirror?: boolean;   // 纯 npm 安装，可走 npmmirror
  optIn?: boolean;       // CC Switch 等默认不装的可选工具
  linux?: string;        // 各平台安装命令（POSIX shell）
  macos?: string;        // 缺省回退 linux
  windows?: string;      // PowerShell 命令
  fallback?: string;     // 主通道失败后的 npm 安装命令
  uninstall?: string;    // 卸载命令（按平台可分别给出 uninstall.windows 等）
  uninstallWindows?: string;
}
export interface Manifest { prereq: ToolSpec[]; agents: ToolSpec[]; }
export type InstallStatus = 'ok' | 'skipped' | 'failed' | 'missing';
export interface ToolState { id: string; bin: string; installed: boolean; version?: string; }
```

### src/utils.ts（依赖：types）

- `has(bin: string): Promise<boolean>` — `command -v`（POSIX）/ `Get-Command`（Windows）探测
- `exec(cmd: string, opts?): Promise<{code, stdout, stderr}>` — 跨平台执行命令
  - 关键：Windows 用 `powershell -NoProfile -Command "<cmd>"` 包一层；POSIX 用 `bash -c`；统一非 shell 参数透传
- `retry<T>(fn, times, delayMs): Promise<T>` — 指数退避重试（1x, 2x, 4x…）
- `versionGte(actual: string, min: string): boolean` — 语义化版本比较（纯数字，忽略 v 前缀）
- `detectTty(): boolean` — `process.stdout.isTTY && !process.env.CI`
- `spinner(text)` — clack 的 spinner 封装（实现层直接引 clack，不抽象）

### src/logger.ts（依赖：utils）

- `log/ok/fail(info)(msg)` — 彩色输出 + 追加 `~/.ai-stack/install.log`（UTF-8）
- 颜色：信息青、成功绿、失败红；无 TTY 时自动去色（clack 或自判 `isTTY`）

### src/fs-locations.ts（依赖：types）

- `aiStackDir()` = `~/.ai-stack`
- `logFile()` = `~/.ai-stack/install.log`
- `rcFiles(): string[]` — linux: `~/.bashrc`、`~/.zshrc`（存在才列）；windows: `$PROFILE`（pwsh 的 Profile.CurrentUserAllHosts 路径）
- `configFiles(): {path, template}[]` — claude settings.json、codex config.toml（按平台展开 `~`）
- `markers` = `# >>> ai-stack >>>` / `# <<< ai-stack <<<`（幂等块标记）
- `npxCacheDir()` = `~/.npm/_npx`（透明性报告用）

### src/manifest.ts（依赖：types, fs-locations）

- `loadManifest(): Promise<Manifest>` — 读仓库内 `manifest.json`（打包进 npm 包，`__dirname` 相对定位）
- `validateManifest(m)` — 启动校验：id 唯一、check/bin 非空、每平台至少一条安装路径；校验失败直接退出并给修复信息
- `getAgent(m, id)` / `getPrereq(m, id)`
- `installCmd(tool, platform, cnMode): string` — 按平台选命令，cn 模式下 npm 命令自动加 `--registry=https://registry.npmmirror.com`
- `stateOf(tool): Promise<ToolState>` — 跑 check 命令取版本（首行），失败/超时视为未装

### src/detect.ts（依赖：types, utils）

- `detect(): Promise<DetectInfo>` — platform/arch/home；linux 下 `cat /proc/version` 含 `microsoft` → isWsl=true
- `detectNode(): Promise<ToolState>` — `node -v` + 主版本比较（≥20 才算可用）
- `detectTools(manifest): Promise<ToolState[]>` — 批量 stateOf（prereq + agents + optIn 工具）

## 流程模块

### src/proxy.ts（依赖：types, utils, logger）

- `cnMode = { enabled: boolean; registry: string; proxyHost: string; proxyPort: number }`
- `detectLocalProxy(): Promise<{host, port} | null>` — 依次探测 127.0.0.1:7890/7897/10809（TCP connect，超时 500ms；Windows 用 net.connect）
- `applyCnMode(mode, env)` — 返回注入后的 env：`HTTP_PROXY/HTTPS_PROXY/npm_config_registry`
- `npmRegistryFor(useCn): string` — 直连 npmjs.org / npmmirror.com

### src/prereq.ts（依赖：manifest, detect, utils, logger, proxy）

- `ensurePrereqs(ctx): Promise<void>` — 遍历 manifest.prereq：
  - node：不满足 ≥20 → linux/macos 走 fnm（`curl -fsSL https://fnm.vercel.app/install | bash` + `fnm install --lts` 并导出 PATH）；windows 走 `winget install --id OpenJS.NodeJS.LTS -e --silent`，装完**重读 Machine+User PATH 刷新会话**
  - git / pwsh（仅 windows）：winget / apt 安装
- 关键：每个 prereq 失败**不中断**，记入失败列表，最后统一汇报

### src/agents.ts（依赖：manifest, detect, utils, logger, proxy）

- `installAgent(tool, ctx): Promise<'ok'|'failed'|'skipped'>`：
  1. `stateOf(tool)` 已装 → skipped（交互模式向导①里已展示勾选态）
  2. 主通道执行 → 校验（check 通过）→ ok
  3. 失败且 `fallback` 存在 → 降级执行（cn 模式下 npm 加镜像）→ ok
  4. 都失败 → failed，记录错误输出尾部
- `uninstallAgent(tool, platform): Promise<void>` — 按 uninstall/uninstallWindows 执行

### src/configure.ts（依赖：fs-locations, types, utils, logger）

- `writeConfigFiles(manifest, platform, force?): Promise<{written: string[]}>` — 每个 configFiles() 模板：目标不存在才写（除非 force）；返回实际写入清单
- `writeAliasBlock(platform): Promise<{rcFile, action: 'written'|'exists'|'skipped'}>` — 标记块幂等：
  - 内容：`alias c='claude'`、`proxy_on(){ export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890; }`、`proxy_off(){ unset ...; }`
  - 已有标记块 → 跳过；rc 文件不存在 → 创建
- `collectFileReport(): Promise<FileReport[]>` — 透明性报告：所有写入位置 + 删除方式（uninstall 用）

### src/doctor.ts（依赖：manifest, detect, logger, types）

- `runDoctor(manifest): Promise<number>` — 逐个 stateOf 输出表格行，退出码 = 失败数 > 0 ? 1 : 0
- 表格：`工具 | 版本 | 状态`；失败行附建议（needsProxy 且未开代理 → 「建议启用 cn 模式/代理后重试」）

## 编排层

### src/tui.ts（依赖：clack/prompts, manifest, detect, proxy, configure, agents, doctor, logger）

- `runWizard(ctx): Promise<WizardResult>` — 6 步：
  1. `multiselect` 工具（预选未装的非 optIn 工具；`a` 全选 `c` 仅 claude 用 clack 的 hint 说明；已装的置灰标 `(已装 x.y.z)`）
  2. `select` 网络：`detectLocalProxy()` 有结果 → 询问「启用 cn 模式（镜像+代理）？」；无 → 提示需自行开代理（选项仍可启用）
  3. `confirm` CC Switch（optIn 工具）
  4. `confirm` 汇总（将安装 N 个 / 写入文件列表 / 跳过项）→ 不确认可返回 ①
  5. 逐项执行（clack spinner + `retry/跳过/终止` 三选一 `select`）
  6. `runDoctor` + 文件位置清单（`log.message`）
- 失败三选一终止 → 立即退出并保留已装部分

### src/uninstall.ts（依赖：agents, configure, fs-locations, manifest, tui, doctor）

- `runUninstall(ctx): Promise<number>` — 交互确认（默认 N，`-y` 跳过）→ 逐个 `uninstallAgent` → `removeAliasBlock` → 删除脚本写入的 config 文件（**只删无用户修改的，先 diff 模板**；实现简化：仅删除本脚本创建过的文件，记录在 ~/.ai-stack/installed.json）→ 删 `~/.ai-stack` → 输出文件位置清单与提示（Node/Git 未卸载）
- **记录文件**：install 成功时把「本脚本创建的配置文件清单」写入 `~/.ai-stack/installed.json`，uninstall 只删清单内文件

### src/cli.ts（依赖：全部；入口 bin）

- 参数：`-y/--yes`、`-i/--interactive`、`--cn`、`-p/--profile minimal|full`（非交互快捷：minimal=仅 claude-code，full=全部非 optIn）
- 模式选择：`interactive = (-i) || (!-y && detectTty())`
- 子命令：
  - `install`：detect → 向导或直装（prereq → agents → configure → doctor）→ 文件位置清单 → 写 installed.json
  - `doctor`：runDoctor
  - `uninstall`：runUninstall
  - `list`：detectTools 表格输出
- `main()` 顶层 try/catch：错误 → 红字输出 → exit 1；exit code 汇总安装失败数

## 薄入口

### install.sh（POSIX sh，无依赖）

1. 日志到 ~/.ai-stack/install.log
2. `has node` 且 ≥20 → 跳过；否则 fnm 安装并 export PATH
3. `npx -y ai-stack-installer "$@"`（失败回退 `npm i -g ai-stack-installer && ai-stack "$@"`）
4. 透传 `-y/-i/--cn/-p`
5. 结尾提示：脚本位置 + 可删除方式（透明性）

### install.ps1（PowerShell 5.1+）

1. `[Console]::OutputEncoding = UTF8`
2. node 不满足 → `winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements`，**重读 Machine+User PATH**
3. `npx -y ai-stack-installer @args`（失败回退 npm i -g）

## manifest.json（仓库根，打包进 npm）

- `prereq`: node(≥20)/git/pwsh(仅 windows)
- `agents`: claude-code / codex / pi / opencode（needsProxy/npmMirror 按设计文档第五节）
- `optIn`: cc-switch（windows: winget farion1231.CC-Switch，fallback GitHub Releases msi；macos: brew cask；linux: deb/rpm/AppImage 下载——实现时标注「待 CI 验证」）

## config/ 模板（仓库根）

- `claude.settings.json`：`{ hasCompletedOnboarding: true, env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } }`
- `codex.config.toml`：空骨架注释（不含任何密钥）

## 测试策略（vitest）

- 单测隔离真实环境：`home` 注入临时目录（fs-locations 可传 home 参数）；命令执行用 `utils.exec` mock
- 覆盖：manifest 校验/命令选择（含 cn 镜像注入）、版本比较、detect（mock os）、configure 幂等（两次写不追加）、alias 标记块、proxy 端口探测（mock net.connect）、cli 模式选择分支
- 不 mock 的场景：真实 Windows 手工验证（向导/直装/卸载）；WSL 里验证 linux 路径（node/git 探测 + 配置写入）
