// pwsh 集成（仅 Windows）：PATH 优先级提升 + Windows Terminal 默认 profile
// 需求：PowerShell 7 升级后必须把其路径提到用户 PATH 首位（否则新终端不会默认调用 pwsh），
//       并让 Windows Terminal 默认打开 PowerShell 7 而非 Windows PowerShell/cmd
// 依赖：utils, logger
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { log, ok, warn } from './logger.js';
import type { Platform } from './types.js';
import { exec } from './utils.js';

export interface PwshIntegrationReport {
  pathFixed: boolean;
  terminalDefaultSet: boolean;
  note?: string;
}

/** Windows Terminal 内置 PowerShell 7 profile 的固定 GUID（docs：Microsoft.WindowsTerminal） */
const PWSH_GUID = '{574e775e-4f2a-5b96-ac1e-a2962a402336}';
const WT_SETTINGS_REL = ['Packages', 'Microsoft.WindowsTerminal_8wekyb3d8bbwe', 'LocalState', 'settings.json'];

/** 确保 pwsh 优先：用户 PATH 首位 + Windows Terminal 默认 profile；幂等，无改动返回 false */
export async function ensurePwshIntegration(platform: Platform): Promise<PwshIntegrationReport> {
  if (platform !== 'windows') return { pathFixed: false, terminalDefaultSet: false };
  const report: PwshIntegrationReport = { pathFixed: false, terminalDefaultSet: false };
  const pwshDir = await findPwshDir();
  if (!pwshDir) {
    report.note = '未找到 pwsh（PowerShell 7 未安装），跳过集成';
    return report;
  }
  report.pathFixed = await promotePwshInPath(pwshDir);
  report.terminalDefaultSet = await setTerminalDefault();
  return report;
}

/** 取 pwsh.exe 所在目录（Get-Command 源路径去掉文件名） */
async function findPwshDir(): Promise<string | null> {
  const r = await exec('(Get-Command pwsh -ErrorAction SilentlyContinue).Source');
  if (r.code !== 0) return null;
  const src = r.stdout.trim();
  if (!src) return null;
  return src.replace(/\\pwsh\.exe$/i, '');
}

/**
 * 把 pwsh 目录提升到**系统 PATH 首位**（Windows 解析顺序 = 系统 PATH 在前 + 用户 PATH 在后，
 * MSI ADD_PATH=1 会把 pwsh 加入系统 PATH——只提升用户 PATH 竞争不过系统 PATH，必须提升系统级）。
 * 写 Machine 环境变量需要管理员权限；无权限时降级提升用户 PATH 并提示。
 */
async function promotePwshInPath(pwshDir: string): Promise<boolean> {
  const norm = (p: string) => p.trim().replace(/\\+$/, '').toLowerCase();
  const target = norm(pwshDir);
  // 1. 尝试系统 PATH（主）
  const r = await exec('[Environment]::GetEnvironmentVariable("Path","Machine")');
  const sysParts = (r.stdout.trim() || '').split(';').filter(Boolean);
  const sysIdx = sysParts.findIndex((p) => norm(p) === target);
  if (sysIdx === 0) {
    await log(`PowerShell 7 已在系统 PATH 首位（${pwshDir}）`);
    return false;
  }
  if (sysIdx > 0) sysParts.splice(sysIdx, 1);
  sysParts.unshift(pwshDir);
  const sysEscaped = sysParts.join(';').replace(/'/g, "''");
  const w = await exec(`[Environment]::SetEnvironmentVariable("Path", '${sysEscaped}', "Machine")`);
  if (w.code === 0) {
    await ok(`已将 PowerShell 7 提升到系统 PATH 首位（${pwshDir}），新终端生效`);
    return true;
  }
  // 2. 无管理员权限：降级提升用户 PATH（对不在系统 PATH 的场景仍有效），并明确提示
  await warn('提升系统 PATH 需要管理员权限（当前无权限），降级提升用户 PATH');
  const ur = await exec('[Environment]::GetEnvironmentVariable("Path","User")');
  const userParts = (ur.stdout.trim() || '').split(';').filter(Boolean);
  const userIdx = userParts.findIndex((p) => norm(p) === target);
  if (userIdx > 0) userParts.splice(userIdx, 1);
  userParts.unshift(pwshDir);
  const userEscaped = userParts.join(';').replace(/'/g, "''");
  const uw = await exec(`[Environment]::SetEnvironmentVariable("Path", '${userEscaped}', "User")`);
  if (uw.code === 0) {
    await ok(`已将 PowerShell 7 提升到用户 PATH 首位（${pwshDir}）；如需系统级请以管理员身份运行`);
    return true;
  }
  await warn('PATH 提升失败：请以管理员身份运行本脚本');
  return false;
}

/** Windows Terminal settings.json（JSONC 允许注释——文本操作保留原格式）设置 defaultProfile 为 pwsh */
async function setTerminalDefault(): Promise<boolean> {
  const wtSettings = join(process.env.LOCALAPPDATA ?? '', ...WT_SETTINGS_REL);
  let raw: string;
  try {
    raw = await readFile(wtSettings, 'utf8');
  } catch {
    await log('未检测到 Windows Terminal（跳过默认终端设置）');
    return false;
  }
  // 幂等：defaultProfile 已是 pwsh（含用户静态化 profile 的场景）
  if (new RegExp(`"defaultProfile"\\s*:\\s*"${PWSH_GUID.replace(/[{}]/g, '\\$&')}"`).test(raw)) {
    await log('Windows Terminal 默认 profile 已是 PowerShell 7');
    return false;
  }
  const hasPwshProfile = /"source"\s*:\s*"PowerShell"/.test(raw) || /commandline[^}]*pwsh/i.test(raw);
  if (!hasPwshProfile) {
    await log('Windows Terminal 无 PowerShell 7 profile（可能未安装 Windows Terminal 或 pwsh），跳过');
    return false;
  }
  let next: string;
  if (/"defaultProfile"\s*:\s*"[^"]*"/.test(raw)) {
    next = raw.replace(/"defaultProfile"\s*:\s*"[^"]*"/, `"defaultProfile": "${PWSH_GUID}"`);
  } else {
    // 插入到第一个 { 之后（容忍开头有注释/BOM）
    const brace = raw.indexOf('{');
    next = raw.slice(0, brace + 1) + `\n  "defaultProfile": "${PWSH_GUID}",` + raw.slice(brace + 1);
  }
  await writeFile(wtSettings, next, 'utf8');
  await ok(`Windows Terminal 默认 profile 已设为 PowerShell 7（${wtSettings}）`);
  return true;
}
