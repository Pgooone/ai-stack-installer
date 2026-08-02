import { afterEach, describe, expect, it } from 'vitest';
import { applyCnMode, detectLocalProxy, npmRegistryFor, setConnectForTest } from './proxy.js';
import type { CnMode } from './proxy.js';

const cnMode: CnMode = {
  enabled: true,
  registry: 'https://registry.npmmirror.com',
  proxyHost: '127.0.0.1',
  proxyPort: 7890,
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

  it('连接超时视为失败并继续探测（7890 超时，7897 命中）', async () => {
    setConnectForTest(async (_host, port) => port === 7897);
    await expect(detectLocalProxy()).resolves.toEqual({ host: '127.0.0.1', port: 7897 });
  });
});

describe('applyCnMode', () => {
  it('启用时注入 HTTP_PROXY/HTTPS_PROXY/npm_config_registry，保留原 env', () => {
    const out = applyCnMode(cnMode, { PATH: '/usr/bin', HOME: '/home/x' });
    expect(out).toMatchObject({
      PATH: '/usr/bin',
      HOME: '/home/x',
      HTTP_PROXY: 'http://127.0.0.1:7890',
      HTTPS_PROXY: 'http://127.0.0.1:7890',
      npm_config_registry: 'https://registry.npmmirror.com',
    });
  });

  it('返回新对象，不修改原 env', () => {
    const env: NodeJS.ProcessEnv = { PATH: '/x' };
    const out = applyCnMode(cnMode, env);
    expect(out).not.toBe(env);
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.npm_config_registry).toBeUndefined();
  });

  it('禁用时不注入任何变量', () => {
    const out = applyCnMode({ ...cnMode, enabled: false }, { PATH: '/x' });
    expect(out).toEqual({ PATH: '/x' });
    expect(out.HTTP_PROXY).toBeUndefined();
    expect(out.HTTPS_PROXY).toBeUndefined();
    expect(out.npm_config_registry).toBeUndefined();
  });
});

describe('npmRegistryFor', () => {
  it('cn 模式 → npmmirror，直连 → npmjs.org', () => {
    expect(npmRegistryFor(true)).toBe('https://registry.npmmirror.com');
    expect(npmRegistryFor(false)).toBe('https://registry.npmjs.org');
  });
});
