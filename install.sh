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
  # 兜底 1：检查 nvm 已安装的 node（用户可能用 nvm 管理，未进 PATH）
  for nvm_node in "$HOME"/.nvm/versions/node/*/bin; do
    if [ -x "$nvm_node/node" ] && "$nvm_node/node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
      export PATH="$nvm_node:$PATH"
      node_ok=true
      log "使用 nvm 已安装的 Node：$("$nvm_node/node" -v)"
      break
    fi
  done
fi

if [ "$node_ok" = false ]; then
  log "未检测到 Node ≥20，使用 fnm 安装..."
  if curl -fsSL https://fnm.vercel.app/install | bash >/dev/null 2>&1; then
    export PATH="${HOME}/.local/share/fnm:$PATH"
    if fnm install --lts >/dev/null 2>&1 && fnm alias lts-latest default >/dev/null 2>&1; then
      export PATH="${HOME}/.local/share/fnm/aliases/default/bin:$PATH"
      node_ok=true
      log "fnm 安装完成，node/npm 已就绪"
    else
      log "警告：fnm 安装 Node 失败"
    fi
  else
    log "警告：fnm 安装脚本失败（fnm.vercel.app 可能需要代理访问）"
  fi
fi

if [ "$node_ok" = false ]; then
  log "错误：未找到 Node ≥20（fnm 安装失败，国内环境请设置代理后重试，"
  log "      或手动安装 Node.js ≥20 后重新运行本脚本）"
  exit 1
fi

# 2. 选择 npm registry：已有代理（环境变量）→ 官方源可达用官方；否则探测 npmjs.org，
#    不可达（国内无代理）→ npmmirror 镜像，保证核心包能拉下来
pick_registry() {
  if [ -n "${http_proxy:-}${HTTP_PROXY:-}${https_proxy:-}${HTTPS_PROXY:-}" ]; then
    echo "https://registry.npmjs.org"
    return
  fi
  if curl -fsSL --max-time 5 -o /dev/null https://registry.npmjs.org/-/ping 2>/dev/null; then
    echo "https://registry.npmjs.org"
  else
    log "npmjs.org 不可达，使用 npmmirror 镜像源"
    echo "https://registry.npmmirror.com"
  fi
}

REGISTRY=$(pick_registry)
log "npm registry: $REGISTRY"
export npm_config_registry="$REGISTRY"

# 3. 拉起 npm 包：AI_STACK_PKG（本地验证/CI 用，未发布时可指 dist/cli.js）→ npx → 全局安装回退
if [ -n "${AI_STACK_PKG:-}" ]; then
  log "AI_STACK_PKG 已设置，使用本地包：$AI_STACK_PKG"
  node "$AI_STACK_PKG" "$@"
  exit $?
fi

log "执行：npx -y ai-stack-installer $*"
if npx -y ai-stack-installer "$@"; then
  rc=0
elif [ "$REGISTRY" = "https://registry.npmjs.org" ]; then
  # 官方源失败（可能是网络波动/被墙），切镜像重试一次
  log "npmjs.org 拉取失败，改用 npmmirror 镜像重试"
  export npm_config_registry="https://registry.npmmirror.com"
  if npx -y ai-stack-installer "$@"; then
    rc=0
  else
    log "npx 执行失败，回退全局安装（镜像）..."
    if npm i -g ai-stack-installer >/dev/null 2>&1; then
      log "执行：ai-stack $*"
      ai-stack "$@"
      rc=$?
    else
      log "全局安装失败：请检查网络后重试"
      rc=1
    fi
  fi
else
  log "npx 执行失败（镜像源），回退全局安装..."
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
