import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCnMode,
  defaultCnMode,
  detectLocalProxy,
  detectProxy,
  npmRegistryFor,
  setConnectForTest,
} from './proxy.js';
import type { CnMode } from './proxy.js';
import { setExecForTest } from './utils.js';

const cnMode: CnMode = {
  enabled: true,
  mirror: true,
  proxy: { host: '127.0.0.1', port: 7890 },
  registry: 'https://registry.npmmirror.com',
};

describe('detectLocalProxy（注入连接探测，mock net.connect 行为）', () => {
  afterEach(() => setConnectForTest(undefined));

  it('7890 可连接时返回 {host, port: 7890}，不探测后续端口', async () => {
    const calls: Array<[string, number]> = [];
    setConnectForTest(async (host, port) => {
      calls.push([host, port]);
      return true;
    });
    await expect(detectLocalProxy()).resolves.toEqual({ host: '127.0.0.1', port: 7890 });
    expect(calls).toEqual([['127.0.0.1', 7890]]);
  });

  it('前两个失败第三个成功 → 返回 10809，按 7890/7897/10809 顺序探测', async () => {
    const calls: Array<[string, number]> = [];
    setConnectForTest(async (host, port) => {
      calls.push([host, port]);
      return port === 10809;
    });
    await expect(detectLocalProxy()).resolves.toEqual({ host: '127.0.0.1', port: 10809 });
    expect(calls).toEqual([
      ['127.0.0.1', 7890],
      ['127.0.0.1', 7897],
      ['127.0.0.1', 10809],
    ]);
  });

  it('全部失败返回 null，每次探测超时 500ms', async () => {
    const timeouts = new Set<number>();
    setConnectForTest(async (_host, _port, timeoutMs) => {
      timeouts.add(timeoutMs);
      return false;
    });
    await expect(detectLocalProxy()).resolves.toBeNull();
    expect(timeouts).toEqual(new Set([500]));
  });
});

describe('detectProxy（环境变量 → 系统代理 → 本地端口）', () => {
  let originalEnv: string | undefined;
  let originalPlatform: string;

  beforeEach(() => {
    originalEnv = process.env.http_proxy;
    originalPlatform = process.platform;
    // 清理测试进程环境中的代理变量残留（detectProxy 先查环境变量）
    delete process.env.http_proxy;
    delete process.env.HTTPS_PROXY;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    setConnectForTest(undefined);
    setExecForTest(undefined);
    vi.restoreAllMocks();
    if (originalEnv === undefined) delete process.env.http_proxy;
    else process.env.http_proxy = originalEnv;
    Object.defineProperty(process, 'platform', { value: originalPlatform });
  });

  it('环境变量已有代理：直接返回，不再探测端口', async () => {
    process.env.http_proxy = 'http://127.0.0.1:8888';
    let portProbed = false;
    setConnectForTest(async () => {
      portProbed = true;
      return true;
    });
    await expect(detectProxy()).resolves.toEqual({ host: '127.0.0.1', port: 8888 });
    expect(portProbed).toBe(false);
  });

  it('无环境变量：Windows 读系统代理注册表', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    setExecForTest(async (cmd) => {
      if (cmd.includes('Internet Settings'))
        return { code: 0, stdout: '127.0.0.1:7897\n', stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    await expect(detectProxy()).resolves.toEqual({ host: '127.0.0.1', port: 7897 });
  });

  it('环境变量与系统代理都没有：回退本地端口探测', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    setExecForTest(async () => ({ code: 0, stdout: '', stderr: '' })); // 系统代理为空
    setConnectForTest(async (_h, port) => port === 7890);
    await expect(detectProxy()).resolves.toEqual({ host: '127.0.0.1', port: 7890 });
  });

  it('全部不可用：返回 null', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' }); // linux 不查注册表
    setConnectForTest(async () => false);
    await expect(detectProxy()).resolves.toBeNull();
  });
});

describe('applyCnMode', () => {
  it('代理 + 镜像启用时注入 HTTP_PROXY/HTTPS_PROXY/npm_config_registry，保留原 env', () => {
    const out = applyCnMode(cnMode, { PATH: '/usr/bin', HOME: '/home/x' });
    expect(out).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/x',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      npm_config_registry: 'https://registry.npmmirror.com',
    });
  });

  it('仅镜像无代理：只注入 registry 不注入代理变量', () => {
    const out = applyCnMode({ ...cnMode, proxy: null }, { PATH: '/x' });
    expect(out.HTTP_PROXY).toBeUndefined();
    expect(out.HTTPS_PROXY).toBeUndefined();
    expect(out.npm_config_registry).toBe('https://registry.npmmirror.com');
  });

  it('返回新对象，不修改原 env', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/x' };
    const out = applyCnMode(cnMode, env);
    expect(out).not.toBe(env);
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
  });

  it('全关（无代理无镜像）：仅 registry 用官方源', () => {
    const out = applyCnMode({ ...cnMode, proxy: null, mirror: false, registry: 'https://registry.npmjs.org' }, { PATH: '/x' });
    expect(out.HTTP_PROXY).toBeUndefined();
    expect(out.npm_config_registry).toBe('https://registry.npmjs.org');
  });
});

describe('npmRegistryFor', () => {
  it('cn 模式 → npmmirror，直连 → npmjs.org', () => {
    expect(npmRegistryFor(true)).toBe('https://registry.npmmirror.com');
    expect(npmRegistryFor(false)).toBe('https://registry.npmjs.org');
  });
});

describe('defaultCnMode', () => {
  it('启用：registry 为 npmmirror，代理默认 127.0.0.1:7890', () => {
    expect(defaultCnMode(true)).toEqual({
      enabled: true,
      mirror: true,
      proxy: { host: '127.0.0.1', port: 7890 },
      registry: 'https://registry.npmmirror.com',
    });
  });

  it('禁用：registry 为 npmjs.org 且 enabled=false，无代理', () => {
    expect(defaultCnMode(false)).toEqual({
      enabled: false,
      mirror: false,
      proxy: null,
      registry: 'https://registry.npmjs.org',
    });
  });
});
