import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './doctor.js';
import { setLoggerHome } from './logger.js';
import type { Manifest } from './types.js';
import { setExecForTest } from './utils.js';

function makeManifest(): Manifest {
  return {
    prereq: [
      { id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0', linux: 'x', windows: 'x' },
    ],
    agents: [
      { id: 'claude-code', bin: 'claude', check: 'claude --version', linux: 'x', windows: 'x' },
      {
        id: 'codex',
        bin: 'codex',
        check: 'codex --version',
        needsProxy: true,
        linux: 'npm i -g @openai/codex',
        windows: 'npm i -g @openai/codex',
      },
    ],
  };
}

describe('runDoctor（注入 exec mock，不探测真实环境）', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-doctor-'));
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('全部就绪：每行输出 工具|版本|✓，返回退出码 0', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 0, stdout: '0.8.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runDoctor(makeManifest(), false, 'linux')).resolves.toBe(0);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('node');
    expect(output).toContain('v22.5.0');
    expect(output).toContain('claude-code');
    expect(output).toContain('✓');
    expect(output).not.toContain('✗');
  });

  it('有失败：返回退出码 1，失败行附 ✗', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 127, stdout: '', stderr: 'not found' };
      if (cmd === 'codex --version') return { code: 127, stdout: '', stderr: 'not found' };
      throw new Error(`不应执行：${cmd}`);
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runDoctor(makeManifest(), false, 'linux')).resolves.toBe(1);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('✗');
    expect(output).toContain('-'); // 无版本时占位
  });

  it('needsProxy 且未开 cn：失败行附「建议启用 cn 模式/代理后重试」', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 127, stdout: '', stderr: 'not found' };
      throw new Error(`不应执行：${cmd}`);
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runDoctor(makeManifest(), false, 'linux')).resolves.toBe(1);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).toContain('codex');
    expect(output).toContain('建议启用 cn 模式/代理后重试');
  });

  it('needsProxy 但已开 cn：不附建议文案', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 127, stdout: '', stderr: 'not found' };
      throw new Error(`不应执行：${cmd}`);
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runDoctor(makeManifest(), true, 'linux')).resolves.toBe(1);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('建议启用 cn 模式/代理后重试');
  });

  it('无 needsProxy 的工具失败不附建议', async () => {
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 127, stdout: '', stderr: 'not found' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 0, stdout: '0.8.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await expect(runDoctor(makeManifest(), false, 'linux')).resolves.toBe(1);
    const output = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(output).not.toContain('建议启用 cn 模式/代理后重试');
  });

  it('平台不适用项（onlyOnWindows）在 linux 下不检查，与 prereq 同规则', async () => {
    const withPwsh: Manifest = {
      ...makeManifest(),
      prereq: [
        ...makeManifest().prereq,
        { id: 'pwsh', bin: 'pwsh', check: 'pwsh -v', onlyOnWindows: true, windows: 'x' },
      ],
    };
    // linux：pwsh 的 check 不应被执行（mock 遇未预期命令会抛错）
    setExecForTest(async (cmd) => {
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 0, stdout: '0.8.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(runDoctor(withPwsh, false, 'linux')).resolves.toBe(0);
    // windows：pwsh 的 check 应被执行
    setExecForTest(async (cmd) => {
      if (cmd === 'pwsh -v') return { code: 0, stdout: '7.6.4\n', stderr: '' };
      if (cmd === 'node -v') return { code: 0, stdout: 'v22.5.0\n', stderr: '' };
      if (cmd === 'claude --version') return { code: 0, stdout: 'v2.1.0\n', stderr: '' };
      if (cmd === 'codex --version') return { code: 0, stdout: '0.8.0\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(runDoctor(withPwsh, false, 'windows')).resolves.toBe(0);
  });
});
