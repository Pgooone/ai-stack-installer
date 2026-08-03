import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fileUnchanged,
  hashFile,
  installedFile,
  readInstalledJson,
  removeRecordedFiles,
  writeInstalledJson,
} from './installed.js';

describe('installed.json（v2：工具归属 + 文件 hash）', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'ai-stack-installed-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('首次写入：记录工具 id 与文件 hash', async () => {
    const f = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(f, 'a=1\n');
    const hash = await hashFile(f);
    await writeInstalledJson(home, [{ path: f, hash }], ['codex']);
    const record = await readInstalledJson(home);
    expect(record?.tools).toEqual(['codex']);
    expect(record?.files).toEqual([{ path: f, hash }]);
    expect(record?.version).toBe(2);
  });

  it('幂等重跑（本次 0 写入）：保留旧记录不清空——卸载完整性依赖此合并', async () => {
    const f = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(f, 'a=1\n');
    const hash = await hashFile(f);
    await writeInstalledJson(home, [{ path: f, hash }], ['codex']);
    await writeInstalledJson(home, [], []); // 重跑时全部已存在，本次 0 写入
    const record = await readInstalledJson(home);
    expect(record?.files).toEqual([{ path: f, hash }]);
    expect(record?.tools).toEqual(['codex']);
  });

  it('增量写入：新旧文件并集去重，工具并集去重', async () => {
    const a = join(home, '.claude', 'settings.json');
    const b = join(home, '.codex', 'config.toml');
    await mkdir(join(home, '.claude'), { recursive: true });
    await mkdir(join(home, '.codex'), { recursive: true });
    await writeFile(a, '{}');
    await writeFile(b, 'a=1\n');
    await writeInstalledJson(home, [{ path: a, hash: await hashFile(a) }], ['claude-code']);
    await writeInstalledJson(home, [{ path: a, hash: await hashFile(a) }, { path: b, hash: await hashFile(b) }], ['claude-code', 'codex']);
    const record = await readInstalledJson(home);
    expect(record?.files.map((f) => f.path)).toEqual([a, b]);
    expect(record?.tools).toEqual(['claude-code', 'codex']);
  });

  it('v1 旧记录兼容：files 字符串数组 → 转 {path, hash: undefined}，tools 为空', async () => {
    const file = installedFile(home);
    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ version: 1, createdAt: 'old', files: [join(home, 'x.json')] }), 'utf8');
    const record = await readInstalledJson(home);
    expect(record?.files).toEqual([{ path: join(home, 'x.json'), hash: undefined }]);
    expect(record?.tools).toEqual([]); // 旧记录无工具归属
  });

  it('文件缺失/损坏：readInstalledJson 容错返回 null', async () => {
    expect(await readInstalledJson(home)).toBeNull();
    const file = installedFile(home);
    const { mkdir, writeFile: wf } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(file), { recursive: true });
    await wf(file, 'not json', 'utf8');
    expect(await readInstalledJson(home)).toBeNull();
  });
});

describe('卸载安全（hash 校验）', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(os.tmpdir(), 'ai-stack-safe-'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const noop = async (m: string) => m;

  it('文件内容未变：可删除（unchanged）', async () => {
    const f = join(home, 'cfg.json');
    await writeFile(f, '{"a":1}');
    const record = { version: 2 as const, createdAt: '', tools: [], files: [{ path: f, hash: await hashFile(f) }] };
    expect(await fileUnchanged(record, record.files[0])).toBe(true);
    const { removed, kept } = await removeRecordedFiles(record, noop, noop, noop);
    expect(removed).toEqual([f]);
    expect(kept).toEqual([]);
    await expect(readFile(f, 'utf8')).rejects.toThrow();
  });

  it('文件被用户修改过（hash 不匹配）：保留不删', async () => {
    const f = join(home, 'cfg.json');
    await writeFile(f, '{"a":1}');
    const hash = await hashFile(f);
    await writeFile(f, '{"a":2}'); // 用户修改
    const record = { version: 2 as const, createdAt: '', tools: [], files: [{ path: f, hash }] };
    expect(await fileUnchanged(record, record.files[0])).toBe(false);
    const { removed, kept } = await removeRecordedFiles(record, noop, noop, noop);
    expect(removed).toEqual([]);
    expect(kept).toEqual([f]);
    await expect(readFile(f, 'utf8')).resolves.toBe('{"a":2}'); // 内容保留
  });

  it('hash 缺失（旧记录）：保守不删', async () => {
    const f = join(home, 'cfg.json');
    await writeFile(f, 'x');
    const record = { version: 2 as const, createdAt: '', tools: [], files: [{ path: f, hash: undefined }] };
    expect(await fileUnchanged(record, record.files[0])).toBe(false);
    const { removed } = await removeRecordedFiles(record, noop, noop, noop);
    expect(removed).toEqual([]);
    await expect(readFile(f, 'utf8')).resolves.toBe('x');
  });

  it('文件已不存在：视为一致，跳过删除', async () => {
    const f = join(home, 'gone.json');
    const record = { version: 2 as const, createdAt: '', tools: [], files: [{ path: f, hash: 'abc' }] };
    expect(await fileUnchanged(record, record.files[0])).toBe(true);
    const { removed, kept } = await removeRecordedFiles(record, noop, noop, noop);
    expect(removed).toEqual([]);
    expect(kept).toEqual([]);
  });

  it('记录缺失：容错返回空', async () => {
    const { removed, kept } = await removeRecordedFiles(null, noop, noop, noop);
    expect(removed).toEqual([]);
    expect(kept).toEqual([]);
  });
});
