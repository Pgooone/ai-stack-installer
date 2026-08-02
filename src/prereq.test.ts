import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setLoggerHome } from './logger.js';
import { ensurePrereqs } from './prereq.js';
import type { Manifest } from './types.js';
import { setExecForTest } from './utils.js';

const FNM_SCRIPT = 'curl -fsSL https://fnm.vercel.app/install | bash';
const WINGET_NODE =
  'winget install --id OpenJS.NodeJS.LTS -e --silent --accept-source-agreements --accept-package-agreements';

function makeManifest(): Manifest {
  return {
    prereq: [
      {
        id: 'node',
        bin: 'node',
        check: 'node -v',
        minVersion: '20.0.0',
        linux: 'fnm install --lts',
        windows: 'winget install --id OpenJS.NodeJS.LTS -e --silent',
      },
      {
        id: 'git',
        bin: 'git',
        check: 'git --version',
        linux: 'apt install -y git',
        windows: 'winget install --id Git.Git -e --silent',
      },
    ],
    agents: [],
  };
}

describe('ensurePrereqs（注入 exec mock + 临时 home，不真跑 fnm/winget/curl）', () => {
  let home: string;
  let tmpRoot: string;
  const originalPath = process.env.PATH;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-prereq-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    process.env.PATH = originalPath;
  });

  afterEach(async () => {
    setExecForTest(undefined);
    process.env.PATH = originalPath;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('node ≥20 已满足：跳过安装，不执行任何安装命令', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      throw new Error(`不应执行安装命令：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.failed).toEqual([]);
    expect(calls).toEqual(['node -v', 'git --version']);
  });

  it('linux node 不满足：走 fnm（安装脚本 + fnm install --lts），并导出 fnm PATH', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v18.20.1\n', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' }; // curl / fnm 命令视为成功
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.failed).toEqual([]);
    expect(calls[0]).toBe('node -v');
    expect(calls[1]).toBe(FNM_SCRIPT);
    expect(calls[2]).toContain('fnm install --lts');
    // 安装后导出 PATH：fnm bin 与 aliases/default/bin 都进入进程 PATH
    expect(process.env.PATH).toContain(join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'));
    expect(process.env.PATH).toContain(join(home, '.local', 'share', 'fnm'));
  });

  it('linux fnm 安装脚本失败：node 记入 failed，仍继续检查后续 prereq', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v18.20.1\n', stderr: '' };
      if (cmd === FNM_SCRIPT) return { code: 1, stdout: '', stderr: 'curl: could not resolve host' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.failed).toEqual(['node']);
    expect(calls[calls.length - 1]).toBe('git --version'); // git 仍被检查，不中断
  });

  it('windows node 不满足：走 winget，装完重读 Machine+User PATH 刷新会话', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v18.20.1\n', stderr: '' };
      if (cmd === WINGET_NODE) return { code: 0, stdout: '', stderr: '' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("PATH", "Machine")')) {
        return { code: 0, stdout: 'C:\\Program Files\\nodejs', stderr: '' };
      }
      if (cmd.includes('GetEnvironmentVariable("PATH", "User")')) {
        return { code: 0, stdout: 'C:\\Users\\tester\\AppData\\Roaming\\npm', stderr: '' };
      }
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.failed).toEqual([]);
    expect(calls).toContain(WINGET_NODE);
    // 重读 Machine+User PATH 并合并进当前会话
    expect(process.env.PATH).toContain('C:\\Program Files\\nodejs');
    expect(process.env.PATH).toContain('C:\\Users\\tester\\AppData\\Roaming\\npm');
  });

  it('winget 失败：node 记入 failed，不中断后续 prereq', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v18.20.1\n', stderr: '' };
      if (cmd === WINGET_NODE) return { code: 1, stdout: '', stderr: '0x8A150019' };
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'windows', home });
    expect(r.failed).toEqual(['node']);
  });

  it('git 不满足：按 manifest 平台命令安装；已装工具不会重复安装', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'git --version') return { code: 127, stdout: '', stderr: 'not found' };
      if (cmd === 'apt install -y git') return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.failed).toEqual([]);
    expect(calls).toContain('apt install -y git');
  });

  it('异常抛出不中断：exec 抛错的工具记入 failed，继续处理下一个', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'node -v') throw new Error('spawn node ENOENT');
      if (cmd === 'git --version') return { code: 0, stdout: 'git version 2.43.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePrereqs({ manifest: makeManifest(), platform: 'linux', home });
    expect(r.failed).toEqual(['node']);
    expect(calls).toContain('git --version');
  });
});
