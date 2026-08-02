# AI Stack Installer 设计文档

> 日期：2026-08-02
> 状态：已与用户逐节确认，待用户最终审阅

## 一、项目目标

一条命令在 Linux（含 WSL）/ macOS / Windows 上安装「AI Agent 开发工具链」：
探测环境 → 装依赖（Node/Git/PowerShell 7）→ 装 Agent（Claude Code / Codex / Pi / OpenCode）→
注入轻量配置 → 自检报告。可重复执行（幂等）、可校验（doctor）、可卸载（uninstall）。

**使用场景**：公开分发项目（GitHub 仓库 + npm 发布），主要受众在国内（cn 模式为刚需）。

## 二、架构：Node.js 核心 + 双薄入口

**决策背景**：对比「双脚本 + 共享 manifest」（逻辑写两遍、维护重）与「双脚本 + 独立 manifest」
（数据两处漂移），最终选定 Node 核心路线——核心逻辑一份、全平台共用，npm 生态的测试/版本/CI
成熟，与用户现有技术栈一致。

```
ai-stack-installer/            # npm 包仓库（GitHub 公开仓库同名）
├── install.sh                 # Linux/macOS/WSL 薄入口（POSIX sh）
├── install.ps1                # Windows 薄入口（PowerShell 5.1+）
├── package.json               # npm 包（bin: ai-stack）
├── src/
│   ├── cli.ts                 # 子命令解析（install/doctor/uninstall/list）
│   ├── detect.ts              # OS/架构/WSL/已有工具探测
│   ├── prereq.ts              # Node/Git/PowerShell 7 等依赖
│   ├── agents.ts              # manifest 驱动的安装编排
│   ├── configure.ts           # 轻量配置注入（幂等）
│   ├── doctor.ts              # 自检结果表
│   ├── uninstall.ts           # 卸载
│   ├── proxy.ts               # cn 模式（镜像+代理）
│   └── tui.ts                 # 交互向导（@clack/prompts）
├── manifest.json              # 工具元数据（唯一事实来源）
├── config/                    # 配置模板（settings.json / config.toml）
└── test/                      # vitest 单测 + 平台集成测试
```

**入口脚本职责**（install.sh / install.ps1）：
1. 探测已有 Node（≥20），没有则安装（Linux/macOS: fnm；Windows: winget 装 Node LTS 后刷新会话 PATH）
2. 调用 `npx -y ai-stack-installer <args>`；npx 失败回退 `npm i -g ai-stack-installer`
3. 透传参数（`-y` / `-i`）

## 三、CLI 子命令

| 子命令 | 职责 |
|---|---|
| `ai-stack install` | 完整流程：detect → prereq → agents → configure → doctor 汇总 |
| `ai-stack doctor` | 只跑自检，输出结果表（✓/✗ + 版本 + 修复建议），可重复执行 |
| `ai-stack uninstall` | 按 manifest 卸载 + 清理 rc 标记块 + 移除 ~/.ai-stack |
| `ai-stack list` | 打印 manifest 工具清单及安装状态 |

参数：`-y`（跳过向导直装）、`-i`（强制进向导）、`--cn`（强制 cn 模式）、
`-p/--profile minimal\|full`（非交互时的工具快捷默认值）。

## 四、交互设计

### 交互策略

| 执行方式 | 行为 |
|---|---|
| 终端直接执行（有 TTY） | **默认进向导** |
| curl 管道 / CI（无 TTY） | 自动直装，输出提示「非交互环境，使用默认配置」（兼容路径，README 不主推） |
| `-y` | 强制直装 |
| `-i` | 强制进向导 |

### 向导流程（6 步）

```
◆ ① 工具多选        空格切换 / 回车确认 / a=全选 / c=仅 Claude
   ☑ claude-code   ☑ codex   ☐ pi   ☑ opencode
◆ ② 网络            检测到本地代理时询问是否启用 cn 模式（镜像+代理）
◆ ③ 额外工具        是否安装 CC Switch（Claude Code 供应商切换器，桌面版）
◆ ④ 汇总确认        将安装 N 个工具 + 将写入的文件列表；确认/返回
◆ ⑤ 执行            逐项进度；失败时 [重试] [跳过] [终止] 三选一
◆ ⑥ 报告            doctor 结果表 + 修复建议 + 成功/失败计数
```

重复执行时①步显示已装工具勾选态，默认跳过已装的。

## 五、工具清单与安装口径（manifest.json）

### 核心四件套

| 工具 | check | Linux/macOS 主通道 | Windows 主通道 | fallback | uninstall |
|---|---|---|---|---|---|
| Claude Code | `claude --version` | `curl -fsSL https://claude.ai/install.sh \| bash` | `irm https://claude.ai/install.ps1 \| iex` | `npm i -g @anthropic-ai/claude-code` | `npm uninstall -g @anthropic-ai/claude-code` |
| Codex | `codex --version` | `curl -fsSL https://chatgpt.com/codex/install.sh \| sh` | `irm https://chatgpt.com/codex/install.ps1 \| iex` | `npm i -g @openai/codex`（必须带 @openai/ 作用域） | `npm uninstall -g @openai/codex`（官方脚本安装时按官方文档路径卸载） |
| Pi | `pi --version` | `curl -fsSL https://pi.dev/install.sh \| sh` | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` | 同 Windows 通道 | npm 卸载 |
| OpenCode | `opencode --version` | `curl -fsSL https://opencode.ai/install \| bash` | `npm i -g opencode-ai` | 同 Windows 通道 | npm 卸载 |

> 所有官方一键地址会随版本变动，**主通道失败必须自动降级到 fallback（npm）**，
> 这是脚本能长期存活的关键。

### 可选工具：CC Switch（桌面 GUI 版，farion1231/cc-switch）

默认不装，向导③步用户明确选择才安装；非交互模式不装。

| 平台 | 安装口径 |
|---|---|
| Windows | 主：`winget install --id farion1231.CC-Switch --exact --silent`；降级：GitHub Releases 下载 .msi + `msiexec /i xxx.msi /quiet` |
| macOS | `brew install --cask cc-switch` |
| Linux | 下载 .deb/.rpm/.AppImage（按发行版） |

- 网络标记：**`needsProxy: true`**（winget 源与 GitHub Releases 均在海外）
- 检查命令：GUI 应用无 `--version`，改为检查安装路径/注册表（实现细节）

### manifest.json 形状（关键字段）

```json
{
  "id": "claude-code",
  "bin": "claude",
  "check": "claude --version",
  "minVersion": "2.0",
  "needsProxy": true,
  "npmMirror": false,
  "linux":  "curl -fsSL https://claude.ai/install.sh | bash",
  "windows": "irm https://claude.ai/install.ps1 | iex",
  "fallback": "npm i -g @anthropic-ai/claude-code",
  "uninstall": "npm uninstall -g @anthropic-ai/claude-code",
  "optIn": false
}
```

- `needsProxy: true` —— 官方安装器直连海外（claude.ai / chatgpt.com / storage.googleapis.com），**镜像救不了必须走代理**
- `npmMirror: true` —— 纯 npm 安装（Pi / OpenCode），走 npmmirror 即可
- `optIn: true` —— CC Switch 这类默认不装的可选工具

## 六、cn 模式（国内为主）

- 启用时：npm registry → `registry.npmmirror.com`；代理 → `127.0.0.1:7890`（端口可配）
- 向导②步检测本地代理：探测 7890 / 7897 / 10809 等常见端口，通则询问；不通则提示「需自行开代理」
- `--cn` 参数强制启用；非交互模式默认不启用（除非显式传参）

## 七、配置注入（轻量，幂等）

| 对象 | 写入 | 策略 |
|---|---|---|
| Claude Code | `~/.claude/settings.json` | 不存在才写（跳过 onboarding + 关遥测），不覆盖已有 |
| Codex | `~/.codex/config.toml` | 同上 |
| Shell | `~/.bashrc` / `~/.zshrc` / `$PROFILE` | `# >>> ai-stack >>>` 标记块包裹，重复执行不追加 |
| alias | `c='claude'`、`proxy_on` / `proxy_off` 函数 | 随标记块 |

**密钥处理**：不涉及。各 Agent 登录（`claude login`、codex 内 Sign in）由用户自行完成。

## 八、uninstall 设计

| 清理项 | 方式 |
|---|---|
| Agent（4 个 + CC Switch） | 按 manifest 的 `uninstall` 命令逐个执行 |
| CC Switch | `winget uninstall --id farion1231.CC-Switch` |
| 配置 | 移除 rc 标记块；删除脚本写入的文件（不删用户已有文件） |
| `~/.ai-stack` | 删除（日志目录） |
| Node/Git/pwsh 等 prereq | **不卸载**（通用依赖），报告提示 |

默认交互确认（destructive），`-y` 跳过。

## 八·五、脚本存放与清理（透明性）

安装报告（向导⑥步）与 uninstall 报告必须输出**文件位置清单**，明示每个文件在哪、怎么删：

| 文件 | 位置 | 清理方式 |
|---|---|---|
| install.sh / install.ps1（入口脚本） | 用户下载时指定位置（README 建议 `~/.ai-stack/install.sh`，统一管理） | 手动删除，或 uninstall 时提示 |
| npm 核心包（npx 缓存） | `~/.npm/_npx/<hash>/` | 手动删除 / `npm cache clean` |
| 日志与状态 | `~/.ai-stack/` | `ai-stack uninstall` 删除 |
| 配置模板写入文件 | `~/.claude/settings.json` 等 | 见 uninstall 章节（只删脚本写入的） |

## 九、CI 与测试

**GitHub Actions**（每次 push 全新机器实测，一键脚本唯一靠谱的回归测试）：
- 矩阵：`ubuntu-latest` + `windows-latest` + `macos-latest`
- 每个 job：跑 install.sh/install.ps1（`-y`）→ 断言 4 个 agent 的 check 通过 → `ai-stack doctor` 退出码 0
- 额外一个 job 验证 cn 模式（镜像）路径

**本地验证策略（仓库建立前）**：Windows 真机验证 Windows 路径；WSL 内验证 Linux 路径；
macOS 无本地环境，代码写好待 CI 矩阵验证。

**单测**（vitest）：detect 逻辑、manifest 解析、幂等 helper、配置写入（临时 HOME 隔离）、TTY 检测分支。

## 十、分发

- GitHub 公开仓库：`ai-stack-installer`
- npm 发布：`ai-stack-installer`（bin: `ai-stack`），语义化版本
- README 顶部主推「下载后运行」：

```bash
# Linux / macOS / WSL
curl -fsSL https://raw.githubusercontent.com/<you>/ai-stack-installer/main/install.sh -o install.sh
bash install.sh          # 交互向导
bash install.sh -y       # 跳过向导直接安装
```

```powershell
# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/<you>/ai-stack-installer/main/install.ps1 -OutFile install.ps1
.\install.ps1            # 交互向导
.\install.ps1 -y         # 跳过向导直接安装
```

> `<you>` 为 GitHub 用户名占位符，仓库创建后替换。

- 版本锁（`claude@2.1.77` 这类固定版本）列为**后续迭代**，第一版不阻塞。

## 十一、后续迭代（不在第一版范围）

- 版本锁支持
- MCP 配置模板注入
- Dockerfile / devcontainer 版本
- 更多 Agent 接入（OpenClaw 等，manifest 架构下加工具不改逻辑）
