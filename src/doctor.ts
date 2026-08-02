// 体检：逐个 check 输出结果表（工具|版本|状态 ✓/✗）+ 修复建议，返回退出码（依赖：manifest, logger, types）
import { log } from './logger.js';
import { stateOf } from './manifest.js';
import type { Manifest, Platform, ToolState } from './types.js';

const NAME_W = 14;
const VERSION_W = 12;

/** 逐个 stateOf（prereq + agents）输出表格；与 prereq 同规则排除平台不适用项（如 Linux 上仅 Windows 的 pwsh）；退出码 = 失败数 > 0 ? 1 : 0 */
export async function runDoctor(manifest: Manifest, cnEnabled: boolean, platform: Platform): Promise<number> {
  const tools = [...manifest.prereq, ...manifest.agents].filter(
    (tool) => !(tool.onlyOnWindows && platform !== 'windows'),
  );
  const rows = await Promise.all(tools.map(async (tool) => ({ tool, state: await stateOf(tool) })));
  let failed = 0;
  for (const { tool, state } of rows) {
    const line = doctorLine(tool.id, state, tool.needsProxy === true && !cnEnabled);
    await log(line);
    if (!state.installed) failed++;
  }
  return failed > 0 ? 1 : 0;
}

function doctorLine(id: string, state: ToolState, needsProxyHint: boolean): string {
  const status = state.installed ? '✓' : '✗';
  const version = state.version ?? '-';
  const hint = !state.installed && needsProxyHint ? ' 建议启用 cn 模式/代理后重试' : '';
  return `${id.padEnd(NAME_W)} | ${version.padEnd(VERSION_W)} | ${status}${hint}`;
}
