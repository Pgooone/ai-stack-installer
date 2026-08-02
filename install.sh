#!/bin/sh
# ai-stack-installer 薄入口（Linux/macOS/WSL，POSIX sh）
# 用法: bash install.sh [-y|-i|--cn|-p minimal|full]
# 职责: 日志到 ~/.ai-stack/install.log → 探测 Node≥20（不足用 fnm 装）→ npx 拉起（失败回退全局安装）→ 透明性提示

set -u
LOG_DIR="${HOME}/.ai-stack"
LOG_FILE="${LOG_DIR}/install.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[install.sh] %s\n' "$*" | tee -a "$LOG_FILE"; }

log "开始执行（参数：$*）"

# 1. 探测 node（≥20 才可用）
node_ok=false
if command -v node >/dev/null 2>&1; then
  if node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
    node_ok=true
  fi
fi

if [ "$node_ok" = false ]; then
  log "未检测到 Node ≥20，使用 fnm 安装..."
  if curl -fsSL https://fnm.vercel.app/install | bash >/dev/null 2>&1; then
    export PATH="${HOME}/.local/share/fnm:$PATH"
    if fnm install --lts >/dev/null 2>&1 && fnm alias lts-latest default >/dev/null 2>&1; then
      export PATH="${HOME}/.local/share/fnm/aliases/default/bin:$PATH"
      log "fnm 安装完成，node/npm 已就绪"
    else
      log "警告：fnm 安装 Node 失败，继续尝试 npx"
    fi
  else
    log "警告：fnm 安装脚本失败，继续尝试 npx"
  fi
fi

# 2. 拉起 npm 包：npx 失败回退全局安装
log "执行：npx -y ai-stack-installer $*"
if npx -y ai-stack-installer "$@"; then
  rc=0
else
  log "npx 执行失败（rc=$?），回退全局安装..."
  if npm i -g ai-stack-installer >/dev/null 2>&1; then
    log "执行：ai-stack $*"
    ai-stack "$@"
    rc=$?
  else
    log "全局安装失败：请检查网络后重试"
    rc=1
  fi
fi

# 3. 透明性提示
log "安装脚本位置：$0（本脚本仅用于拉起安装，可随时删除）"
log "卸载请运行：ai-stack uninstall"
exit "$rc"
