// 工具安装：已装跳过 → 主通道 → fallback 降级 → 失败记录；卸载（依赖：manifest, proxy, utils, logger）
import { fail, log, ok } from './logger.js';
import { applyNpmMirror, installCmd, stateOf } from './manifest.js';
import { applyCnMode, defaultCnMode, type CnMode } from './proxy.js';
import type { Platform, ToolSpec } from './types.js';
import { exec } from './utils.js';

export interface AgentContext {
  platform: Platform;
  /** cn 模式：npm 安装命令自动加 npmmirror registry，安装命令执行注入 HTTP_PROXY 等 env */
  cnMode?: CnMode;
}

export type InstallResult = 'ok' | 'skipped' | 'failed';

const ERR_TAIL_MAX = 500;
/** 单次安装命令超时：交互式安装器（如 pi 官方脚本会等用户按键）在 -y/CI 下会无限挂起，超时后降级或记失败 */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

/** 安装单个工具：已装 → skipped；主通道 → check 通过 → ok；失败有 fallback → 降级 → ok；都失败 → failed */
export async function installAgent(tool: ToolSpec, ctx: AgentContext): Promise<InstallResult> {
  const state = await stateOf(tool);
  if (state.installed) {
    log(`[${tool.id}] 已安装（版本 ${state.version ?? '未知'}），跳过`);
    return 'skipped';
  }

  const cnMode = ctx.cnMode ?? defaultCnMode(false);
  // cn 模式注入 HTTP_PROXY/HTTPS_PROXY/npm_config_registry，供 needsProxy 的官方安装器走代理
  const env = applyCnMode(cnMode);
  const primary = installCmd(tool, ctx.platform, cnMode.enabled);
  if (primary) {
    log(`[${tool.id}] 开始安装`);
    const r = await exec(primary, { env, timeout: INSTALL_TIMEOUT_MS });
    if (r.code === 0 && (await stateOf(tool)).installed) {
      ok(`[${tool.id}] 安装成功`);
      return 'ok';
    }
    failTail(tool.id, r.stderr);
  } else if (tool.fallback) {
    log(`[${tool.id}] 主通道无安装命令，尝试降级安装`);
  } else {
    fail(`[${tool.id}] 该平台无安装命令`);
    return 'failed';
  }

  if (tool.fallback) {
    log(`[${tool.id}] 降级安装（fallback）`);
    const r = await exec(applyNpmMirror(tool.fallback, cnMode.enabled), { env, timeout: INSTALL_TIMEOUT_MS });
    if (r.code === 0 && (await stateOf(tool)).installed) {
      ok(`[${tool.id}] 降级安装成功`);
      return 'ok';
    }
    failTail(tool.id, r.stderr);
  }

  fail(`[${tool.id}] 安装失败`);
  return 'failed';
}

/** 按 uninstall/uninstallWindows 执行卸载；无卸载命令或卸载失败不抛错 */
export async function uninstallAgent(tool: ToolSpec, platform: Platform): Promise<void> {
  const cmd = platform === 'windows' ? tool.uninstallWindows ?? tool.uninstall : tool.uninstall;
  if (!cmd) {
    log(`[${tool.id}] 无卸载命令，跳过`);
    return;
  }
  const r = await exec(cmd);
  if (r.code === 0) {
    ok(`[${tool.id}] 卸载成功`);
  } else {
    fail(`[${tool.id}] 卸载失败：${errorTail(r.stderr)}`);
  }
}

/** 输出失败日志时记录错误输出尾部（截断防刷屏） */
function failTail(id: string, stderr: string): void {
  fail(`[${id}] 执行失败：\n${errorTail(stderr)}`);
}

function errorTail(stderr: string): string {
  const s = stderr.trim();
  if (!s) return '(无错误输出)';
  return s.length > ERR_TAIL_MAX ? `...${s.slice(-ERR_TAIL_MAX)}` : s;
}
