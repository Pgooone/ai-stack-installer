// installed.json：安装记录（本脚本安装的工具 + 创建的文件及内容 hash，卸载安全依赖）
// 卸载安全：只卸记录内的工具、只删 hash 匹配的文件——用户原有的工具/改过的配置绝不误删
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { aiStackDir } from './fs-locations.js';

/** 记录的文件条目：hash 为写入时内容摘要，卸载前校验（变了说明用户改过，不删） */
export interface InstalledFile {
  path: string;
  hash?: string;
}

export interface InstalledRecord {
  version: 2;
  createdAt: string;
  /** 本脚本实际安装的工具 id（安装时 skipped 的用户已有工具绝不记录） */
  tools: string[];
  /** 本脚本创建的文件（uninstall 只删 hash 匹配的） */
  files: InstalledFile[];
}

export function installedFile(home: string): string {
  return join(aiStackDir(home), 'installed.json');
}

/** 计算文件内容 SHA-256；文件不存在返回 undefined */
export async function hashFile(path: string): Promise<string | undefined> {
  try {
    const buf = await readFile(path);
    return createHash('sha256').update(buf).digest('hex');
  } catch {
    return undefined;
  }
}

/**
 * install 成功后写入记录（与旧记录累计合并：幂等重跑时本次可能 0 写入，
 * 若直接覆盖会把先前记录清空，导致 uninstall 漏删配置——卸载完整性依赖此合并）
 */
export async function writeInstalledJson(
  home: string,
  files: InstalledFile[],
  tools: string[],
): Promise<void> {
  const prev = await readInstalledJson(home);
  const prevFiles = prev?.files ?? [];
  const mergedFiles = [...prevFiles];
  for (const f of files) {
    if (!mergedFiles.some((m) => m.path === f.path)) mergedFiles.push(f);
  }
  const mergedTools = [...new Set([...(prev?.tools ?? []), ...tools])];
  const record: InstalledRecord = { version: 2, createdAt: new Date().toISOString(), tools: mergedTools, files: mergedFiles };
  const file = installedFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/**
 * 读安装记录；缺失/损坏容错返回 null。
 * 兼容 v1 旧记录（files 为 string[]、无 tools）：hash 缺失视为「无法校验」，
 * 卸载时按保守策略处理（不删文件、不卸工具）
 */
export async function readInstalledJson(home: string): Promise<InstalledRecord | null> {
  try {
    const raw = await readFile(installedFile(home), 'utf8');
    const parsed = JSON.parse(raw) as InstalledRecord;
    if (parsed.version === 2) {
      if (!Array.isArray(parsed.files) || !Array.isArray(parsed.tools)) return null;
      return parsed;
    }
    // v1 兼容：files 为字符串数组
    if (Array.isArray(parsed.files) && parsed.files.every((f) => typeof f === 'string')) {
      return {
        version: 2,
        createdAt: parsed.createdAt ?? '',
        tools: [],
        files: (parsed.files as unknown as string[]).map((p) => ({ path: p, hash: undefined })),
      };
    }
    return null;
  } catch {
    return null;
  }
}

/** 卸载辅助：校验文件是否与记录 hash 一致；无记录/hash 缺失/内容变了 → false（不删） */
export async function fileUnchanged(record: InstalledRecord | null, file: InstalledFile): Promise<boolean> {
  if (!file.hash) return false; // 无法校验（旧记录）→ 保守不删
  const now = await hashFile(file.path);
  if (now === undefined) return true; // 文件已不存在，视为一致（删除无意义，直接跳过）
  return now === file.hash;
}

/** 删除记录中的文件；hash 不匹配的保留并返回其路径（卸载安全） */
export async function removeRecordedFiles(
  record: InstalledRecord | null,
  log: (msg: string) => Promise<void>,
  ok: (msg: string) => Promise<void>,
  warn: (msg: string) => Promise<void>,
): Promise<{ removed: string[]; kept: string[] }> {
  if (!record) {
    await log('未找到 installed.json，跳过配置文件删除');
    return { removed: [], kept: [] };
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const file of record.files) {
    const now = await hashFile(file.path);
    if (now === undefined) continue; // 文件已不存在，无需删除
    if (file.hash !== undefined && now === file.hash) {
      await rm(file.path, { force: true });
      await ok(`删除 ${file.path}`);
      removed.push(file.path);
    } else {
      await warn(`保留 ${file.path}：内容与安装时不同（可能被修改过），请自行确认后手动删除`);
      kept.push(file.path);
    }
  }
  return { removed, kept };
}
