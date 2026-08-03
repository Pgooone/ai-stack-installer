// 前置依赖：node（fnm/winget + PATH 刷新）/git/pwsh 安装，失败不中断、最后统一汇报（依赖：manifest, utils, logger）
import { delimiter, join } from 'node:path';
import { fail, log, ok } from './logger.js';
import { installCmd, stateOf } from './manifest.js';
import type { Manifest, Platform, ToolSpec } from './types.js';
import { exec } from './utils.js';

export interface PrereqContext {
  manifest: Manifest;
  platform: Platform;
  /** 注入以便测试；fnm 目录等基于 home 拼接 */
  home: string;
  /** cn 模式：npm 安装命令自动加 npmmirror registry */
  cnMode?: boolean;
}

export interface PrereqResult {
  failed: string[];
}

// fnm 默认安装位置：~/.local/share/fnm（linux/macos）
const FNM_DIR_REL = ['.local', 'share', 'fnm'];
const WINGET_NODE =
  'winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements';
const FNM_INSTALL_SCRIPT = 'curl -fsSL https://fnm.vercel.app/install | bash';

/** 遍历 manifest.prereq：已满足跳过，否则安装；单个失败不中断，汇总到 failed */
export async function ensurePrereqs(ctx: PrereqContext): Promise<PrereqResult> {
  const failed: string[] = [];
  for (const tool of ctx.manifest.prereq) {
    log(`检查前置依赖:${tool.id}`);
    let okTool = false;
    try {
      okTool = await ensureOne(tool, ctx);
    } catch (err) {
      fail(`前置依赖 ${tool.id} 检查异常：${(err as Error).message}`);
    }
    if (okTool) {
      ok(`前置依赖 ${tool.id} 就绪`);
    } else {
      failed.push(tool.id);
      fail(`前置依赖 ${tool.id} 安装失败`);
    }
  }
  return { failed };
}

async function ensureOne(tool: ToolSpec, ctx: PrereqContext): Promise<boolean> {
  // onlyOnWindows 的依赖（如 pwsh）在非 Windows 平台直接视为满足
  if (tool.onlyOnWindows === true && ctx.platform !== 'windows') {
    log(`跳过 ${tool.id}：仅 Windows 平台需要`);
    return true;
  }
  const state = await stateOf(tool);
  if (state.installed) return true;
  if (tool.id === 'node') return installNode(ctx);
  const cmd = installCmd(tool, ctx.platform, ctx.cnMode ?? false);
  if (!cmd) return false; // 该平台无安装命令
  let r = await exec(cmd);
  // 主通道失败且有 fallback（如 pwsh MSI 下载失败降级 winget）
  if (r.code !== 0 && tool.fallback) {
    log(`主通道安装 ${tool.id} 失败，降级：${tool.fallback}`);
    r = await exec(tool.fallback);
  }
  if (r.code !== 0) return false;
  // 安装后复查：winget 对已装旧版本返回「已存在」退出码 0 但不升级，
  // 不复查会假成功（如 pwsh 版本低于 minVersion 却报「就绪」）
  const after = await stateOf(tool);
  if (!after.installed) {
    fail(`前置依赖 ${tool.id} 安装后仍不满足版本要求（当前 ${after.version ?? '未知'}，要求 ≥${tool.minVersion ?? ''}）`);
    if (tool.id === 'pwsh') {
      fail('提示：请检查网络（GitHub Releases 需代理）或从 https://github.com/PowerShell/PowerShell/releases 手动安装 MSI');
    }
  }
  return after.installed;
}

// ---- node：linux/macos 走 fnm，windows 走 winget + PATH 刷新 ----

async function installNode(ctx: PrereqContext): Promise<boolean> {
  if (ctx.platform === 'windows') {
    const r = await exec(WINGET_NODE);
    if (r.code !== 0) return false;
    return refreshWindowsPath();
  }
  const fnmDir = join(ctx.home, ...FNM_DIR_REL);
  if ((await exec(FNM_INSTALL_SCRIPT)).code !== 0) return false;
  // fnm 装完把 bin 放进 PATH 再装 LTS，并显式把 lts-latest 设为 default 别名（确保 aliases/default/bin 有 node）
  if ((await exec(`export PATH="${fnmDir}:$PATH"; fnm install --lts && fnm alias lts-latest default`)).code !== 0) {
    return false;
  }
  exportFnmPath(fnmDir);
  return true;
}

/** 把 fnm 的 node bin 目录注入当前进程 PATH，后续 exec 即可直接用 node/npm */
function exportFnmPath(fnmDir: string): void {
  const parts = [join(fnmDir, 'aliases', 'default', 'bin'), fnmDir, ...(process.env.PATH ?? '').split(delimiter)];
  process.env.PATH = [...new Set(parts.filter(Boolean))].join(delimiter);
}

/** 重读注册表 Machine+User PATH 合并到当前进程，刷新会话（winget 安装不更新已存在的会话） */
async function refreshWindowsPath(): Promise<boolean> {
  try {
    const machine = await exec('[Environment]::GetEnvironmentVariable("PATH", "Machine")');
    const user = await exec('[Environment]::GetEnvironmentVariable("PATH", "User")');
    const parts = [
      ...machine.stdout.trim().split(';'),
      ...user.stdout.trim().split(';'),
      ...(process.env.PATH ?? '').split(';'),
    ];
    process.env.PATH = [...new Set(parts.filter(Boolean))].join(';');
    return true;
  } catch {
    return false;
  }
}
