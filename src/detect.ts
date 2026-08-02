// 环境探测：平台/WSL/Node/工具批量状态（依赖：types, utils, manifest）
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { stateOf } from './manifest.js';
import type { DetectInfo, Manifest, Platform, ToolState } from './types.js';

export async function detect(): Promise<DetectInfo> {
  const platform = normalizePlatform(process.platform);
  return {
    platform,
    isWsl: platform === 'linux' ? await checkWsl() : false,
    arch: process.arch,
    home: os.homedir(),
  };
}

function normalizePlatform(raw: NodeJS.Platform): Platform {
  if (raw === 'win32') return 'windows';
  if (raw === 'darwin') return 'macos';
  if (raw === 'linux') return 'linux';
  throw new Error(`不支持的平台：${raw}`);
}

/** linux 下读 /proc/version，含 microsoft → WSL */
async function checkWsl(): Promise<boolean> {
  try {
    const version = await readFile('/proc/version', 'utf8');
    return /microsoft/i.test(version);
  } catch {
    return false; // 读不到（如受限容器）按非 WSL 处理
  }
}

/** node -v 主版本 ≥20 才算可用（复用 stateOf 的版本比较） */
export async function detectNode(): Promise<ToolState> {
  return stateOf({ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' });
}

/** 批量探测 prereq + agents（optIn 工具也包含在 agents 内） */
export async function detectTools(m: Manifest): Promise<ToolState[]> {
  return Promise.all([...m.prereq, ...m.agents].map((tool) => stateOf(tool)));
}
