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

  it('-y：跳过确认，逐个卸载 agents + optInAgents（linux 用 uninstall，windows 优先 uninstallWindows）', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    expect(code).toBe(0);
    expect(mocks.confirm).not.toHaveBeenCalled();
    expect(calls).toEqual(['npm uninstall -g @anthropic-ai/claude-code', 'winget uninstall --id farion1231.CC-Switch --exact']);

    calls.length = 0;
    await runUninstall({ manifest: makeManifest(), platform: 'windows', home, yes: true });
    expect(calls).toEqual(['npm uninstall -g @anthropic-ai/claude-code', 'winget uninstall --id farion1231.CC-Switch --exact']);
  });

  it('installed.json 缺失：容错跳过文件删除，其余流程正常（rc 块 + ~/.ai-stack）', async () => {
    const code = await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    expect(code).toBe(0);
    // ~/.ai-stack 被删除（即便不存在也 force）
  });

  it('只删 installed.json 清单内的文件，不删用户自己的文件', async () => {
    const listed = [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')];
    const userFile = join(home, '.claude', 'settings.user.json');
    for (const f of [...listed, userFile]) {
      await mkdir(join(f, '..'), { recursive: true });
      await writeFile(f, '{}');
    }
    await mkdir(join(home, '.ai-stack'), { recursive: true });
    await writeFile(
      join(home, '.ai-stack', 'installed.json'),
      JSON.stringify({ version: 1, createdAt: 'now', files: listed }),
    );
    await runUninstall({ manifest: makeManifest(), platform: 'linux', home, yes: true });
    await expect(readFile(listed[0], 'utf8')).rejects.toThrow(); // 清单内文件已删
    await expect(readFile(listed[1], 'utf8')).rejects.toThrow();
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
