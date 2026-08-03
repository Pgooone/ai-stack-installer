# AI Stack Installer

一条命令在 **Windows / Linux（含 WSL）/ macOS** 上安装 AI Agent 开发工具链：
探测环境 → 装依赖（Node/Git/PowerShell 7）→ 装 Agent → 注入轻量配置 → 自检报告。
可重复执行（幂等）、可校验（doctor）、可卸载（uninstall）。

## 快速开始

```bash
# Linux / macOS / WSL
curl -fsSL https://raw.githubusercontent.com/Pgooone/ai-stack-installer/main/install.sh -o install.sh
bash install.sh          # 交互向导：功能选择 / 工具 / 网络 / CC Switch
bash install.sh -y       # 跳过向导，直接安装（默认全量工具）
```

```powershell
# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/Pgooone/ai-stack-installer/main/install.ps1 -OutFile install.ps1
.\install.ps1            # 交互向导
.\install.ps1 -y         # 跳过向导，直接安装
```

> 入口脚本只负责「装 Node ≥20 + 拉起 npm 包」，安装逻辑在 `ai-stack-installer` 包内。
>
> **国内网络自动适配**：入口脚本会先探测 npmjs.org 是否可达——不可达（无代理）时自动使用
> npmmirror 镜像拉取核心包；拉取失败也会自动镜像重试。已有代理环境变量时保持官方源。

## 支持的工具

| 工具 | 说明 | 网络要求 |
|---|---|---|
| Claude Code | 官方安装器优先，失败降级 npm | 官方安装器需代理（`needsProxy`） |
| Codex CLI | 同上 | 同上 |
| Pi | 直接 npm 安装（官方安装器为交互式，不适合 `-y` 直装） | 可走 npm 镜像 |
| OpenCode | 同上 | 可走 npm 镜像 |
| CC Switch（可选） | Claude Code 供应商切换器（桌面 GUI），向导中询问 | 需代理（winget 源/GitHub Releases） |

## 功能选择（交互向导第一步）

```
◆ 选择要执行的操作
  ◉ 安装 AI Agent（已装自动跳过）
  ○ 更新系统组件（Node / Git / PowerShell 升级到最新）
  ○ 全部执行（先更新组件，再安装 Agent）
```

也可用 `ai-stack update` 子命令更新系统组件（交互模式会先检测可用更新再让你选择）：

```bash
# 推荐：直接拉最新版再更新（避免本地旧版入口脚本/缓存问题）
npx -y ai-stack-installer@latest update
```

```bash
ai-stack update        # 交互：检测 → 勾选要更新的组件
ai-stack update -y     # 非交互：全部更新
ai-stack update --cn   # 走镜像/代理更新
```

> 注意：Windows 上部分组件升级（如 Git/PowerShell）需要管理员权限；
> 「无可用升级」会正常提示不算失败。

### PowerShell 7 集成（Windows）

**安装方式**：官方 **.msi** 安装包（GitHub Releases 下载 + 静默安装，含完整终端集成）——
MSI 下载失败时自动降级 winget。需代理访问 GitHub Releases。

安装/更新 PowerShell 后脚本自动执行（幂等）：
- 把 PowerShell 7 路径（`C:\Program Files\PowerShell\7`）提升到**用户 PATH 首位**——确保新终端默认调用 pwsh 7 而非旧版
- 若安装了 Windows Terminal，将其 `defaultProfile` 设为 PowerShell 7（保留你已有的配置与注释）
- pwsh profile 写入 UTF-8 编码设置（防中文乱码）

## 升级与清缓存

脚本每次运行会显示版本号并自动检查新版本（发现新版会提示）：

```powershell
# 一键升级（清缓存 + 全局安装最新版）
ai-stack self-update

# 或直接跑最新版（绕开本地旧入口脚本）
npx -y ai-stack-installer@latest
```

**如果一直跑旧版本**（版本号没变），是 npx 缓存残留——`npm cache clean` **清不掉** `_npx` 目录（独立缓存），需要手动清：

```powershell
# 清 npx 缓存（关键命令）
Remove-Item "$env:LOCALAPPDATA\npm-cache\_npx" -Recurse -Force
```

> 新版本脚本执行完毕会自动清理 npx 缓存 + 入口脚本（`AI_STACK_KEEP=1` 可保留），
> 正常使用不会累积旧缓存；只有早期版本残留才需要手动清一次。

## 参数

| 参数 | 说明 |
|---|---|
| `-y, --yes` | 跳过向导直装（管道/CI 自动等效） |
| `-i, --interactive` | 强制进入交互向导 |
| `--cn` | 启用 cn 模式：npm 镜像（npmmirror）+ 代理（默认 127.0.0.1:7890） |
| `-p, --profile minimal\|full` | 非交互快捷：minimal=仅 Claude Code，full=全部（默认） |

## cn 模式（国内网络）

- 交互向导会探测本地代理（7890 / 7897 / 10809 等常见端口），检测到则询问是否启用
- `needsProxy` 工具（Claude Code / Codex / CC Switch 官方安装器）直连海外，**镜像救不了，必须走代理**
- `npmMirror` 工具（Pi / OpenCode）走 npmmirror 即可

## 文件位置与清理（透明性）

安装/卸载报告会输出完整文件位置清单：

| 文件 | 位置 | 清理方式 |
|---|---|---|
| 入口脚本 | 下载时指定位置（建议 `~/.ai-stack/install.sh`） | 手动删除 |
| npm 缓存 | `~/.npm/_npx/` | 手动删除 / `npm cache clean` |
| 日志与安装记录 | `~/.ai-stack/` | `ai-stack uninstall` 删除 |
| 配置模板写入文件 | `~/.claude/settings.json`、`~/.codex/config.toml`、rc 标记块 | `ai-stack uninstall` 只删本脚本写入的 |

## WSL 使用提示

- WSL 默认继承 Windows PATH——若 Windows 侧也装了同款工具（npm 全局等），`command -v` 可能命中 Windows 版本。安装后请确认新终端里 `which claude` 指向 WSL 路径（npm 全局 bin，如 `~/.npm-global/bin` 或 fnm 的 node bin）
- 脚本自己安装 Node 时（fnm 分支）会自动配置 PATH；手动安装 Node 的需自行把 bin 加入 PATH，否则安装的工具在新终端里可能解析到 Windows 垫片

## 卸载

```bash
ai-stack uninstall        # 交互确认（默认拒绝）
ai-stack uninstall -y     # 跳过确认
```

卸载内容：4 个 Agent + CC Switch（若装过）、rc 标记块（aliases/proxy 函数）、脚本写入的配置文件、`~/.ai-stack`。**Node/Git/PowerShell 为通用依赖，不卸载**。

## 开发

```bash
npm install
npm run build      # tsc → dist/
npm test           # vitest（171+ 用例）
npm run lint       # eslint
```

架构与设计：见 [docs/](docs/)（需求 / 概要设计 / 详细设计）。

## License

MIT
