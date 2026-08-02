// cn 模式：本地代理探测、环境变量注入、npm registry 选择（依赖：types, utils）
import net from 'node:net';
import { CN_NPM_REGISTRY, DEFAULT_NPM_REGISTRY } from './utils.js';

export interface ProxyInfo {
  host: string;
  port: number;
}

export interface CnMode {
  enabled: boolean;
  registry: string;
  proxyHost: string;
  proxyPort: number;
}

const PROXY_HOST = '127.0.0.1';
const PROXY_PORTS = [7890, 7897, 10809];
const CONNECT_TIMEOUT_MS = 500;

export type ConnectFn = (host: string, port: number, timeoutMs: number) => Promise<boolean>;

/** TCP connect 探测：连接成功返回 true；超时/错误返回 false */
function realConnect(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean): void => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

let connectImpl: ConnectFn = realConnect;

/** 测试注入点：替换连接探测实现（传 undefined 恢复真实实现） */
export function setConnectForTest(fn: ConnectFn | undefined): void {
  connectImpl = fn ?? realConnect;
}

/** 依次探测 127.0.0.1:7890/7897/10809，返回第一个可连接的代理；全部失败返回 null */
export async function detectLocalProxy(): Promise<ProxyInfo | null> {
  for (const port of PROXY_PORTS) {
    if (await connectImpl(PROXY_HOST, port, CONNECT_TIMEOUT_MS)) {
      return { host: PROXY_HOST, port };
    }
  }
  return null;
}

/** 返回注入 HTTP_PROXY/HTTPS_PROXY/npm_config_registry 的新 env（不修改原对象） */
export function applyCnMode(mode: CnMode, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  if (!mode.enabled) return { ...env };
  const proxy = `http://${mode.proxyHost}:${mode.proxyPort}`;
  return {
    ...env,
    HTTP_PROXY: proxy,
    HTTPS_PROXY: proxy,
    npm_config_registry: mode.registry,
  };
}

export function npmRegistryFor(useCn: boolean): string {
  return useCn ? CN_NPM_REGISTRY : DEFAULT_NPM_REGISTRY;
}
