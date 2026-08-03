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
  // 读取 profiles.list 找到 PowerShell 7 的实际 GUID：
  // 1. 静态显式 pwsh profile（commandline 指向 pwsh）→ 用其 GUID
  // 2. 否则用 Windows Terminal 内置固定 GUID（574e...）——pwsh 已装时 WT 会自动生成
  //    同 GUID 的动态 profile，**绝不添加静态 profile**（会与动态 profile GUID 冲突，
  //    WT 报「多个相同 GUID」错误）
  let pwshGuid = findPwshProfileGuid(raw);
  if (!pwshGuid) {
    // 清理历史误加的静态 574e profile（旧版本曾添加，与动态 profile 冲突）
    const cleaned = removeStaticPwshProfile(raw);
    if (cleaned) {
      raw = cleaned;
      await ok('已移除与 Windows Terminal 内置 profile 冲突的重复 PowerShell 7 profile');
    }
    pwshGuid = PWSH_GUID; // 动态 profile 的固定 GUID（pwsh 已安装时必然存在）
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

/**
 * 移除 profiles.list 中固定 GUID（574e...）的静态 profile——旧版本曾添加它，
 * 与 WT 内置动态 PowerShell 7 profile 同 GUID 冲突（WT 报「多个相同 GUID」）。
 * 移除后由动态 profile 接管。返回清理后的内容；无需清理返回 null。
 */
function removeStaticPwshProfile(raw: string): string | null {
  const listMatch = /("list"\s*:\s*\[)([\s\S]*?)(\]\s*[,}])/.exec(raw);
  if (!listMatch) return null;
  const body = listMatch[2];
  const profiles = extractProfiles(body); // 平衡花括号提取（GUID 值含嵌套花括号）
  let changed = false;
  let nextBody = body;
  for (const p of profiles) {
    const guid = /"guid"\s*:\s*"([^"]+)"/.exec(p)?.[1];
    if (guid !== PWSH_GUID) continue;
    // 只删 commandline 型（旧版本误加的残留）；source 型（PowershellCore 动态）是有效的，保留
    if (/"source"/.test(p)) continue;
    // 删除该 profile（连同前导逗号与缩进）
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    nextBody = nextBody.replace(new RegExp(`\\s*,\\s*${escaped}`), '');
    nextBody = nextBody.replace(new RegExp(`\\s*${escaped}\\s*`), '');
    changed = true;
  }
  if (!changed) return null;
  return raw.replace(listMatch[0], `${listMatch[1]}${nextBody}${listMatch[3]}`);
}

/** 定位 profiles.list 数组文本（"list" 键在 settings.json 唯一，容忍 profiles 对象内其他键如 defaults） */
function findListText(raw: string): string | null {
  const listMatch = /"list"\s*:\s*\[([\s\S]*?)\]\s*[,}]/.exec(raw);
  return listMatch ? listMatch[1] : null;
}

/**
 * 解析 profiles.list，返回 PowerShell 7 profile 的有效 GUID；未找到返回 null。
 * 判定规则：
 * - source=PowerShell（WT 动态/用户静态化）→ 有效，用其 guid（无则固定 574e）
 * - commandline 指向 pwsh 且 guid ≠ 574e → 用户自定义，用其 guid
 * - commandline 指向 pwsh 且 guid = 574e → 旧版本误加的残留（与动态 profile 冲突），
 *   跳过并返回 null（由调用方触发清理）
 */
export function findPwshProfileGuid(raw: string): string | null {
  const listText = findListText(raw);
  if (listText === null) return null;
  const profiles = extractProfiles(listText); // 平衡花括号提取（GUID 值含嵌套花括号）
  for (const p of profiles) {
    // Windows.Terminal.PowershellCore（pwsh 的动态 source profile）或显式 "PowerShell"
    if (/"source"\s*:\s*"Windows\.Terminal\.PowershellCore"/.test(p) || /"source"\s*:\s*"PowerShell"/.test(p)) {
      return /"guid"\s*:\s*"([^"]+)"/.exec(p)?.[1] ?? PWSH_GUID;
    }
  }
  for (const p of profiles) {
    const guid = /"guid"\s*:\s*"([^"]+)"/.exec(p)?.[1];
    if (guid === PWSH_GUID) continue; // 误加残留
    if (/"commandline"\s*:\s*"[^"]*pwsh/i.test(p)) return guid ?? null;
  }
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
