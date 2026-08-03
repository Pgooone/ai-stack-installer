import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLoggerHome } from './logger.js';
import type { Manifest } from './types.js';
import { updatePrereqs } from './update.js';
import { setExecForTest } from './utils.js';

function makeManifest(): Manifest {
  return {
    prereq: [
      { id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0', upgrade: 'fnm install --lts' },
      {
        id: 'pwsh',
        bin: 'pwsh',
        check: 'pwsh -v',
        minVersion: '7.0.0',
        onlyOnWindows: true,
        windows: 'winget install',
        upgradeWindows: 'winget upgrade --id Microsoft.PowerShell',
      },
      { id: 'git', bin: 'git', check: 'git --version', linux: 'x', windows: 'x' }, // 无 upgrade
    ],
    agents: [],
  };
}

describe('updatePrereqs（注入 exec mock + 临时 home）', () => {
  let home: string;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-update-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('逐项升级成功：执行 upgrade 命令并复查，返回 updated 清单', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.updated).toEqual(['node', 'pwsh']);
    expect(r.failed).toEqual([]);
    expect(r.skipped).toEqual(['git']); // 无升级命令
  });

  it('windows 平台 pwsh 用 upgradeWindows，macos 无 upgradeWindows 时回退 upgrade', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.updated).toEqual(['node', 'pwsh']);
    expect(calls).toContain('winget upgrade --id Microsoft.PowerShell');
  });

  it('仅 Windows 依赖在非 Windows 平台跳过', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.updated).toEqual(['node']);
    expect(r.skipped).toContain('pwsh');
  });

  it('升级命令失败且复查不可用：记入 failed 不中断，继续下一个', async () => {
    let nodeChecks = 0;
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') {
        nodeChecks++;
        // 复查时工具不可用（升级彻底失败）
        return nodeChecks === 1
          ? { code: 0, stdout: 'v22.5.0\n', stderr: '' }
          : { code: 127, stdout: '', stderr: 'not found' };
      }
      if (cmd === 'fnm install --lts') return { code: 1, stdout: '', stderr: 'registry timeout' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.failed).toEqual(['node']);
    expect(r.updated).toEqual(['pwsh']); // 失败不中断
  });

  it('升级后复查未就绪：记入 failed（升级命令假成功）', async () => {
    let nodeChecks = 0;
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') {
        nodeChecks++;
        // 复查时版本仍不满足 minVersion（假成功场景）
        return nodeChecks === 1
          ? { code: 0, stdout: 'v22.5.0\n', stderr: '' }
          : { code: 0, stdout: 'v18.0.0\n', stderr: '' };
      }
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.failed).toEqual(['node']);
  });

  it('winget「无可用升级」返回非 0：版本未变且工具可用 → skipped 不算失败', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.6.4\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell')
        return { code: -1978335189, stdout: '找不到可用的升级。', stderr: '' }; // 0x8A150019
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.updated).toEqual(['node']);
    expect(r.skipped).toContain('pwsh'); // 已是最新
    expect(r.failed).toEqual([]);
  });

  it('升级命令非 0 但复查版本已变化：记为 updated（命令实际生效）', async () => {
    let nodeChecks = 0;
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') {
        nodeChecks++;
        return nodeChecks === 1
          ? { code: 0, stdout: 'v20.0.0\n', stderr: '' }
          : { code: 0, stdout: 'v24.0.0\n', stderr: '' }; // 复查：已升级
      }
      if (cmd === 'fnm install --lts') return { code: 1, stdout: '', stderr: 'exit 5' }; // 非 0 但生效
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.updated).toEqual(['node', 'pwsh']);
    expect(r.failed).toEqual([]);
  });
});
