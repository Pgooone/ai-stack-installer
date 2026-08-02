// 卸载：交互确认 → 逐工具卸载 → 移除 rc 标记块 → 删 installed.json 清单内文件 → 删 ~/.ai-stack
// 依赖：agents, configure, fs-locations, installed, logger, clack, types
import { rm } from 'node:fs/promises';
import { confirm, isCancel } from '@clack/prompts';
import { uninstallAgent } from './agents.js';
import { printFileReport, removeAliasBlock } from './configure.js';
import { aiStackDir } from './fs-locations.js';
import { readInstalledJson } from './installed.js';
import { log, ok } from './logger.js';
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
      message: '确认卸载全部工具与配置？此操作不可撤销（Node/Git 等通用依赖不会卸载）',
      initialValue: false,
    });
    if (isCancel(confirmed)) return 130;
    if (confirmed !== true) {
      await log('已取消卸载');
      return 0;
    }
  }

  // 2. 逐工具卸载（agents + optInAgents）
  const tools = [...ctx.manifest.agents, ...(ctx.manifest.optInAgents ?? [])];
  for (const tool of tools) {
    await uninstallAgent(tool, ctx.platform);
  }

  // 3. 移除 rc 标记块（writeAliasBlock 的反向操作）
  await removeAliasBlock(ctx.platform, ctx.home);

  // 4. 删 installed.json 清单内的文件（只删清单内的；清单缺失容错）
  const record = await readInstalledJson(ctx.home);
  if (record) {
    for (const file of record.files) {
      await rm(file, { force: true }); // force：文件不存在不报错
      await ok(`删除 ${file}`);
    }
  } else {
    await log('未找到 installed.json，跳过配置文件删除');
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
