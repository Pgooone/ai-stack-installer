import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installedFile, readInstalledJson, writeInstalledJson } from './installed.js';

describe('installed.json（累计合并语义）', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'ai-stack-installed-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('首次写入：记录本次写入的文件', async () => {
    await writeInstalledJson(home, [join(home, '.codex', 'config.toml')]);
    const record = await readInstalledJson(home);
    expect(record?.files).toEqual([join(home, '.codex', 'config.toml')]);
  });

  it('幂等重跑（本次 0 写入）：保留旧记录不清空——卸载完整性依赖此合并', async () => {
    const first = join(home, '.codex', 'config.toml');
    await writeInstalledJson(home, [first]);
    await writeInstalledJson(home, []); // 重跑时全部已存在，本次 0 写入
    const record = await readInstalledJson(home);
    expect(record?.files).toEqual([first]);
  });

  it('增量写入：新旧清单并集去重', async () => {
    const a = join(home, '.claude', 'settings.json');
    const b = join(home, '.codex', 'config.toml');
    await writeInstalledJson(home, [a]);
    await writeInstalledJson(home, [a, b]); // a 重复
    const record = await readInstalledJson(home);
    expect(record?.files).toEqual([a, b]);
  });

  it('记录文件落盘于 ~/.ai-stack/installed.json，内容为合法 JSON', async () => {
    await writeInstalledJson(home, [join(home, 'x')]);
    const raw = JSON.parse(await readFile(installedFile(home), 'utf8'));
    expect(raw.version).toBe(1);
    expect(Array.isArray(raw.files)).toBe(true);
    expect(typeof raw.createdAt).toBe('string');
  });

  it('文件缺失/损坏：readInstalledJson 容错返回 null', async () => {
    expect(await readInstalledJson(home)).toBeNull();
    const file = installedFile(home);
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, 'not json', 'utf8');
    expect(await readInstalledJson(home)).toBeNull();
  });
});
