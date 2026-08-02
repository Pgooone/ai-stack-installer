import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installAgent, uninstallAgent } from './agents.js';
import { setLoggerHome } from './logger.js';
import type { ToolSpec } from './types.js';
import { setExecForTest } from './utils.js';

const tool: ToolSpec = {
  id: 'claude-code',
  bin: 'claude',
  check: 'claude --version',
  linux: 'npm i -g @anthropic-ai/claude-code',
  macos: 'npm i -g @anthropic-ai/claude-code',
  windows: 'npm i -g @anthropic-ai/claude-code',
  fallback: 'npm i -g @anthropic-ai/claude-code --force',
  uninstall: 'npm rm -g @anthropic-ai/claude-code',
  uninstallWindows: 'npm rm -g @anthropic-ai/claude-code --windows',
};

const PRIMARY = 'npm i -g @anthropic-ai/claude-code';
const FALLBACK = 'npm i -g @anthropic-ai/claude-code --force';
const FALLBACK_CN = 'npm i -g @anthropic-ai/claude-code --force --registry=https://registry.npmmirror.com';

describe('installAgent（注入 exec mock，不真跑 npm）', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-agents-'));
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  /** check 首次失败（视为未装）、之后成功（视为装好）；安装命令按主通道/降级是否成功分支 */
  function mockInstall(primaryOk: boolean, fallbackOk = false): { calls: string[] } {
    const calls: string[] = [];
    let checkCalls = 0;
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'claude --version') {
        checkCalls++;
        if (checkCalls === 1) return { code: 127, stdout: '', stderr: 'command not found' };
        return { code: 0, stdout: 'v2.0.0\n', stderr: '' };
      }
      if (cmd === PRIMARY || cmd === FALLBACK || cmd === FALLBACK_CN) {
        const isPrimary = cmd === PRIMARY;
        if (primaryOk && isPrimary) return { code: 0, stdout: '', stderr: '' };
        if (!isPrimary && fallbackOk) return { code: 0, stdout: '', stderr: '' };
        return { code: 1, stdout: '', stderr: 'ENOTFOUND registry.npmjs.org' };
      }
      throw new Error(`不应执行：${cmd}`);
    });
    return { calls };
  }

  it('已装 → skipped：只做 check，不执行任何安装命令', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.0.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(installAgent(tool, { platform: 'linux' })).resolves.toBe('skipped');
    expect(calls).toEqual(['claude --version']);
  });

  it('主通道成功 → ok：安装后 check 通过，不执行 fallback', async () => {
    const { calls } = mockInstall(true);
    await expect(installAgent(tool, { platform: 'linux' })).resolves.toBe('ok');
    expect(calls).toEqual(['claude --version', PRIMARY, 'claude --version']);
  });

  it('主通道失败 → fallback 降级成功 → ok', async () => {
    const { calls } = mockInstall(false, true);
    await expect(installAgent(tool, { platform: 'linux' })).resolves.toBe('ok');
    expect(calls).toEqual(['claude --version', PRIMARY, FALLBACK, 'claude --version']);
  });

  it('主通道与 fallback 都失败 → failed，日志记录 stderr 尾部', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { calls } = mockInstall(false, false);
    await expect(installAgent(tool, { platform: 'linux' })).resolves.toBe('failed');
    expect(calls).toEqual(['claude --version', PRIMARY, FALLBACK]);
    const logs = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logs).toContain('安装失败');
    expect(logs).toContain('ENOTFOUND registry.npmjs.org'); // stderr 尾部被记录
  });

  it('cn 模式：主通道与 fallback 的 npm 命令自动加 npmmirror registry', async () => {
    const PRIMARY_CN = `${PRIMARY} --registry=https://registry.npmmirror.com`;
    const calls: string[] = [];
    let checkCalls = 0;
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'claude --version') {
        checkCalls++;
        if (checkCalls === 1) return { code: 127, stdout: '', stderr: 'not found' };
        return { code: 0, stdout: 'v2.0.0\n', stderr: '' };
      }
      if (cmd === PRIMARY_CN) return { code: 1, stdout: '', stderr: 'EAI_AGAIN' };
      if (cmd === FALLBACK_CN) return { code: 0, stdout: '', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(installAgent(tool, { platform: 'linux', cnMode: true })).resolves.toBe('ok');
    expect(calls).toEqual(['claude --version', PRIMARY_CN, FALLBACK_CN, 'claude --version']);
  });

  it('无主通道命令且无 fallback → failed，不执行任何命令', async () => {
    const bare: ToolSpec = { ...tool, linux: undefined, windows: undefined, fallback: undefined };
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      if (cmd === 'claude --version') return { code: 127, stdout: '', stderr: 'not found' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(installAgent(bare, { platform: 'linux' })).resolves.toBe('failed');
    expect(calls).toEqual(['claude --version']);
  });
});

describe('uninstallAgent', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-agents-'));
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('linux/macos 用 uninstall 命令', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    await uninstallAgent(tool, 'linux');
    expect(calls).toEqual(['npm rm -g @anthropic-ai/claude-code']);
  });

  it('windows 优先用 uninstallWindows', async () => {
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    await uninstallAgent(tool, 'windows');
    expect(calls).toEqual(['npm rm -g @anthropic-ai/claude-code --windows']);
  });

  it('无卸载命令 → 跳过，不执行 exec', async () => {
    const bare: ToolSpec = { ...tool, uninstall: undefined, uninstallWindows: undefined };
    const calls: string[] = [];
    setExecForTest(async (cmd) => {
      calls.push(cmd);
      return { code: 0, stdout: '', stderr: '' };
    });
    await uninstallAgent(bare, 'linux');
    expect(calls).toEqual([]);
  });

  it('卸载命令失败不抛错', async () => {
    setExecForTest(async () => ({ code: 1, stdout: '', stderr: 'npm error' }));
    await expect(uninstallAgent(tool, 'linux')).resolves.toBeUndefined();
  });
});
