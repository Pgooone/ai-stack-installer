import os from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { detect, detectNode, detectTools } from './detect.js';
import type { Manifest } from './types.js';
import { setExecForTest } from './utils.js';

// WSL 检测依赖 /proc/version 读取：mock fs/promises.readFile
vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

import { readFile } from 'node:fs/promises';
const mockReadFile = vi.mocked(readFile);

describe('detect', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockReadFile.mockReset();
    setExecForTest(undefined);
  });

  it('win32 → windows，isWsl 恒为 false', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const info = await detect();
    expect(info.platform).toBe('windows');
    expect(info.isWsl).toBe(false);
    expect(info.arch).toBe(process.arch);
    expect(info.home).toBe(os.homedir());
  });

  it('darwin → macos', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const info = await detect();
    expect(info.platform).toBe('macos');
    expect(info.isWsl).toBe(false);
  });

  it('linux 且 /proc/version 含 microsoft → isWsl=true', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockReadFile.mockResolvedValue('Linux version 5.15.90.1-microsoft-standard-WSL2 (WSL)');
    const info = await detect();
    expect(info.platform).toBe('linux');
    expect(info.isWsl).toBe(true);
    expect(mockReadFile).toHaveBeenCalledWith('/proc/version', 'utf8');
  });

  it('linux 且 /proc/version 不含 microsoft → isWsl=false', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockReadFile.mockResolvedValue('Linux version 6.8.0-45-generic (Ubuntu 24.04)');
    const info = await detect();
    expect(info.isWsl).toBe(false);
  });

  it('linux 读 /proc/version 失败 → isWsl=false（不抛错）', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    mockReadFile.mockRejectedValue(new Error('ENOENT'));
    const info = await detect();
    expect(info.isWsl).toBe(false);
  });

  it('不支持的平台抛错', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('freebsd' as NodeJS.Platform);
    await expect(detect()).rejects.toThrow(/不支持的平台：freebsd/);
  });
});

describe('detectNode', () => {
  afterEach(() => setExecForTest(undefined));

  it('node ≥20 视为可用并带版本', async () => {
    setExecForTest(async () => ({ code: 0, stdout: 'v22.5.0\n', stderr: '' }));
    const s = await detectNode();
    expect(s).toEqual({ id: 'node', bin: 'node', installed: true, version: '22.5.0' });
  });

  it('node 主版本 <20 视为不可用', async () => {
    setExecForTest(async () => ({ code: 0, stdout: 'v18.20.1\n', stderr: '' }));
    const s = await detectNode();
    expect(s.installed).toBe(false);
  });

  it('node 未安装视为不可用', async () => {
    setExecForTest(async () => ({ code: 127, stdout: '', stderr: 'command not found' }));
    const s = await detectNode();
    expect(s.installed).toBe(false);
  });
});

describe('detectTools', () => {
  afterEach(() => setExecForTest(undefined));

  const manifest: Manifest = {
    prereq: [{ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' }],
    agents: [
      { id: 'claude-code', bin: 'claude', check: 'claude --version' },
      { id: 'cc-switch', bin: 'cc-switch', check: 'cc-switch --version', optIn: true },
    ],
  };

  it('批量探测 prereq + agents（含 optIn），失败/版本不足视为未装', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.0.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v1.2.3\n', stderr: '' };
      return { code: 127, stdout: '', stderr: 'not found' }; // cc-switch 未装
    });
    const states = await detectTools(manifest);
    expect(states.map((s) => [s.id, s.installed])).toEqual([
      ['node', true],
      ['claude-code', true],
      ['cc-switch', false],
    ]);
  });

  it('空 manifest 返回空数组', async () => {
    await expect(detectTools({ prereq: [], agents: [] })).resolves.toEqual([]);
  });
});
