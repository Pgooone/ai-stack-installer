import { afterEach, describe, expect, it, vi } from 'vitest';
import { detectTty, exec, has, retry, setExecForTest, versionGte } from './utils.js';

describe('versionGte', () => {
  it('忽略 v 前缀（大小写均可）', () => {
    expect(versionGte('v2.3.1', '2.3.0')).toBe(true);
    expect(versionGte('V1.0.0', '1.0.0')).toBe(true);
    expect(versionGte('v2.3.0', '2.3.1')).toBe(false);
  });

  it('主版本主导比较', () => {
    expect(versionGte('2.9.9', '10.0.0')).toBe(false);
    expect(versionGte('11.0.0', '10.9.9')).toBe(true);
  });

  it('缺省段按 0 补齐（主次补丁边界）', () => {
    expect(versionGte('20', '19.9.9')).toBe(true);
    expect(versionGte('1.2', '1.2.0')).toBe(true);
    expect(versionGte('1.2', '1.2.1')).toBe(false);
    expect(versionGte('2', '2.0.0')).toBe(true);
  });

  it('相等版本返回 true', () => {
    expect(versionGte('2.3.1', '2.3.1')).toBe(true);
    expect(versionGte('v20.0.0', '20.0.0')).toBe(true);
  });
});

describe('exec（真实子进程冒烟：验证 powershell/bash 包装）', () => {
  it('执行 node -v 返回 code 0 与版本输出', async () => {
    const r = await exec('node -v');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^v\d+/);
  }, 20_000);

  it('命令退出码透传', async () => {
    const r = await exec('node -e "process.exit(3)"');
    expect(r.code).toBe(3);
  }, 20_000);

  it('注入 AI_STACK_INTERACTIVE（非 TTY 测试环境为 0），manifest 命令可据此切换静默/交互', async () => {
    const r = await exec('node -e "console.log(process.env.AI_STACK_INTERACTIVE)"');
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toBe('0'); // 测试环境非 TTY
  }, 20_000);

  it('超时返回 code -1', async () => {
    const r = await exec('node -e "setTimeout(() => {}, 60_000)"', { timeout: 300 });
    expect(r.code).toBe(-1);
  }, 20_000);
});

describe('has', () => {
  afterEach(() => setExecForTest(undefined));

  it('命令存在（code 0 + 非空输出）返回 true', async () => {
    setExecForTest(async () => ({ code: 0, stdout: '/usr/bin/git\n', stderr: '' }));
    await expect(has('git')).resolves.toBe(true);
  });

  it('命令不存在（非零 code）返回 false', async () => {
    setExecForTest(async () => ({ code: 127, stdout: '', stderr: 'not found' }));
    await expect(has('definitely-not-a-cmd')).resolves.toBe(false);
  });

  it('code 0 但无输出视为不存在', async () => {
    setExecForTest(async () => ({ code: 0, stdout: '', stderr: '' }));
    await expect(has('ghost-bin')).resolves.toBe(false);
  });

  it('非法 bin 名直接返回 false，不执行命令（防注入）', async () => {
    const spy = vi.fn(async () => ({ code: 0, stdout: 'x\n', stderr: '' }));
    setExecForTest(spy);
    await expect(has('rm -rf /')).resolves.toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('retry', () => {
  it('首次成功只调用一次', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(retry(fn, 3, 1)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('第 2 次尝试成功后返回结果', async () => {
    let calls = 0;
    const result = await retry(
      async () => {
        calls++;
        if (calls < 2) throw new Error('临时失败');
        return 'done';
      },
      3,
      1,
    );
    expect(result).toBe('done');
    expect(calls).toBe(2);
  });

  it('达到次数上限后抛出最后一次错误', async () => {
    const fn = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(retry(fn, 3, 1)).rejects.toThrow('boom');
    expect(fn).toHaveBeenCalledTimes(3);
  });
});

describe('detectTty', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('isTTY 且无 CI 时返回 true', () => {
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectTty()).toBe(true);
  });

  it('CI 环境下返回 false（即使 isTTY）', () => {
    vi.stubEnv('CI', '1');
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    expect(detectTty()).toBe(false);
  });

  it('非 TTY 返回 false', () => {
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdout, 'isTTY', { value: false, configurable: true });
    expect(detectTty()).toBe(false);
  });
});
