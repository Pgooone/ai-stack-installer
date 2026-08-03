// 代理与镜像：系统代理/环境变量/本地端口探测、窗口内（env 注入）生效、npm registry 选择
// 依赖：types, utils, logger
import net from 'node:net';
import { CN_NPM_REGISTRY, DEFAULT_NPM_REGISTRY } from './utils.js';
import { log } from './logger.js';
import { exec } from './utils.js';

export interface ProxyInfo {
  host: string;
  port: number;
}

export interface CnMode {
  /** 是否启用任何网络优化（mirror 或 proxy 任一）；doctor 的 needsProxy 提示据此 */
  enabled: boolean;
  /** npmmirror 镜像（npm 安装命令加 --registry） */
  mirror: boolean;
  /** 代理（null = 不用代理）；来自系统设置/环境变量/本地端口探测 */
  proxy: ProxyInfo | null;
  /** 实际使用的 npm registry（mirror ? npmmirror : 官方） */
  registry: string;
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

/** 从环境变量解析已有代理（用户 shell 已设置 http_proxy 等） */
function parseEnvProxy(url: string | undefined): ProxyInfo | null {
  if (!url) return null;
  const m = /^https?:\/\/([^:/]+):(\d+)/.exec(url.trim());
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

/** Windows 系统代理（注册表 Internet Settings 的 ProxyEnable/ProxyServer） */
async function readSystemProxy(): Promise<ProxyInfo | null> {
  const r = await exec(
    "$s = Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'; " +
      "if ($s.ProxyEnable -eq 1) { $s.ProxyServer } else { '' }",
  );
  if (r.code !== 0) return null;
  const server = r.stdout.trim();
  if (!server) return null;
  const m = /([^:;]+):(\d+)/.exec(server);
  if (!m) return null;
  return { host: m[1], port: Number(m[2]) };
}

/**
 * 综合代理检测（按优先级）：
 * 1. 环境变量 http_proxy/HTTPS_PROXY（用户 shell 已配置）
 * 2. Windows 系统代理（注册表）
 * 3. 本地常见代理端口探测（7890/7897/10809）
 */
export async function detectProxy(): Promise<ProxyInfo | null> {
  const fromEnv = parseEnvProxy(process.env.http_proxy ?? process.env.HTTP_PROXY);
  if (fromEnv) {
    await log(`检测到环境变量代理 ${fromEnv.host}:${fromEnv.port}`);
    return fromEnv;
  }
  if (process.platform === 'win32') {
    const sys = await readSystemProxy();
    if (sys) {
      await log(`检测到系统代理 ${sys.host}:${sys.port}`);
      return sys;
    }
  }
  return detectLocalProxy();
}

/** 返回注入代理/镜像的新 env（窗口内生效：HTTP_PROXY/HTTPS_PROXY/npm_config_registry；不修改原对象） */
export function applyCnMode(mode: CnMode, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const next = { ...env };
  if (mode.proxy) {
    const proxy = `http://${mode.proxy.host}:${mode.proxy.port}`;
    next.HTTP_PROXY = proxy;
    next.HTTPS_PROXY = proxy;
  }
  next.npm_config_registry = mode.registry;
  return next;
}

export function npmRegistryFor(useCn: boolean): string {
  return useCn ? CN_NPM_REGISTRY : DEFAULT_NPM_REGISTRY;
}

/** 构造标准 cn 模式：--cn 强制时镜像+默认代理 7890；未启用时全关 */
export function defaultCnMode(enabled: boolean, proxy: ProxyInfo | null = null): CnMode {
  return {
    enabled,
    mirror: enabled,
    proxy: proxy ?? (enabled ? { host: PROXY_HOST, port: PROXY_PORTS[0] } : null),
    registry: npmRegistryFor(enabled),
  };
}
