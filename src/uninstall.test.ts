import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLoggerHome } from './logger.js';
import type { Manifest } from './types.js';
import * as utils from './utils.js';
import { setExecForTest } from './utils.js';

const mocks = vi.hoisted(() => {
  const CANCEL = Symbol('cancel');
  return {
    CANCEL,
    confirm: vi.fn(),
    isCancel: (v: unknown): boolean => v === CANCEL,
  };
});

vi.mock('@clack/prompts', () => ({ confirm: mocks.confirm, isCancel: mocks.isCancel }));

import { runUninstall } from './uninstall.js';

function makeManifest(): Manifest {
  return {
    prereq: [{ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' }],
    agents: [
      {
        id: 'claude-code',
        bin: 'claude',
        check: 'claude --version',
        linux: 'x',
        windows: 'x',
        uninstall: 'npm uninstall -g @anthropic-ai/claude-code',
      },
      { id: 'codex', bin: 'codex', check: 'codex --version', linux: 'x', windows: 'x' },
    ],
    optInAgents: [
      {
        id: 'cc-switch',
        bin: 'cc-switch',
        check: 'cc-switch',
        optIn: true,
        linux: 'x',
        windows: 'x',
        uninstall: 'winget uninstall --id farion1231.CC-Switch --exact',
        uninstallWindows: 'winget uninstall --id farion1231.CC-Switch --exact',
      },
    ],
  };
}

describe('runUninstall（临时 home + mock exec/clack，不触碰真实环境）', () => {
  let tmpRoot: string;
  let home: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-uninst-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    mocks.confirm.mockReset();
    vi.spyOn(utils, 'detectTty').mockReturnValue(true); // 默认有 TTY，可走确认分支
    setExecForTest(async () => ({ code: 0, stdout: '', stderr: '' }));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    setExecForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('确认拒绝（默认 N）：不执行任何卸载命令、不删除任何文件', async () => {
    mocks.confirm.mockResolvedValueOnce(false);
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home });
    expect(code).toBe(0);
    expect(calls).toEqual([]); // 无卸载命令执行
    expect(mocks.confirm).toHaveBeenCalledTimes(1);
    // 默认值必须是 N（initialValue: false）
    expect(mocks.confirm.mock.calls[0][0].initialValue).toBe(false);
  });

  it('确认取消（clack cancel）→ 退出码 130', async () => {
    mocks.confirm.mockResolvedValueOnce(mocks.CANCEL);
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home });
    expect(code).toBe(130);
  });

  it('非 TTY 且无 -y：视为拒绝（安全默认），不执行', async () => {
    vi.mocked(utils.detectTty).mockReturnValue(false);
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home });
    expect(code).toBe(0);
    expect(calls).toEqual([]);
    expect(mocks.confirm).not.toHaveBeenCalled();
  });

  it('-y：跳过确认，只卸 installed.json 记录的已安装工具（用户原有的不卸）', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    // 记录本脚本安装的 claude-code + cc-switch（codex 未记录 = 用户原有，不卸）
    await mkdir(join(home, '.ai-stack'), { recursive: true });
    await writeFile(
      join(home, '.ai-stack', 'installed.json'),
      JSON.stringify({ version: 2, createdAt: 'now', tools: ['claude-code', 'cc-switch'], files: [] }),
    );
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    expect(code).toBe(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(['npm uninstall -g @anthropic-ai/claude-code', 'winget uninstall --id farion1231.CC-Switch --exact']);

    // 第一次卸载已删除 ~/.ai-stack（含 installed.json），windows 场景前重新写入
    calls.length = 0;
    await mkdir(join(home, '.ai-stack'), { recursive: true });
    await writeFile(
      join(home, '.ai-stack', 'installed.json'),
      JSON.stringify({ version: 2, createdAt: 'now', tools: ['claude-code', 'cc-switch'], files: [] }),
    );
    await runUninstall({ manifest: makeManifest(), platform: 'windows', home, yes: true });
    expect(calls).toEqual(['npm uninstall -g @anthropic-ai/claude-code', 'winget uninstall --id farion1231.CC-Switch --exact']);
  });

  it('无工具记录（旧版 installed.json / 全为已有）：不卸任何工具', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    expect(code).toBe(0);
    expect(calls).toEqual([]); // 未检测到本脚本安装的工具 → 零卸载
  });

  it('installed.json 缺失：容错跳过文件删除，其余流程正常（rc 块 + ~/.ai-stack）', async () => {
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    expect(code).toBe(0);
    // ~/.ai-stack 被删除（即便不存在也 force）
  });

  it('只删 hash 匹配的记录文件，不删用户自己的文件；被修改过的记录文件保留', async () => {
    const listed = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')];
    const userFile = join(home, '.claude', 'settings.user.json');
    const modified = join(home, '.claude', 'modified.json');
    for (const f of [...listed, userFile, modified]) {
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, '{}');
    }
    const { createHash } = await import('node:crypto');
    const hashOf = () => createHash('sha256').update('{}').digest('hex');
    await mkdir(join(home, '.ai-stack'), { recursive: true });
    await writeFile(
      join(home, '.ai-stack', 'installed.json'),
      JSON.stringify({
        version: 2,
        createdAt: 'now',
        tools: [],
        files: [
          { path: listed[0], hash: hashOf(listed[0]) },
          { path: listed[1], hash: hashOf(listed[1]) },
          { path: modified, hash: 'wrong-hash' }, // 与磁盘内容不符（被修改过）
        ],
      }),
    );
    await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    await expect(readFile(listed[0], 'utf8')).rejects.toThrow(); // hash 匹配 → 已删
    await expect(readFile(listed[1], 'utf8')).rejects.toThrow();
    await expect(readFile(modified, 'utf8')).resolves.toBe('{}'); // 被修改过 → 保留
    await expect(readFile(userFile, 'utf8')).resolves.toBe('{}'); // 用户文件保留
  });

  it('rc 标记块被移除，用户原有内容保留', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, 'export EDITOR=vim\n# >>> ai-stack >>>\nalias c=\'claude\'\n# <<< ai-stack <<<\n');
    await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    const content = await readFile(rc, 'utf8');
    expect(content).toContain('export EDITOR=vim');
    expect(content).not.toContain('ai-stack');
  });

  it('rc 文件只有标记块（脚本创建的）：整个删除', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, '# >>> ai-stack >>>\nalias c=\'claude\'\n# <<< ai-stack <<<\n');
    await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    await expect(readFile(rc, 'utf8')).rejects.toThrow();
  });

  it('~/.ai-stack 目录（日志+安装记录）被删除', async () => {
    const dir = join(home, '.ai-stack');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'install.log'), 'log\n');
    await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    await expect(readFile(join(dir, 'install.log'), 'utf8')).rejects.toThrow();
  });
});
