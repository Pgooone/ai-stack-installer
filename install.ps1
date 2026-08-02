# ai-stack-installer 薄入口（Windows PowerShell 5.1+）
# 用法: .\install.ps1 [-y|-i|--cn|-p minimal|full]
# 职责: UTF8 输出 → 探测 Node≥20（不足 winget 装 Node LTS + 重读 PATH）→ npx 拉起（失败回退全局安装）→ 透明性提示

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$LogDir = Join-Path $HOME '.ai-stack'
$LogFile = Join-Path $LogDir 'install.log'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null

function Write-Log([string]$msg) {
  $line = "[install.ps1] $msg"
  Write-Host $line
  Add-Content -Path $LogFile -Value $line -Encoding UTF8
}

Write-Log "开始执行（参数：$args）"

# 1. 探测 node（≥20 才可用）
$nodeOk = $false
if (Get-Command node -ErrorAction SilentlyContinue) {
  node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
  if ($LASTEXITCODE -eq 0) { $nodeOk = $true }
}

if (-not $nodeOk) {
  Write-Log '未检测到 Node ≥20，使用 winget 安装 Node LTS...'
  winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements
  if ($LASTEXITCODE -eq 0) {
    # 重读 Machine+User PATH 合并进当前会话（winget 不更新已存在的会话）
    $machine = [Environment]::GetEnvironmentVariable('PATH', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('PATH', 'User')
    $env:PATH = ($machine, $user, $env:PATH | Where-Object { $_ }) -join ';'
    Write-Log 'Node 安装完成，已重读 Machine+User PATH 刷新会话'
  } else {
    Write-Log "警告：winget 安装 Node 失败（rc=$LASTEXITCODE），继续尝试 npx"
  }
}

# 2. 拉起 npm 包：AI_STACK_PKG（本地验证/CI 用，未发布时可指 dist/cli.js）→ npx → 全局安装回退
if ($env:AI_STACK_PKG) {
  Write-Log "AI_STACK_PKG 已设置，使用本地包：$env:AI_STACK_PKG"
  node $env:AI_STACK_PKG @args
  exit $LASTEXITCODE
}

Write-Log "执行：npx -y ai-stack-installer $args"
npx -y ai-stack-installer @args
if ($LASTEXITCODE -ne 0) {
  Write-Log 'npx 执行失败，回退全局安装...'
  npm i -g ai-stack-installer
  if ($LASTEXITCODE -eq 0) {
    Write-Log "执行：ai-stack $args"
    ai-stack @args
    $rc = $LASTEXITCODE
  } else {
    Write-Log '全局安装失败：请检查网络后重试'
    $rc = 1
  }
} else {
  $rc = 0
}

# 3. 透明性提示
Write-Log "安装脚本位置：$PSCommandPath（本脚本仅用于拉起安装，可随时删除）"
Write-Log '卸载请运行：ai-stack uninstall'
exit $rc
