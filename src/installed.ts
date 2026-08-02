// installed.json：安装记录（本脚本创建的配置文件清单，uninstall 只删清单内文件）（依赖：fs-locations）
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { aiStackDir } from './fs-locations.js';

export interface InstalledRecord {
  version: 1;
  createdAt: string;
  /** 本脚本创建的文件路径（uninstall 只删这些） */
  files: string[];
}

export function installedFile(home: string): string {
  return join(aiStackDir(home), 'installed.json');
}

/** install 成功后写入记录（覆盖旧记录） */
export async function writeInstalledJson(home: string, files: string[]): Promise<void> {
  const record: InstalledRecord = { version: 1, createdAt: new Date().toISOString(), files };
  const file = installedFile(home);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
}

/** 读安装记录；缺失/损坏容错返回 null */
export async function readInstalledJson(home: string): Promise<InstalledRecord | null> {
  try {
    const raw = await readFile(installedFile(home), 'utf8');
    const parsed = JSON.parse(raw) as InstalledRecord;
    if (!Array.isArray(parsed.files)) return null;
    return parsed;
  } catch {
    return null;
  }
}
