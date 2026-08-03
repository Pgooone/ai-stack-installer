// 系统组件更新：检测可用更新 → 逐个 prereq 执行 upgrade/install 命令，执行后复查 stateOf（依赖：manifest, utils, logger）
import { fail, log, ok } from './logger.js';
import { installCmd, stateOf } from './manifest.js';
import type { Manifest, Platform, ToolSpec } from './types.js';
import { exec, versionGte } from './utils.js';

export interface UpdateContext {
  manifest: Manifest;
  platform: Platform;
  home: string;
  cnMode?: boolean;
}

export interface UpdateResult {
  updated: string[];
  failed: string[];
  skipped: string[];
}

/** 可用更新检测结果：hasUpdate=true 有可用更新 / false 已是最新 / undefined 无法检测（默认勾选） */
export interface UpdateCheck {
  tool: ToolSpec;
  current?: string;
  hasUpdate: boolean | undefined;
}

/** winget upgrade --dry-run：退出码 0 = 有可用升级，0x8A150019（非 0）= 已是最新 */
const WINGET_DRY_RUN =
  (id: string) => `winget upgrade --id ${id} --dry-run --accept-source-agreements --accept-package-agreements`;

/**
 * 检测各组件是否有可用更新（交互前呈现给用户选择）。
 * Windows 用 winget --dry-run 退出码判断；其他平台/无 upgrade 命令标记「无法检测」
 */
export async function detectUpdates(ctx: UpdateContext): Promise<UpdateCheck[]> {
  const out: UpdateCheck[] = [];
  for (const tool of ctx.manifest.prereq) {
    if (tool.onlyOnWindows === true && ctx.platform !== 'windows') continue;
    const state = await stateOf(tool);
    const current = state.version;
    // 未安装：需要安装（不是「已是最新」）；winget upgrade --dry-run 对未安装包
    // 也返回非 0（找不到包），无法与「已最新」（0x8A150019）区分，必须先判断安装态
    if (!state.installed) {
      out.push({ tool, current, hasUpdate: true });
      continue;
    }
    if (!upgradeCmd(tool, ctx.platform)) {
      out.push({ tool, current, hasUpdate: undefined }); // 无升级命令，不参与更新
      continue;
    }
    out.push({ tool, current, hasUpdate: await checkToolUpdate(tool, ctx.platform, current) });
  }
  return out;
}

/**
 * 检测单个已安装工具是否有可用更新（winget dry-run / GitHub API 版本比较）。
 * 返回 undefined 表示无法检测（保守按有更新处理）。
 */
async function checkToolUpdate(tool: ToolSpec, platform: Platform, current?: string): Promise<boolean | undefined> {
  if (platform !== 'windows' || !tool.upgradeWindows && !tool.upgrade) return undefined;
  const cmd = upgradeCmd(tool, platform)!;
  // GitHub Releases 类命令（如 pwsh MSI 安装链）：查询 API 最新版与当前比较
  // 注意仓库名含斜杠（PowerShell/PowerShell），分隔符只能用引号/空白
  const apiMatch = /https:\/\/api\.github\.com\/repos\/([^'"\s]+)\/releases\/latest/.exec(cmd);
  if (apiMatch) {
    const api = `powershell -NoProfile -Command "((Invoke-RestMethod -Uri 'https://api.github.com/repos/${apiMatch[1]}/releases/latest' -Headers @{'User-Agent'='ai-stack-installer'}).tag_name).TrimStart('v')"`;
    const ar = await exec(api);
    const latest = ar.code === 0 ? ar.stdout.trim() : '';
    if (latest && current) return !versionGte(current, latest) && current !== latest;
    return undefined; // API 查询失败 → 无法检测
  }
  const id = /--id (\S+)/.exec(cmd)?.[1];
  if (!id) return undefined;
  const r = await exec(WINGET_DRY_RUN(id));
  return r.code === 0;
}

/** 逐个 prereq 执行 upgrade：无 upgrade 命令或平台不适用跳过；单个失败不中断；only 限定只更新选中项 */
export async function updatePrereqs(ctx: UpdateContext, only?: string[]): Promise<UpdateResult> {
  const result: UpdateResult = { updated: [], failed: [], skipped: [] };
  for (const tool of ctx.manifest.prereq) {
    if (only && !only.includes(tool.id)) continue;
    if (tool.onlyOnWindows === true && ctx.platform !== 'windows') {
      result.skipped.push(tool.id);
      continue;
    }
    const before = await stateOf(tool);
    if (before.installed) {
      // 已安装：先检测是否有更新——已最新则跳过下载（如 pwsh MSI 每次 115MB，避免无谓下载重装）
      const hasUpdate = await checkToolUpdate(tool, ctx.platform, before.version);
      if (hasUpdate === false) {
        log(`更新 ${tool.id}：已是最新（${before.version}），跳过下载`);
        result.skipped.push(tool.id);
        continue;
      }
    }
    // 未安装 → 用安装命令（winget upgrade 对未安装的包无效会直接失败）；已安装 → upgrade
    const cmd = before.installed
      ? upgradeCmd(tool, ctx.platform)
      : installCmd(tool, ctx.platform, ctx.cnMode ?? false);
    if (!cmd) {
      log(`跳过 ${tool.id}：无安装/升级命令`);
      result.skipped.push(tool.id);
      continue;
    }
    log(`更新 ${tool.id}（当前 ${before.installed ? before.version ?? '未知' : '未安装'} → ${before.installed ? '最新' : '安装最新'}）`);
    let r;
    try {
      r = await exec(cmd);
    } catch (err) {
      fail(`更新 ${tool.id} 异常：${(err as Error).message}`);
      result.failed.push(tool.id);
      continue;
    }
    const after = await stateOf(tool);
    if (r.code !== 0) {
      // winget upgrade 对「无可用升级」返回非 0（0x8A150019）——版本未变且工具可用不算失败
      if (after.installed) {
        if (after.version !== before.version) {
          ok(`更新 ${tool.id} 完成（${after.version}）`);
          result.updated.push(tool.id);
        } else {
          log(`更新 ${tool.id}：已是最新（${after.version ?? '未知'}）或需管理员权限`);
          result.skipped.push(tool.id);
        }
      } else {
        fail(`更新 ${tool.id} 失败：${errorTail(r)}`);
        result.failed.push(tool.id);
      }
      continue;
    }
    if (after.installed) {
      ok(`更新 ${tool.id} 完成（${after.version ?? '未知'}）`);
      result.updated.push(tool.id);
    } else {
      fail(`更新 ${tool.id} 后仍未就绪`);
      result.failed.push(tool.id);
    }
  }
  return result;
}

const ERR_TAIL_MAX = 300;

/** 失败诊断：winget 等工具的错误常输出到 stdout 而非 stderr，两者都显示 */
function errorTail(r: { stdout: string; stderr: string }): string {
  const parts = [r.stderr.trim(), r.stdout.trim()].filter(Boolean);
  if (parts.length === 0) return '(无错误输出)';
  const joined = parts.join(' | ');
  return joined.length > ERR_TAIL_MAX ? `...${joined.slice(-ERR_TAIL_MAX)}` : joined;
}

/** 按平台选升级命令：windows 优先 upgradeWindows，macos 优先 upgradeMacos，其余回退 upgrade */
function upgradeCmd(tool: ToolSpec, platform: Platform): string | undefined {
  if (platform === 'windows') return tool.upgradeWindows ?? tool.upgrade;
  if (platform === 'macos') return tool.upgradeMacos ?? tool.upgrade;
  return tool.upgrade;
}
