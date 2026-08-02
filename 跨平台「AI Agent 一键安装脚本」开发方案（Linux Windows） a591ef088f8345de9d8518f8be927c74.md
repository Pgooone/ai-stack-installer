# 跨平台「AI Agent 一键安装脚本」开发方案（Linux / Windows）

> 目标：一条命令，在 Linux（含 WSL）和 Windows 上装好「开发三件套（运行时/终端/网络）」+「Agent 本体（Claude Code、Codex、Pi、OpenCode…）」+「统一配置注入」，并且可重复执行、可校验、可卸载。
> 

## 一、先把问题拆清楚：一键脚本到底要做 5 件事

1. **探测环境（detect）**：OS / 架构 / 是否 WSL / 已有 Node、Git、包管理器 / 是否需要代理。
2. **装依赖（prereq，也就是你说的“三件套”）**：运行时（Node.js LTS + npm/pnpm）、版本控制与 Shell（Git、PowerShell 7 / bash）、辅助工具（ripgrep、jq、uv/Python 可选）。
3. **装 Agent 本体（agents）**：Claude Code、Codex、Pi、OpenCode、OpenClaw… 每个一个安装函数。
4. **注入配置（configure）**：settings.json / config.toml / MCP 配置 / alias / 代理环境变量。
5. **自检与收尾（doctor）**：逐个 `--version`，输出一张结果表，失败项给修复建议。

把这 5 步拆成 5 个函数，是这类脚本不烂尾的关键。不要写成一条几百行的线性脚本。

---

## 二、架构：清单驱动（manifest-driven），而不是把命令硬编码

核心思路：**脚本是引擎，工具列表是数据**。加一个新 Agent 只改 JSON，不改脚本逻辑。

```
ai-stack-installer/
├── install.sh              # Linux/macOS/WSL 入口（POSIX sh 兼容）
├── install.ps1             # Windows 入口（PowerShell 5.1+ 兼容写法）
├── manifest.json           # 所有工具的元数据：安装方式/检测命令/卸载命令
├── lib/
│   ├── common.sh           # 日志、重试、探测、幂等 helper
│   └── common.ps1
├── profiles/
│   ├── minimal.json        # 只装 claude
│   ├── full.json           # 全家桶
│   └── cn.json             # 国内网络：走镜像 + 代理
├── config/
│   ├── claude.settings.json    # 模板（不含密钥）
│   ├── codex.config.toml
│   └── mcp.json
└── doctor.sh / doctor.ps1
```

### manifest.json 的形状

```json
{
  "prereq": [
    { "id": "node",  "check": "node -v",  "minVersion": "20",
      "linux": "curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts",
      "windows": "winget install --id OpenJS.NodeJS.LTS -e --silent" },
    { "id": "git",   "check": "git --version",
      "linux": "sudo apt-get install -y git",
      "windows": "winget install --id Git.Git -e --silent" },
    { "id": "pwsh",  "check": "pwsh -v", "onlyOn": "windows",
      "windows": "winget install --id Microsoft.PowerShell -e --silent" }
  ],
  "agents": [
    {
      "id": "claude-code", "bin": "claude", "check": "claude --version",
      "linux":   "curl -fsSL https://claude.ai/install.sh | bash",
      "windows": "irm https://claude.ai/install.ps1 | iex",
      "fallback": "npm i -g @anthropic-ai/claude-code",
      "uninstall": "npm uninstall -g @anthropic-ai/claude-code"
    },
    {
      "id": "codex", "bin": "codex", "check": "codex --version",
      "linux":   "curl -fsSL https://chatgpt.com/codex/install.sh | sh",
      "windows": "powershell -ExecutionPolicy ByPass -c \"irm https://chatgpt.com/codex/install.ps1 | iex\"",
      "fallback": "npm i -g @openai/codex"
    },
    {
      "id": "pi", "bin": "pi", "check": "pi --version",
      "linux":   "curl -fsSL https://pi.dev/install.sh | sh",
      "windows": "npm i -g --ignore-scripts @earendil-works/pi-coding-agent",
      "fallback": "npm i -g --ignore-scripts @earendil-works/pi-coding-agent"
    },
    {
      "id": "opencode", "bin": "opencode", "check": "opencode --version",
      "linux":   "curl -fsSL https://opencode.ai/install | bash",
      "windows": "npm i -g opencode-ai"
    }
  ]
}
```

---

## 三、各工具当前的官方安装口径（写进 manifest 前先核对）

| 工具 | Linux / macOS | Windows | 备选（跨平台） |
| --- | --- | --- | --- |
| Claude Code | `curl -fsSL https://claude.ai/install.sh | bash` | `irm https://claude.ai/install.ps1 | iex` 或 `winget install Anthropic.ClaudeCode` | `npm i -g @anthropic-ai/claude-code` |
| Codex CLI | `curl -fsSL https://chatgpt.com/codex/install.sh | sh` | `powershell -ExecutionPolicy ByPass -c "irm https://chatgpt.com/codex/install.ps1 | iex"` | `npm i -g @openai/codex`（注意必须带 `@openai/` 作用域） |
| Pi | `curl -fsSL https://pi.dev/install.sh | sh` | 官方安装器只覆盖 Linux/macOS，Windows 走 npm | `npm i -g --ignore-scripts @earendil-works/pi-coding-agent` |
| OpenCode | `curl -fsSL https://opencode.ai/install | bash` | npm | `npm i -g opencode-ai` |
| OpenClaw | 官方脚本 | `powershell -c "irm https://openclaw.ai/install.ps1 | iex"` | `npm i -g openclaw` |

> ⚠️ 这些一键地址会随版本变动。脚本里**不要只写死一条路径**：每个工具都配 `fallback`（一般是 npm），主路径失败自动降级，这是脚本能长期活着的关键。
> 

---

## 四、Linux 入口脚本（[install.sh](http://install.sh) 骨架）

```bash
#!/usr/bin/env bash
set -Eeuo pipefail

REPO_RAW="https://raw.githubusercontent.com/<you>/ai-stack-installer/main"
LOG="${HOME}/.ai-stack/install.log"
mkdir -p "$(dirname "$LOG")"

log()  { printf '\033[36m[*]\033[0m %s\n' "$*" | tee -a "$LOG"; }
ok()   { printf '\033[32m[✓]\033[0m %s\n' "$*" | tee -a "$LOG"; }
fail() { printf '\033[31m[✗]\033[0m %s\n' "$*" | tee -a "$LOG"; }

# ---------- 1. detect ----------
OS="linux"; IS_WSL=0
grep -qi microsoft /proc/version 2>/dev/null && IS_WSL=1
ARCH="$(uname -m)"
log "OS=$OS ARCH=$ARCH WSL=$IS_WSL"

# 可选代理（国内环境）
if [ "${USE_PROXY:-0}" = "1" ]; then
  PROXY_HOST="${PROXY_HOST:-127.0.0.1}"; PROXY_PORT="${PROXY_PORT:-7890}"
  export http_proxy="http://${PROXY_HOST}:${PROXY_PORT}"
  export https_proxy="$http_proxy"
  log "proxy on -> $http_proxy"
fi

# ---------- 2. helpers ----------
has() { command -v "$1" >/dev/null 2>&1; }

retry() {  # retry <次数> <命令...>
  local n=$1; shift
  local i=1
  until "$@"; do
    [ $i -ge "$n" ] && return 1
    log "重试 $i/$n ..."; i=$((i+1)); sleep $((i*2))
  done
}

install_tool() {  # install_tool <bin> <主命令> <降级命令>
  local bin="$1" primary="$2" fb="${3:-}"
  if has "$bin"; then ok "$bin 已存在，跳过（$($bin --version 2>/dev/null | head -1)）"; return 0; fi
  log "安装 $bin ..."
  if retry 2 bash -c "$primary"; then ok "$bin 安装完成"; return 0; fi
  if [ -n "$fb" ]; then
    log "$bin 主通道失败，降级：$fb"
    retry 2 bash -c "$fb" && { ok "$bin 降级安装完成"; return 0; }
  fi
  fail "$bin 安装失败"; return 1
}

# ---------- 3. prereq ----------
has git || sudo apt-get update -y && sudo apt-get install -y git curl ripgrep jq
if ! has node || [ "$(node -v | tr -d 'v' | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"; eval "$(fnm env)"
  fnm install --lts && fnm default lts-latest
fi
ok "node $(node -v) / npm $(npm -v)"

# ---------- 4. agents ----------
install_tool claude   "curl -fsSL https://claude.ai/install.sh | bash"        "npm i -g @anthropic-ai/claude-code"
install_tool codex    "curl -fsSL https://chatgpt.com/codex/install.sh | sh"  "npm i -g @openai/codex"
install_tool pi       "curl -fsSL https://pi.dev/install.sh | sh"             "npm i -g --ignore-scripts @earendil-works/pi-coding-agent"
install_tool opencode "curl -fsSL https://opencode.ai/install | bash"         "npm i -g opencode-ai"

# ---------- 5. configure ----------
mkdir -p "$HOME/.claude" "$HOME/.codex"
[ -f "$HOME/.claude/settings.json" ] || curl -fsSL "$REPO_RAW/config/claude.settings.json" -o "$HOME/.claude/settings.json"
[ -f "$HOME/.codex/config.toml" ]    || curl -fsSL "$REPO_RAW/config/codex.config.toml"   -o "$HOME/.codex/config.toml"

# alias 幂等写入
MARK="# >>> ai-stack aliases >>>"
if ! grep -q "$MARK" "$HOME/.bashrc"; then
cat >> "$HOME/.bashrc" <<'EOF'
# >>> ai-stack aliases >>>
alias c='claude'
alias cldmax='claude --verbose --dangerously-skip-permissions --effort max'
proxy_on(){ export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890; echo "proxy on"; }
proxy_off(){ unset http_proxy https_proxy; echo "proxy off"; }
# <<< ai-stack aliases <<<
EOF
fi

# ---------- 6. doctor ----------
for b in node git claude codex pi opencode; do
  if has "$b"; then ok "$b -> $(command -v $b)"; else fail "$b 缺失"; fi
done
log "完成。执行 source ~/.bashrc 生效。"
```

---

## 五、Windows 入口脚本（[install.ps](http://install.ps)1 骨架）

```powershell
#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
$log = "$env:USERPROFILE\.ai-stack\install.log"
New-Item -ItemType Directory -Force -Path (Split-Path $log) | Out-Null

function Log  ($m){ Write-Host "[*] $m" -ForegroundColor Cyan;  Add-Content $log "[*] $m" }
function Ok   ($m){ Write-Host "[v] $m" -ForegroundColor Green; Add-Content $log "[v] $m" }
function Bad  ($m){ Write-Host "[x] $m" -ForegroundColor Red;   Add-Content $log "[x] $m" }
function Has  ($c){ [bool](Get-Command $c -ErrorAction SilentlyContinue) }

# 0. UTF-8，避免中文乱码
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8

# 1. 可选代理
if ($env:USE_PROXY -eq '1') {
  $p = "http://127.0.0.1:7890"
  $env:HTTP_PROXY = $p; $env:HTTPS_PROXY = $p
  Log "proxy -> $p"
}

# 2. prereq（winget 静默安装）
function Ensure-Winget($id, $probe) {
  if (Has $probe) { Ok "$probe 已存在"; return }
  Log "winget 安装 $id"
  winget install --id $id -e --silent --accept-source-agreements --accept-package-agreements
}
Ensure-Winget 'Git.Git'              'git'
Ensure-Winget 'OpenJS.NodeJS.LTS'    'node'
Ensure-Winget 'Microsoft.PowerShell' 'pwsh'

# 刷新当前会话 PATH，否则刚装的命令找不到
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' +
            [Environment]::GetEnvironmentVariable('Path','User')

# 3. agents
function Install-Agent($bin, [scriptblock]$primary, $fallbackCmd) {
  if (Has $bin) { Ok "$bin 已存在"; return }
  Log "安装 $bin ..."
  try { & $primary; if (Has $bin) { Ok "$bin ok"; return } } catch { Log "$bin 主通道失败: $_" }
  if ($fallbackCmd) {
    Log "降级：$fallbackCmd"
    try { Invoke-Expression $fallbackCmd; if (Has $bin) { Ok "$bin 降级 ok"; return } } catch { }
  }
  Bad "$bin 安装失败"
}

Install-Agent 'claude' { irm https://claude.ai/install.ps1 | iex } 'npm i -g @anthropic-ai/claude-code'
Install-Agent 'codex'  { irm https://chatgpt.com/codex/install.ps1 | iex } 'npm i -g @openai/codex'
Install-Agent 'pi'     { npm i -g --ignore-scripts '@earendil-works/pi-coding-agent' } $null
Install-Agent 'opencode' { npm i -g opencode-ai } $null

# 4. 配置注入（不覆盖已有文件）
$claudeDir = "$env:USERPROFILE\.claude"; New-Item -ItemType Directory -Force $claudeDir | Out-Null
$settings  = "$claudeDir\settings.json"
if (-not (Test-Path $settings)) {
  @{
    hasCompletedOnboarding = $true
    env = @{ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1' }
  } | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 $settings
  Ok "写入 $settings"
}

# 5. doctor
'node','git','claude','codex','pi','opencode' | ForEach-Object {
  if (Has $_) { Ok "$_ -> $((Get-Command $_).Source)" } else { Bad "$_ 缺失" }
}
```

---

## 六、配置要“在哪里设置”

| 对象 | Linux / WSL | Windows | 说明 |
| --- | --- | --- | --- |
| Claude Code 用户配置 | `~/.claude/settings.json`、`~/.claude.json` | `%USERPROFILE%\.claude\settings.json` | 模型、effort、env、插件、statusLine |
| Claude Code 项目配置 | `./.claude/`、`./.mcp.json` | 同左 | 随仓库走，脚本可选生成模板 |
| Codex 配置 | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` | 登录用 `codex` 内 Sign in with ChatGPT 或 API Key |
| Pi | 首次运行 `pi` 后用 `/login`，或预置 `ANTHROPIC_API_KEY` 等环境变量 | 同左 | 扩展包用 `pi install npm:... / git:...` |
| Shell 别名 / 代理 | `~/.bashrc`、`~/.zshrc` | `$PROFILE`（pwsh 7） | 用标记块包裹，保证幂等 |
| 密钥 | `~/.ai-stack/.env`（chmod 600） | 用户环境变量或 DPAPI 加密文件 | **绝不写进仓库**，脚本只读取或交互式询问 |

---

## 七、分发：真正做到“一条命令”

把仓库放 GitHub，README 顶部给两行：

```bash
# Linux / macOS / WSL
curl -fsSL https://raw.githubusercontent.com/<you>/ai-stack-installer/main/install.sh | bash

# 带参数（只装最小集 + 开代理）
curl -fsSL .../install.sh | USE_PROXY=1 PROFILE=minimal bash
```

```powershell
# Windows PowerShell
iwr -useb https://raw.githubusercontent.com/<you>/ai-stack-installer/main/install.ps1 | iex

# 带参数（管道方式无法传参，用下载后执行）
iwr -useb .../install.ps1 -OutFile $env:TEMP\ai.ps1; & $env:TEMP\ai.ps1 -Profile full -Proxy
```

> 管道执行拿不到命名参数，这是 PowerShell 的固定坑。要传参就「先下载再执行」，或者用环境变量传（`$env:USE_PROXY=1`）。
> 

### 进阶：如果你想更省心

- **不想维护两套脚本** → 用 Node.js 写核心逻辑，两个入口脚本只负责「装 Node + 拉起 `npx ai-stack-installer`」。你本来就要装 Node，这是最划算的路线，也和你 Oh My Skills 的技术栈一致。
- **想要可重复的干净环境** → 提供一个 `Dockerfile` / devcontainer 版本，CI 和新机器都能秒起。
- **想验证脚本不炸** → GitHub Actions 矩阵跑 `ubuntu-latest` + `windows-latest`，每次 push 全新机器实测一遍安装，这是这类项目唯一靠谱的回归测试。

---

## 八、必须踩过的坑清单

- [ ]  **幂等**：任何一步都先 `check` 再装，重复执行不报错、不重复追加 rc 文件。
- [ ]  **PATH 刷新**：Windows 上 winget 装完，当前会话 PATH 不会自动更新，必须手动重读。
- [ ]  **执行策略**：`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`，或调用时带 `-ExecutionPolicy ByPass`。
- [ ]  **中文乱码**：强制 UTF-8，推荐把 PowerShell 7 的路径提到 Path 首位。
- [ ]  **权限**：Linux 不要整脚本 `sudo`，只在 `apt-get` 那几行用；npm 全局包避免 `sudo npm -g`（用 fnm/nvm 装 Node 就没这问题）。
- [ ]  **网络**：国内环境给 `USE_PROXY` 开关 + npm 镜像开关（`npm config set registry`），但注意某些官方安装器直连 GitHub / [storage.googleapis.com](http://storage.googleapis.com)，镜像救不了，只能走代理。
- [ ]  **失败不要 `set -e` 直接死**：单个 Agent 装失败应记录后继续，最后统一汇报，不要让第 3 个工具挂掉导致后面 5 个都没装。
- [ ]  **卸载路径**：提供 `--uninstall`，每个工具在 manifest 里配好卸载命令。
- [ ]  **版本锁**：支持 `claude@2.1.77` 这类固定版本，方便回退。

---

## 九、建议的开发顺序（3 天可跑通）

1. **Day 1**：只做 Linux + Claude Code 一个工具，把 `log/retry/has/install_tool/doctor` 五个 helper 打磨好。
2. **Day 2**：抽出 manifest.json，把 Codex / Pi / OpenCode 用数据的方式加进来（此时脚本逻辑应该一行不改）。
3. **Day 3**：写 [install.ps](http://install.ps)1 对齐同一份 manifest，加 GitHub Actions 双平台冒烟测试，补 `--uninstall` 和 `--profile`。