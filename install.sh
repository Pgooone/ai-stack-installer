#!/bin/sh
# ai-stack-installer 薄入口（Linux/macOS/WSL，POSIX sh）
# 用法: bash install.sh [-y|-i|--cn|-p minimal|full]
# 职责: 日志到 ~/.ai-stack/install.log → 探测 Node≥20（不足用 fnm 装）→ npx 拉起（失败回退全局安装）→ 透明性提示

set -u
LOG_DIR="${HOME}/.ai-stack"
LOG_FILE="${LOG_DIR}/install.log"
mkdir -p "$LOG_DIR" 2>/dev/null || true

log() { printf '[install.sh] %s\n' "$*" | tee -a "$LOG_FILE"; }

# 国内直连安装 Node（npmmirror 镜像，兼容无代理环境）
# 流程：取 unofficial-builds 最新 LTS 版本（保证官方包与 glibc-217 构建版本一致）
#      → 官方包试跑（现代系统直接用）→ 失败（glibc<2.28 老系统）→ glibc-217 构建 + 官方包 npm 混搭
# 成功后 node_ok=true 且新 node 的 bin 已前置到 PATH
install_node_cn() {
  local major=22
  local base="$HOME/.ai-stack/node"
  local mirror="https://registry.npmmirror.com/-/binary"
  local tmp="$base/.tmp"
  mkdir -p "$base" "$tmp"

  log "国内直连：从 npmmirror 获取 Node v${major} LTS 最新版..."
  local ver
  ver=$(curl -fsSL --max-time 15 "$mirror/node-unofficial-builds/index.json" 2>/dev/null |
    grep -oE "v${major}\.[0-9]+\.[0-9]+" | sort -uV | tail -1)
  [ -z "$ver" ] && { log "错误：npmmirror 版本信息不可用"; return 1; }
  log "目标版本：$ver"

  # 1. 官方构建（含完整 npm）
  local dest="$base/$ver"
  if [ ! -x "$dest/bin/node" ]; then
    log "下载官方构建：node-$ver-linux-x64.tar.xz"
    curl -fsSL --max-time 300 -o "$tmp/official.tar.xz" "$mirror/node/$ver/node-$ver-linux-x64.tar.xz" || { log "错误：官方构建下载失败"; return 1; }
    tar -xJf "$tmp/official.tar.xz" -C "$base" || { log "错误：解压失败"; return 1; }
    mv "$base/node-$ver-linux-x64" "$dest"
  fi

  local bin_dir="$dest/bin"
  if ! "$dest/bin/node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
    # 官方构建跑不起来：glibc 过旧，改用官方 glibc-217 兼容构建（CentOS 7 等）
    log "官方构建需 glibc≥2.28，当前系统过旧，改用 glibc-217 兼容构建"
    local g217="$base/$ver-glibc217"
    if [ ! -x "$g217/bin/node" ]; then
      curl -fsSL --max-time 300 -o "$tmp/glibc217.tar.xz" \
        "$mirror/node-unofficial-builds/$ver/node-$ver-linux-x64-glibc-217.tar.xz" || {
          log "错误：glibc-217 构建下载失败（$ver 未在 unofficial-builds 发布）"
          return 1
        }
      tar -xJf "$tmp/glibc217.tar.xz" -C "$base" || { log "错误：glibc-217 解压失败"; return 1; }
      mv "$base/node-$ver-linux-x64-glibc-217" "$g217"
    fi
    # 混搭：glibc-217 的 node 二进制 + 官方包的完整 npm（npm 纯 JS，不依赖 glibc 版本）
    mkdir -p "$g217/lib/node_modules"
    cp -r "$dest/lib/node_modules/npm" "$g217/lib/node_modules/"
    # 官方包的 bin/npm、bin/npx 是软链（指向 lib/node_modules/npm/bin/*-cli.js），
    # 重写前必须删除软链本身，否则 > 重定向会跟随软链覆盖 npm-cli.js，导致 npm 静默失效
    rm -f "$g217/bin/npm" "$g217/bin/npx"
    {
      echo '#!/usr/bin/env node'
      echo "require('$g217/lib/node_modules/npm/bin/npm-cli.js')"
    } > "$g217/bin/npm"
    {
      echo '#!/usr/bin/env node'
      echo "require('$g217/lib/node_modules/npm/bin/npx-cli.js')"
    } > "$g217/bin/npx"
    chmod +x "$g217/bin/npm" "$g217/bin/npx"
    bin_dir="$g217/bin"
  fi

  if ! "$bin_dir/node" -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >/dev/null 2>&1; then
    log "错误：Node 安装后仍无法运行"
    return 1
  fi
  export PATH="$bin_dir:$PATH"
  node_ok=true
  log "Node 已就绪：$("$bin_dir/node" -v)（$bin_dir）"

  # 持久化：幂等追加到 ~/.bashrc，新开终端可直接用 node/npm
  if [ -f "$HOME/.bashrc" ] && ! grep -qF "$bin_dir" "$HOME/.bashrc" 2>/dev/null; then
    echo "export PATH=\"$bin_dir:\$PATH\"" >> "$HOME/.bashrc"
    log "已追加 PATH 到 ~/.bashrc（新开终端生效）"
  fi
}

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
  # 国内直连兜底：无代理/老系统（glibc<2.28）环境自动装 Node（npmmirror + glibc-217 构建）
  install_node_cn
fi

if [ "$node_ok" = false ]; then
  log "错误：未找到可用的 Node ≥20（fnm 与国内镜像均失败，请检查网络后重试，"
  log "      或手动安装 Node.js ≥20 后重新运行本脚本）"
  exit 1
fi

# 2. 选择 npm registry：有代理（环境变量）→ 官方源；无代理（国内常见）→ npmmirror 首选，
#    避免 /-/ping 假阳性（ping 通但下载被墙）；npmmirror 不可达（海外无代理）回退官方
pick_registry() {
  if [ -n "${http_proxy:-}${HTTP_PROXY:-}${https_proxy:-}${HTTPS_PROXY:-}" ]; then
    echo "https://registry.npmjs.org"
    return
  fi
  if curl -fsSL --max-time 5 -o /dev/null https://registry.npmmirror.com/-/ping 2>/dev/null; then
    # 注意 >&2：本函数 stdout 会被 $(pick_registry) 捕获，日志必须走 stderr
    log "使用 npmmirror 镜像源（国内首选）" >&2
    echo "https://registry.npmmirror.com"
  else
    echo "https://registry.npmjs.org"
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

log "执行：npx -y ai-stack-installer@latest $*"
if npx -y ai-stack-installer@latest "$@"; then
  rc=0
elif [ "$REGISTRY" = "https://registry.npmmirror.com" ]; then
  # npmmirror（首选）失败（海外/网络波动），切官方源重试一次
  log "npmmirror 拉取失败，改用 npmjs 官方源重试"
  export npm_config_registry="https://registry.npmjs.org"
  if npx -y ai-stack-installer@latest "$@"; then
    rc=0
  else
    log "npx 执行失败，回退全局安装（官方源）..."
    if npm i -g ai-stack-installer@latest >/dev/null 2>&1; then
      log "执行：ai-stack $*"
      ai-stack "$@"
      rc=$?
    else
      log "全局安装失败：请检查网络后重试"
      rc=1
    fi
  fi
else
  log "npx 执行失败（官方源），回退全局安装..."
  if npm i -g ai-stack-installer@latest >/dev/null 2>&1; then
    log "执行：ai-stack $*"
    ai-stack "$@"
    rc=$?
  else
    log "全局安装失败：请检查网络后重试"
    rc=1
  fi
fi

# 3. 透明性提示
log "卸载请运行：ai-stack uninstall"
# 4. 执行完毕自动清理本入口脚本（保持下次使用最新版）；AI_STACK_KEEP=1 可保留
#    仅当 $0 是真实脚本文件时清理——管道模式（curl | bash）下 $0 是 shell 自身，不能删
script_real=false
case "$0" in
  *bash|*sh|*dash) ;;
  *) [ -f "$0" ] && script_real=true ;;
esac
if [ "${AI_STACK_KEEP:-0}" != "1" ] && [ "$script_real" = true ]; then
  rm -f "$0" 2>/dev/null
  log "已清理入口脚本 $0（设置 AI_STACK_KEEP=1 可保留）"
fi
exit "$rc"
