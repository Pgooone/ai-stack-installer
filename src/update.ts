// 系统组件更新：检测可用更新 → 逐个 prereq 执行 upgrade/install 命令，执行后复查 stateOf（依赖：manifest, utils, logger）
import { fail, log, ok } from './logger.js';
import { installCmd, stateOf } from './manifest.js';
import type { Manifest, Platform, ToolSpec } from './types.js';
import { exec } from './utils.js';

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
    if (ctx.platform !== 'windows' || !tool.upgradeWindows && !tool.upgrade) {
      out.push({ tool, current, hasUpdate: undefined }); // 非 Windows 平台检测机制暂缺
      continue;
    }
    const id = /--id (\S+)/.exec(upgradeCmd(tool, ctx.platform)!)?.[1];
    if (!id) {
      out.push({ tool, current, hasUpdate: undefined });
      continue;
    }
    const r = await exec(WINGET_DRY_RUN(id));
    out.push({ tool, current, hasUpdate: r.code === 0 });
  }
  return out;
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
        fail(`更新 ${tool.id} 失败：${errorTail(r.stderr)}`);
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

function errorTail(stderr: string): string {
  const s = stderr.trim();
  if (!s) return '(无错误输出)';
  return s.length > ERR_TAIL_MAX ? `...${s.slice(-ERR_TAIL_MAX)}` : s;
}

/** 按平台选升级命令：windows 优先 upgradeWindows，macos 优先 upgradeMacos，其余回退 upgrade */
function upgradeCmd(tool: ToolSpec, platform: Platform): string | undefined {
  if (platform === 'windows') return tool.upgradeWindows ?? tool.upgrade;
  if (platform === 'macos') return tool.upgradeMacos ?? tool.upgrade;
  return tool.upgrade;
}
