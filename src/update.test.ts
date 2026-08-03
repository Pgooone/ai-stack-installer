import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLoggerHome } from './logger.js';
import type { Manifest } from './types.js';
import { detectUpdates, updatePrereqs } from './update.js';
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
        windows: 'winget install --id Microsoft.PowerShell -e --silent --accept-source-agreements --accept-package-agreements',
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
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
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id Microsoft.PowerShell') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.updated).toEqual(['node', 'pwsh']);
    expect(r.failed).toEqual([]);
  });

  it('only 限定：只更新选中的组件', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'fnm install --lts') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'linux', home }, ['node']);
    expect(r.updated).toEqual(['node']);
    expect(calls).not.toContain('winget upgrade --id Microsoft.PowerShell'); // pwsh 未被选中不执行
  });
});

describe('detectUpdates（winget --dry-run 退出码判断可用更新）', () => {
  let home: string;
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-det-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('windows：dry-run 退出码 0 → 有更新；非 0（无可用升级）→ 已最新', async () => {
    // 与产品 manifest 一致的 fixture：node 补 upgradeWindows（含 --id 语法）；pwsh 已有；git 无升级命令
    const m = makeManifest();
    m.prereq = [
      { ...m.prereq[0], upgradeWindows: 'winget upgrade --id OpenJS.NodeJS.LTS -e --silent' },
      m.prereq[1],
      m.prereq[2],
    ];
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      if (cmd === 'winget upgrade --id OpenJS.NodeJS.LTS --dry-run --accept-source-agreements --accept-package-agreements')
        return { code: 0, stdout: '可用的升级', stderr: '' }; // 有更新
      if (cmd === 'winget upgrade --id Microsoft.PowerShell --dry-run --accept-source-agreements --accept-package-agreements')
        return { code: -1978335189, stdout: '找不到可用的升级', stderr: '' }; // 已最新
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await detectUpdates({ manifest: m, platform: 'windows', home });
    const node = r.find((c) => c.tool.id === 'node');
    const pwsh = r.find((c) => c.tool.id === 'pwsh');
    const git = r.find((c) => c.tool.id === 'git');
    expect(node?.hasUpdate).toBe(true);
    expect(pwsh?.hasUpdate).toBe(false);
    expect(git?.hasUpdate).toBeUndefined(); // 无升级命令 → 无法检测
  });

  it('非 windows 平台：检测机制暂缺 → hasUpdate undefined', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 0, stdout: 'PowerShell 7.4.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await detectUpdates({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.every((c) => c.hasUpdate === undefined)).toBe(true);
  });

  it('未安装的组件：标记「需要安装」而非「已是最新」（winget dry-run 对未装包也返回非 0）', async () => {
    // 与产品 manifest 一致的 fixture：node/pwsh 带 upgradeWindows
    const m = makeManifest();
    m.prereq = [
      { ...m.prereq[0], upgradeWindows: 'winget upgrade --id OpenJS.NodeJS.LTS -e --silent' },
      m.prereq[1],
      m.prereq[2],
    ];
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'pwsh -v') return { code: 127, stdout: '', stderr: 'not found' }; // pwsh 未安装
      if (cmd.startsWith('winget upgrade --id OpenJS.NodeJS.LTS --dry-run'))
        return { code: 0, stdout: '可用的升级', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await detectUpdates({ manifest: m, platform: 'windows', home });
    const pwsh = r.find((c) => c.tool.id === 'pwsh');
    expect(pwsh?.hasUpdate).toBe(true); // 未安装 → 需要安装
    expect(pwsh?.current).toBeUndefined();
  });

  it('未安装的组件：updatePrereqs 走安装命令而非 upgrade（winget upgrade 对未装包无效）', async () => {
    const calls: string[] = [];
    let pwshChecks = 0;
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd === 'pwsh -v') {
        pwshChecks++;
        // 安装前未装；安装后复查就绪
        return pwshChecks === 1
          ? { code: 127, stdout: '', stderr: 'not found' }
          : { code: 0, stdout: 'PowerShell 7.6.4\n', stderr: '' };
      }
      if (cmd === 'winget install --id Microsoft.PowerShell -e --silent --accept-source-agreements --accept-package-agreements')
        return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await updatePrereqs({ manifest: makeManifest(), platform: 'windows', home }, ['pwsh']);
    expect(r.updated).toEqual(['pwsh']);
    // 走 install 而非 upgrade（winget upgrade 对未装包无效）
    expect(calls).toEqual([
      'pwsh -v',
      'winget install --id Microsoft.PowerShell -e --silent --accept-source-agreements --accept-package-agreements',
      'pwsh -v',
    ]);
  });
});
