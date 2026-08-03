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
  report.terminalDefaultSet = await setTerminalDefault(pwshDir);
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
async function setTerminalDefault(pwshDir: string): Promise<boolean> {
  const wtSettings = join(process.env.LOCALAPPDATA ?? '', ...WT_SETTINGS_REL);
  let raw: string;
  try {
    raw = await readFile(wtSettings, 'utf8');
  } catch {
    await log('未检测到 Windows Terminal（跳过默认终端设置）');
    return false;
  }
  // 读取 profiles.list 找到真实存在的 PowerShell 7 profile 的 GUID
  // （用户可能自定义/静态化 profile，硬编码固定 GUID 会指向不存在的 profile 导致设置失败）
  let pwshGuid = findPwshProfileGuid(raw);
  if (!pwshGuid) {
    // WT 中没有 pwsh profile → 添加一个（commandline 指向 pwsh.exe）再设默认
    const pwshExe = join(pwshDir, 'pwsh.exe');
    const added = addPwshProfile(raw, pwshExe);
    if (!added) {
      await log('无法添加 PowerShell 7 profile 到 Windows Terminal（未找到 profiles.list）');
      return false;
    }
    raw = added.raw;
    pwshGuid = added.guid;
    await ok(`已在 Windows Terminal 添加 PowerShell 7 profile（${pwshExe}）`);
  }
  // 幂等：defaultProfile 已是该 pwsh profile
  if (new RegExp(`"defaultProfile"\\s*:\\s*"${pwshGuid.replace(/[{}]/g, '\\$&')}"`).test(raw)) {
    await log('Windows Terminal 默认 profile 已是 PowerShell 7');
    return false;
  }
  let next: string;
  if (/"defaultProfile"\s*:\s*"[^"]*"/.test(raw)) {
    next = raw.replace(/"defaultProfile"\s*:\s*"[^"]*"/, `"defaultProfile": "${pwshGuid}"`);
  } else {
    // 插入到第一个 { 之后（容忍开头有注释/BOM）
    const brace = raw.indexOf('{');
    next = raw.slice(0, brace + 1) + `\n  "defaultProfile": "${pwshGuid}",` + raw.slice(brace + 1);
  }
  await writeFile(wtSettings, next, 'utf8');
  await ok(`Windows Terminal 默认 profile 已设为 PowerShell 7（${pwshGuid}）`);
  return true;
}

/** 在 profiles.list 中插入一个 PowerShell 7 profile（固定 GUID + commandline 指向 pwsh.exe）；返回新内容与 GUID */
function addPwshProfile(raw: string, pwshExe: string): { raw: string; guid: string } | null {
  const listMatch = /("list"\s*:\s*\[)([\s\S]*?)(\]\s*[,}])/.exec(raw);
  if (!listMatch) return null;
  const escaped = pwshExe.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const profile = `{\n                "guid": "${PWSH_GUID}",\n                "name": "PowerShell 7",\n                "commandline": "${escaped}",\n                "hidden": false\n            }`;
  const items = listMatch[2].trim();
  const next = items ? `${items},\n            ${profile}` : profile;
  return { raw: raw.replace(listMatch[0], `${listMatch[1]}${next}${listMatch[3]}`), guid: PWSH_GUID };
}

/** 定位 profiles.list 数组文本（"list" 键在 settings.json 唯一，容忍 profiles 对象内其他键如 defaults） */
function findListText(raw: string): string | null {
  const listMatch = /"list"\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(raw);
  return listMatch ? listMatch[1] : null;
}

/** 解析 profiles.list，返回 PowerShell 7 profile 的实际 GUID；未找到返回 null */
export function findPwshProfileGuid(raw: string): string | null {
  const listText = findListText(raw);
  if (listText === null) return null;
  const profiles = extractProfiles(listText); // 平衡花括号提取（GUID 值含嵌套花括号）
  for (const p of profiles) {
    const isPwsh =
      /"source"\s*:\s*"PowerShell"/.test(p) || /"commandline"\s*:\s*"[^"]*pwsh/i.test(p);
    if (!isPwsh) continue;
    const guid = /"guid"\s*:\s*"([^"]+)"/.exec(p)?.[1];
    if (guid) return guid;
  }
  // source=PowerShell 的动态 profile 无显式 guid → Windows Terminal 内置固定 GUID
  if (profiles.some((p) => /"source"\s*:\s*"PowerShell"/.test(p))) return PWSH_GUID;
  return null;
}

/** 从 list 数组文本中提取各 profile 对象（平衡花括号，容忍 GUID 值里的嵌套花括号） */
function extractProfiles(listText: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = -1;
  for (let i = 0; i < listText.length; i++) {
    const ch = listText[i];
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(listText.slice(start, i + 1));
        start = -1;
      }
    }
  }
  return out;
}
