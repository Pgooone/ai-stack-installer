// 配置写入：settings.json 模板幂等写入、rc 标记块、文件位置清单（依赖：fs-locations, logger）
// home 注入以便测试；模板目录默认从 __dirname 向上定位（兼容 src/ 与 dist/），可注入覆盖
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configFiles, markers } from './fs-locations.js';
import type { Platform } from './types.js';
import { log, ok } from './logger.js';

export interface WriteConfigResult {
  /** 本次实际写入的文件路径 */
  written: string[];
}

export type AliasAction = 'written' | 'exists' | 'skipped';

export interface AliasResult {
  rcFile: string;
  action: AliasAction;
}

export interface FileReport {
  path: string;
  desc: string;
}

/** 从 startDir 向上查找含模板的 config/ 目录（兼容 src/ 与 dist/ 两种深度） */
function findConfigDir(startDir: string): string {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, 'config', 'claude.settings.json');
    if (existsSync(candidate)) return join(dir, 'config');
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`未找到 config/ 模板目录（从 ${startDir} 向上查找至根目录）`);
    }
    dir = parent;
  }
}

let configDirOverride: string | undefined;

/** 测试注入点：指定模板目录（传 undefined 恢复默认 __dirname 向上查找） */
export function setConfigDirForTest(dir: string | undefined): void {
  configDirOverride = dir;
}

function resolveConfigDir(): string {
  if (configDirOverride) return configDirOverride;
  return findConfigDir(dirname(fileURLToPath(import.meta.url)));
}

/** 幂等写入配置模板：目标不存在才写（force 除外）；返回实际写入清单 */
export async function writeConfigFiles(platform: Platform, force = false, home = os.homedir()): Promise<WriteConfigResult> {
  const configDir = resolveConfigDir();
  const written: string[] = [];
  for (const cf of configFiles(home)) {
    const templatePath = join(configDir, cf.template);
    if (!existsSync(templatePath)) {
      log(`跳过 ${cf.template}：模板不存在（${templatePath}）`);
      continue;
    }
    if (!force && existsSync(cf.path)) {
      log(`跳过 ${cf.path}：已存在（不覆盖已有配置）`);
      continue;
    }
    const content = await readFile(templatePath, 'utf8');
    await mkdir(dirname(cf.path), { recursive: true });
    await writeFile(cf.path, content, 'utf8');
    written.push(cf.path);
    ok(`写入 ${cf.path}`);
  }
  return { written };
}

/** rc 文件位置：windows 用 pwsh Profile.CurrentUserAllHosts，其余平台用 ~/.bashrc */
export function rcFileFor(platform: Platform, home: string = os.homedir()): string {
  if (platform === 'windows') {
    return join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
  }
  return join(home, '.bashrc');
}

/** 标记块内容：linux/macos 用 bash 语法，windows 用 PowerShell 语法（$PROFILE） */
function aliasBlock(platform: Platform): string {
  const body =
    platform === 'windows'
      ? [
          '# 强制 UTF-8 编码（避免中文乱码）',
          "$OutputEncoding = [System.Text.Encoding]::UTF8",
          "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
          "[Console]::InputEncoding = [System.Text.Encoding]::UTF8",
          "Set-Alias -Name c -Value claude",
          'function proxy_on {',
          "  $env:http_proxy = 'http://127.0.0.1:7890'",
          "  $env:https_proxy = 'http://127.0.0.1:7890'",
          '}',
          'function proxy_off {',
          '  Remove-Item Env:http_proxy -ErrorAction SilentlyContinue',
          '  Remove-Item Env:https_proxy -ErrorAction SilentlyContinue',
          '}',
        ]
      : [
          "alias c='claude'",
          'proxy_on() {',
          '  export http_proxy=http://127.0.0.1:7890',
          '  export https_proxy=http://127.0.0.1:7890',
          '}',
          'proxy_off() {',
          '  unset http_proxy',
          '  unset https_proxy',
          '}',
        ];
  return `${markers.start}\n${body.join('\n')}\n${markers.end}`;
}

/** 幂等写入别名/代理标记块：已有标记块跳过；rc 文件不存在则创建 */
export async function writeAliasBlock(platform: Platform, home = os.homedir()): Promise<AliasResult> {
  const rcFile = rcFileFor(platform, home);
  let content: string;
  try {
    content = await readFile(rcFile, 'utf8');
  } catch {
    content = ''; // rc 文件不存在 → 按新建处理
  }
  if (content.includes(markers.start)) {
    return { rcFile, action: 'exists' };
  }
  const block = aliasBlock(platform);
  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  try {
    await mkdir(dirname(rcFile), { recursive: true });
    await writeFile(rcFile, `${content}${separator}\n${block}\n`, 'utf8');
    ok(`写入 rc 标记块 ${rcFile}`);
    return { rcFile, action: 'written' };
  } catch (err) {
    log(`写入 rc 文件失败：${rcFile}（${(err as Error).message}）`);
    return { rcFile, action: 'skipped' };
  }
}

/** 透明性报告：本脚本写入的配置文件位置清单 */
export async function collectFileReport(platform: Platform, home = os.homedir()): Promise<FileReport[]> {
  return [
    ...configFiles(home).map((cf) => ({ path: cf.path, desc: `配置模板 ${cf.template} 生成` })),
    { path: rcFileFor(platform, home), desc: 'shell 别名/代理函数标记块' },
  ];
}

/** 输出文件位置清单（透明性：每处写入位置 + 清理方式提示） */
export async function printFileReport(platform: Platform, home = os.homedir()): Promise<void> {
  const report = await collectFileReport(platform, home);
  await log('文件位置清单（uninstall 可清理）：');
  for (const f of report) {
    await log(`- ${f.path}（${f.desc}）`);
  }
}

export type AliasRemoveAction = 'removed' | 'absent';

export interface AliasRemoveResult {
  rcFile: string;
  action: AliasRemoveAction;
}

/** 移除 rc 标记块（writeAliasBlock 的反向操作）；移除后仅剩空白则删除文件，保留用户原有内容 */
export async function removeAliasBlock(platform: Platform, home = os.homedir()): Promise<AliasRemoveResult> {
  const rcFile = rcFileFor(platform, home);
  let content: string;
  try {
    content = await readFile(rcFile, 'utf8');
  } catch {
    return { rcFile, action: 'absent' }; // rc 文件不存在，无块可移除
  }
  const start = content.indexOf(markers.start);
  if (start === -1) {
    return { rcFile, action: 'absent' };
  }
  const end = content.indexOf(markers.end, start);
  const before = content.slice(0, start).replace(/\r?\n+$/, '');
  const blockTail = end === -1 ? content.slice(start) : content.slice(end + markers.end.length);
  const after = blockTail.replace(/^\r?\n+/, '');
  const rest = before + (before && after ? '\n' : '') + after;
  if (rest.trim() === '') {
    // 标记块是文件全部内容（脚本创建的文件）→ 整个删除
    await rm(rcFile, { force: true });
  } else {
    await writeFile(rcFile, rest.endsWith('\n') ? rest : `${rest}\n`, 'utf8');
  }
  await log(`移除 rc 标记块 ${rcFile}`);
  return { rcFile, action: 'removed' };
}
