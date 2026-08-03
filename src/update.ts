// 系统组件更新：逐个 prereq 执行 upgrade 命令（升级到最新），执行后复查 stateOf（依赖：manifest, utils, logger）
import { fail, log, ok } from './logger.js';
import { stateOf } from './manifest.js';
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

/** 逐个 prereq 执行 upgrade：无 upgrade 命令或平台不适用跳过；单个失败不中断 */
export async function updatePrereqs(ctx: UpdateContext): Promise<UpdateResult> {
  const result: UpdateResult = { updated: [], failed: [], skipped: [] };
  for (const tool of ctx.manifest.prereq) {
    if (tool.onlyOnWindows === true && ctx.platform !== 'windows') {
      result.skipped.push(tool.id);
      continue;
    }
    const cmd = upgradeCmd(tool, ctx.platform);
    if (!cmd) {
      log(`跳过 ${tool.id}：无升级命令`);
      result.skipped.push(tool.id);
      continue;
    }
    const before = await stateOf(tool);
    log(`更新 ${tool.id}（当前 ${before.version ?? '未知'} → 最新）`);
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
