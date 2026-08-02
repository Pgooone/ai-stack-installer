// manifest：加载/校验/查询/安装命令选择/状态探测（依赖：types, fs-locations, utils）
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Manifest, Platform, ToolSpec, ToolState } from './types.js';
import { CN_NPM_REGISTRY, exec, versionGte } from './utils.js';

const MANIFEST_FILE = 'manifest.json';
const CHECK_TIMEOUT_MS = 10_000;

/** 从 startDir 向上逐级查找 manifest.json（兼容 src/ 与 dist/ 两种深度，发布后从 npm 包内定位） */
export function findManifestPath(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, MANIFEST_FILE);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`未找到 ${MANIFEST_FILE}（从 ${startDir} 向上查找至根目录）`);
    }
    dir = parent;
  }
}

/** 加载仓库内 manifest.json 并做启动校验；dir 缺省以本模块所在位置为起点 */
export async function loadManifest(dir?: string): Promise<Manifest> {
  const startDir = dir ?? dirname(fileURLToPath(import.meta.url));
  const file = findManifestPath(startDir);
  const raw = await readFile(file, 'utf8');
  let parsed: Manifest;
  try {
    parsed = JSON.parse(raw) as Manifest;
  } catch (err) {
    throw new Error(`manifest.json 不是合法 JSON：${file}（${(err as Error).message}）`);
  }
  validateManifest(parsed);
  return parsed;
}

/** 启动校验：id 唯一、check/bin 非空、每平台至少一条安装命令；失败抛错并附修复信息 */
export function validateManifest(m: Manifest): void {
  const errors: string[] = [];
  const seen = new Set<string>();
  const all = [...(m.prereq ?? []), ...(m.agents ?? [])];

  for (const tool of all) {
    const label = tool.id || '(缺少 id)';
    if (!tool.id || tool.id.trim() === '') {
      errors.push('存在缺少 id 的工具');
    } else if (seen.has(tool.id)) {
      errors.push(`工具 id 重复：${tool.id}`);
    }
    seen.add(tool.id);

    if (!tool.bin || tool.bin.trim() === '') {
      errors.push(`[${label}] bin 为空`);
    }
    if (!tool.check || tool.check.trim() === '') {
      errors.push(`[${label}] check 为空`);
    }
    // 每平台至少一条安装命令：linux 需 linux|fallback；windows 需 windows|fallback；macos 缺省回退 linux
    if (!tool.linux && !tool.fallback) {
      errors.push(`[${label}] linux 平台缺少安装命令（linux 或 fallback）`);
    }
    if (!tool.windows && !tool.fallback) {
      errors.push(`[${label}] windows 平台缺少安装命令（windows 或 fallback）`);
    }
    if (!tool.macos && !tool.linux && !tool.fallback) {
      errors.push(`[${label}] macos 平台缺少安装命令（macos/linux 或 fallback）`);
    }
    if (tool.minVersion !== undefined && !/^\d+(\.\d+)*$/.test(tool.minVersion.trim())) {
      errors.push(`[${label}] minVersion 不是语义化版本：${tool.minVersion}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`manifest.json 校验失败，请修复以下问题后重试：\n- ${errors.join('\n- ')}`);
  }
}

export function getAgent(m: Manifest, id: string): ToolSpec | undefined {
  return m.agents.find((t) => t.id === id);
}

export function getPrereq(m: Manifest, id: string): ToolSpec | undefined {
  return m.prereq.find((t) => t.id === id);
}

/** 按平台选安装命令；cn 模式下 npm 命令自动加镜像 registry（命令已含 --registry= 时不重复注入） */
export function installCmd(tool: ToolSpec, platform: Platform, cnMode = false): string | undefined {
  let cmd: string | undefined;
  if (platform === 'windows') {
    cmd = tool.windows;
  } else if (platform === 'macos') {
    cmd = tool.macos ?? tool.linux;
  } else {
    cmd = tool.linux;
  }
  if (!cmd) return undefined;
  if (cnMode && isNpmCommand(cmd) && !cmd.includes('--registry=')) {
    return `${cmd} --registry=${CN_NPM_REGISTRY}`;
  }
  return cmd;
}

function isNpmCommand(cmd: string): boolean {
  return /^\s*npm(?:\s|$)/.test(cmd);
}

/** 跑 check 取首行版本；失败/超时视为未装；minVersion 不满足同样视为未装 */
export async function stateOf(tool: ToolSpec): Promise<ToolState> {
  const result = await exec(tool.check, { timeout: CHECK_TIMEOUT_MS });
  const base = { id: tool.id, bin: tool.bin };
  if (result.code !== 0) {
    return { ...base, installed: false };
  }
  const version = firstLine(result.stdout);
  if (!version) {
    // 命令成功但无版本输出：要求了 minVersion 则无法确认，按未装处理
    return { ...base, installed: tool.minVersion === undefined };
  }
  const installed = tool.minVersion === undefined || versionGte(version, tool.minVersion);
  return installed ? { ...base, installed: true, version } : { ...base, installed: false };
}

function firstLine(s: string): string {
  const line = s.trim().split(/\r?\n/)[0];
  return line ? line.trim() : '';
}
