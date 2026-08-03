// 卸载：交互确认 → 只卸本脚本安装的工具 → 移除 rc 标记块 → 删 hash 匹配的文件 → 删 ~/.ai-stack
// 卸载安全：用户原有的工具、被修改过的配置一律保留（绝不误删导致环境崩溃）
// 依赖：agents, configure, fs-locations, installed, logger, clack, types
import { rm } from 'node:fs/promises';
import { confirm, isCancel } from '@clack/prompts';
import { uninstallAgent } from './agents.js';
import { printFileReport, removeAliasBlock } from './configure.js';
import { aiStackDir } from './fs-locations.js';
import { readInstalledJson, removeRecordedFiles } from './installed.js';
import { log, ok, warn } from './logger.js';
import type { Manifest, Platform } from './types.js';
import { detectTty } from './utils.js';

export interface UninstallContext {
  manifest: Manifest;
  platform: Platform;
  home: string;
  /** -y：跳过交互确认 */
  yes?: boolean;
}

/** 卸载全流程；退出码 = 0（成功）或 130（交互取消）；破坏性操作默认交互确认 */
export async function runUninstall(ctx: UninstallContext): Promise<number> {
  // 1. 交互确认（默认 N；-y 跳过；非 TTY 无 -y 视为拒绝）
  if (!ctx.yes) {
    if (!detectTty()) {
      await log('非交互环境：uninstall 是破坏性操作，请使用 -y 明确确认');
      return 0;
    }
    const confirmed = await confirm({
      message: '确认卸载本脚本安装的工具与配置？此操作不可撤销（仅影响本脚本安装的内容）',
      initialValue: false,
    });
    if (isCancel(confirmed)) return 130;
    if (confirmed !== true) {
      await log('已取消卸载');
      return 0;
    }
  }

  // 2. 只卸 installed.json 记录的本脚本安装的工具（用户原有的绝不卸载）
  const record = await readInstalledJson(ctx.home);
  const installedIds = new Set(record?.tools ?? []);
  const all = [...ctx.manifest.agents, ...(ctx.manifest.optInAgents ?? [])];
  const mine = all.filter((t) => installedIds.has(t.id));
  if (record && installedIds.size > 0 && mine.length === 0) {
    await warn('installed.json 记录了已安装工具，但 manifest 中未找到对应条目，跳过工具卸载');
  }
  if (installedIds.size === 0) {
    await log('未检测到本脚本安装的工具（installed.json 缺失或为旧版本），跳过工具卸载');
    if (record === null) {
      await warn('提示：旧版 installed.json 无工具记录，无法区分工具来源；为避免误删请手动卸载。');
    }
  }
  for (const tool of mine) {
    await uninstallAgent(tool, ctx.platform);
  }

  // 3. 移除 rc 标记块（writeAliasBlock 的反向操作）
  await removeAliasBlock(ctx.platform, ctx.home);

  // 4. 删记录内文件（hash 校验：被用户修改过的保留并警告）
  const { kept } = await removeRecordedFiles(record, log, ok, warn);
  if (kept.length > 0) {
    await warn(`有 ${kept.length} 个文件因内容与安装时不同被保留（可能被修改过），请自行确认后手动删除`);
  }

  // 5. 删 ~/.ai-stack（日志与安装记录）
  await rm(aiStackDir(ctx.home), { recursive: true, force: true });
  await ok(`已删除 ${aiStackDir(ctx.home)}（日志与安装记录）`);

  // 6. 文件位置清单 + 提示
  await printFileReport(ctx.platform, ctx.home);
  await log('注意：Node/Git/PowerShell 为通用依赖，未卸载；如不再需要请手动卸载。');
  await ok('卸载完成。');
  return 0;
}
