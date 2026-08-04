# 跨平台「AI Agent 一键安装脚本」开发方案（Linux / Windows）

> 目标：一条命令，在 Linux（含 WSL）和 Windows 上装好「开发三件套（运行时/终端/网络）」+「Agent 本体（Claude Code、Codex、Pi、OpenCode…）」+「统一配置注入」，并且可重复执行、可校验、可卸载。
>
> **v0.4.12+ 实战修订**（2026-08 云端 CentOS 7 实测）：本方案在**国内无代理 + 老系统（glibc<2.28）**环境
> 落地时补充了以下关键设计——入口脚本需自带「国内直连装 Node」能力（fnm.vercel.app 在国内不可达、
> 官方 Node 二进制在 CentOS 7 上跑不起来）；npm registry 无代理时**国内源（npmmirror）首选**；
> npm 包 bin 入口必须独立（npx 软链调用下 argv 自检失效）；**完全不动用户的 pwsh profile**
> （v0.4.14 移除编码设置 → v0.4.15 连 alias 也不写，用户可完全掌控）。
> 详见各节与「八、必须踩过的坑清单」。

## 一、先把问题拆清楚：一键脚本到底要做 5 件事

1. **探测环境（detect）**：OS / 架构 / 是否 WSL / 已有 Node、Git、包管理器 / 是否需要代理。
2. **装依赖（prereq，也就是你说的“三件套”）**：运行时（Node.js LTS + npm/pnpm）、版本控制与 Shell（Git、PowerShell 7 / bash）、辅助工具（ripgrep、jq、uv/Python 可选）。
   - **Node 缺失时的安装链路必须自带国内直连兜底**：先试 fnm（海外环境）→ 失败后从 **npmmirror 直连下载 Node 二进制**（`registry.npmmirror.com/-/binary/node/`）；
     老系统（glibc<2.28，如 CentOS 7）官方构建跑不起来，需自动改用 **unofficial-builds 的 glibc-217 兼容构建**
     + 官方包的完整 npm 混搭（npm 是纯 JS，不依赖 glibc 版本）。
3. **装 Agent 本体（agents）**：Claude Code、Codex、Pi、OpenCode、OpenClaw… 每个一个安装函数。
4. **注入配置（configure）**：settings.json / config.toml / MCP 配置 / alias / 代理环境变量。
   - **Linux/macOS**：`~/.bashrc` 写 alias / 代理函数标记块（幂等、可整体卸载）。
   - **Windows：完全不动用户 pwsh profile**（v0.4.15 起，连 alias 也不写）——用户可能不知道如何
     修改/删除脚本写入的内容；脚本自身输出 UTF-8 即可。旧版本（≤0.4.14）残留的标记块由
     卸载时清理。
5. **自检与收尾（doctor）**：逐个 `--version`，输出一张结果表，失败项给修复建议。
   - **CLI 必须支持 `--version`**：入口脚本用它探测「包是否拉取成功」，CLI 不认识该参数会误触发重试链。

把这 5 步拆成 5 个函数，是这类脚本不烂尾的关键。不要写成一条几百行的线性脚本。

---

## 二、架构：清单驱动（manifest-driven），而不是把命令硬编码

核心思路：**脚本是引擎，工具列表是数据**。加一个新 Agent 只改 JSON，不改脚本逻辑。

```
ai-stack-installer/
├── install.sh              # Linux/macOS/WSL 入口（POSIX sh 兼容，薄壳：装 Node + npx 拉起）
├── install.ps1             # Windows 入口（PowerShell 5.1+ 兼容写法，职责同上）
├── package.json            # npm 包元数据；bin 指向 dist/bin.js（独立入口，见下）
├── src/                    # 核心逻辑（TypeScript，编译到 dist/）
│   ├── bin.ts              # npm bin 独立入口：无条件调用 main（见坑 #8）
│   ├── cli.ts              # 参数解析 / 子命令分派 / main / npx 缓存清理
│   ├── manifest.ts         # 工具清单加载
│   ├── agents.ts / prereq.ts / configure.ts / doctor.ts / ...
├── dist/                   # tsc 产物（npm publish 只发这个 + manifest.json + config/）
├── manifest.json           # 所有工具的元数据：安装方式/检测命令/卸载命令
└── config/                 # 配置模板
```

> 入口脚本职责（v0.4.12+）：**装 Node ≥20（fnm → npmmirror 国内直连 → glibc-217 兜底）→
> 选 npm registry（无代理国内首选 npmmirror）→ npx 拉起 npm 包 → 失败回退全局安装 → 自清理入口脚本**。
> 安装逻辑全部在 npm 包内，入口保持薄壳，版本演进只需重拉包。

### manifest.json 的形状

```json
{
  "prereq": [
    { "id": "node",  "check": "node -v",  "minVersion": "20",
      "linux": "curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts",
      "linuxCn": "install_node_cn()：npmmirror 直连下载，glibc<2.28 用 glibc-217 构建 + 官方 npm 混搭",
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
  # ① fnm（海外）→ ② npmmirror 直连（国内）→ ③ glibc-217 兼容构建（老系统）
  # 关键：node 探测必须实际执行 `node -e` 验证能否运行，而非只看文件存在——
  # 官方 Node ≥20 二进制要求 glibc≥2.28，CentOS 7（2.17）上装了也跑不起来
  curl -fsSL https://fnm.vercel.app/install | bash && fnm install --lts 2>/dev/null \
    || install_node_cn   # 函数内：npmmirror 下载 → 试跑 → 失败换 glibc-217 → PATH 前置 + 写 ~/.bashrc
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

# 0. 脚本自身输出 UTF-8（避免中文乱码）；**完全不动用户 $PROFILE**
#    （v0.4.14 移除编码写入 → v0.4.15 连 alias/代理函数也不写——用户可完全掌控自己的 profile）
[Console]::OutputEncoding = [Text.Encoding]::UTF8

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

# 2.5 npm registry：无代理 → npmmirror 首选（国内），失败回退官方；有代理 → 官方
if (-not $env:http_proxy -and -not $env:HTTP_PROXY -and -not $env:https_proxy -and -not $env:HTTPS_PROXY) {
  try { Invoke-WebRequest 'https://registry.npmmirror.com/-/ping' -TimeoutSec 5 -UseBasicParsing | Out-Null
        $env:npm_config_registry = 'https://registry.npmmirror.com' } catch { }
}

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
| Shell 别名 / 代理 | `~/.bashrc`、`~/.zshrc` | **不修改**（v0.4.15） | 标记块包裹、幂等；Windows 完全不碰用户 profile，卸载仅清理旧版残留 |
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

### 国内获取入口脚本（已知痛点）

`raw.githubusercontent.com` 在国内无代理时**不可达**，`curl -fsSL .../install.sh` 会直接挂掉。
当前入口脚本的「下载即用」链路在国内需要镜像分发（gitee 镜像 / npm 包附带 / 对象存储），**尚未实现**，是已知待办。
npm 包本身不受影响：`npx -y ai-stack-installer` 走 npmmirror 可达。

### 进阶：如果你想更省心

- **不想维护两套脚本** → 用 Node.js 写核心逻辑，两个入口脚本只负责「装 Node + 拉起 `npx ai-stack-installer`」。你本来就要装 Node，这是最划算的路线，也和你 Oh My Skills 的技术栈一致。
- **想要可重复的干净环境** → 提供一个 `Dockerfile` / devcontainer 版本，CI 和新机器都能秒起。
- **想验证脚本不炸** → GitHub Actions 矩阵跑 `ubuntu-latest` + `windows-latest`，每次 push 全新机器实测一遍安装，这是这类项目唯一靠谱的回归测试。

---

## 八、必须踩过的坑清单

> ✅ = 已在 v0.4.12+ 云端实测踩过并修复；○ = 仍需注意

- [x] ✅ **Node 探测必须「实际运行验证」而非「看文件存在」**：nvm 里装着 node 24 但 CentOS 7（glibc 2.17）跑不起来（官方构建需 glibc≥2.28）——`node -v` 直接报 `GLIBC_2.28 not found`。脚本里 `node -e` 验证失败即视为无 node。
- [x] ✅ **fnm.vercel.app 国内不可达**（TCP reset）——Node 缺失时唯一自愈路径会死路。必须带国内直连兜底：npmmirror 下载官方构建 → 试跑失败 → **unofficial-builds glibc-217 兼容构建**（`registry.npmmirror.com/-/binary/node-unofficial-builds/`）。
- [x] ✅ **glibc-217 构建包不带 npm**（bin/npm 是悬空软链）——需混搭：glibc-217 的 node 二进制 + 官方包的 `lib/node_modules/npm`（npm 纯 JS 不依赖 glibc）。
- [x] ✅ **官方 node 包 bin/npm 是符号链接** → 重写入口前必须 `rm -f` 删软链，否则 `>` 重定向**跟随软链覆盖 npm-cli.js**（变成自引用包装 → npm 静默失效、rc=0 无输出）。
- [x] ✅ **npx 执行链路**：npx 经 `_npx/<hash>/node_modules/.bin/` 软链调用 bin，`process.argv[1]` 是软链路径——**bin 若指向 cli.js，其 `argv[1] === import.meta.url` 自检永远不成立，main 不执行 = CLI 完全静默**。必须用独立 bin 入口（dist/bin.js）无条件调用 main，且**带 shebang**（无 shebang → execve ENOEXEC → bash 解析 JS 报语法错）。
- [x] ✅ **npx 缓存清理路径深度**：argv[1] 是 `.bin` 软链路径时「上溯 N 层」会误删 `_npx` 根目录，破坏 npm 缓存——按 `_npx/<hash>` 段解析。
- [x] ✅ **入口脚本函数内 log 会污染 `$(...)` 捕获值**：`REGISTRY=$(pick_registry)` 若函数内 log（tee 写 stdout）会把日志混进变量（多行垃圾 → 分支判断全乱）——日志必须走 stderr。
- [x] ✅ **CLI 必须支持 `--version`**：入口脚本以它探测拉包是否成功；不认识会报「未知参数」rc=1 → 误触发「切源重试 → 全局安装」重试链。
- [x] ✅ **npm registry 无代理时国内首选 npmmirror**（v0.4.12 起反转）：官方源 `/-/ping` 可达 ≠ 下载可达（假阳性），国内直连 npmmirror 更稳；拉包失败再自动切另一源重试。
- [x] ✅ **CentOS 7 EOL 后 yum mirrorlist 失效**（`mirrorlist.centos.org` 解析失败）——换 vault 源：**阿里主 + 清华备份**（base/extras/updates/sclo-rh），EPEL 用阿里 + 华为云备份；`gpgkey` 用本地文件；SCLo 冻结源无 key 时 gpgcheck=0。
- [x] ✅ **Windows 完全不动用户 pwsh profile**（v0.4.14 移除编码设置 → v0.4.15 连 alias 也不写）：用户可能不知道如何修改/删除脚本写入的内容；脚本自身输出 UTF-8 即可，卸载时仅清理旧版本残留的标记块。
- [x] ✅ **入口脚本自清理**：执行完删自身（保持下次拿最新版），`AI_STACK_KEEP=1` 保留；npx 缓存由 CLI 执行完自动清理。
- [ ] ○ **幂等**：任何一步都先 `check` 再装，重复执行不报错、不重复追加 rc 文件（PATH 写入用 grep 判重）。
- [ ] ○ **PATH 刷新**：Windows 上 winget 装完，当前会话 PATH 不会自动更新，必须手动重读 Machine+User。
- [ ] ○ **执行策略**：`Set-ExecutionPolicy RemoteSigned -Scope CurrentUser`，或调用时带 `-ExecutionPolicy ByPass`。
- [ ] ○ **权限**：Linux 不要整脚本 `sudo`，只在系统包那几行用；npm 全局包避免 `sudo npm -g`（用 fnm/nvm 装 Node 就没这问题）。**注意**：README 里写的 sudo 白名单可能过时——实测 CS03 实际是 `(ALL) ALL` 免密，以 `sudo -l` 实际输出为准。
- [ ] ○ **网络**：`needsProxy` 工具（Claude Code / Codex 官方安装器）直连海外，**镜像救不了，只能走代理**；入口脚本本身在 `raw.githubusercontent.com` 不可达的国内网络需要镜像分发（已知待办）。
- [ ] ○ **失败不要 `set -e` 直接死**：单个 Agent 装失败应记录后继续，最后统一汇报。
- [ ] ○ **卸载路径**：提供 `uninstall`，每个工具在 manifest 里配好卸载命令。
- [ ] ○ **版本锁**：支持 `claude@2.1.77` 这类固定版本，方便回退。

---

## 九、建议的开发顺序（3 天可跑通）

1. **Day 1**：只做 Linux + Claude Code 一个工具，把 `log/retry/has/install_tool/doctor` 五个 helper 打磨好。
2. **Day 2**：抽出 manifest.json，把 Codex / Pi / OpenCode 用数据的方式加进来（此时脚本逻辑应该一行不改）。
3. **Day 3**：写 [install.ps](http://install.ps)1 对齐同一份 manifest，加 GitHub Actions 双平台冒烟测试，补 `uninstall` 和 `--profile`。

> **v0.4.12+ 补充**：Day 2.5 建议在**国内无代理的老系统（如 CentOS 7 云主机）上真机跑一遍入口脚本**——
> fnm 不可达、glibc 不兼容、npx 静默、软链覆盖 npm 这些坑全部只在真实环境暴露，本地模拟测不出来。
> 验证清单：干净环境（`env -i`）装 Node 全链路 → npm registry 首选 npmmirror → npx 拉包输出版本号 → 幂等重跑 npm 仍正常。