// 通用工具：命令探测/执行、指数退避重试、语义化版本比较、TTY 检测（依赖：types）
import { spawn, type ChildProcess } from 'node:child_process';

// npm registry 常量（cn 模式与 manifest/proxy 共用）
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';
export const CN_NPM_REGISTRY = 'https://registry.npmmirror.com';

export interface ExecOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** 超时毫秒；超时返回 code=-1 */
  timeout?: number;
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type ExecFn = (cmd: string, opts?: ExecOptions) => Promise<ExecResult>;

// ---- exec：跨平台执行命令 ----

function runExec(cmd: string, opts: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout, stderr });
    };

    // 注入交互上下文：manifest 命令可按 AI_STACK_INTERACTIVE 决定行为
    // （如 pwsh 的 MSI 安装：交互模式呼出安装向导，非交互/CI 静默安装）
    const interactiveEnv: NodeJS.ProcessEnv = {
      ...process.env,
      ...(opts.env ?? {}),
      AI_STACK_INTERACTIVE: detectTty() ? '1' : '0',
    };
    const spawnOpts = {
      cwd: opts.cwd,
      env: interactiveEnv,
      windowsHide: true,
    };
    // Windows 用 powershell 包一层，POSIX 用 bash -c；spawn 数组传参避免自行拼接转义
    const isWin = process.platform === 'win32';
    let child: ChildProcess;
    if (isWin) {
      // EncodedCommand（UTF-16LE base64）原样传递，规避引号/解析问题；
      // 显式 exit $LASTEXITCODE 透传原生程序退出码（PowerShell 默认不传递）
      const wrapped = `$LASTEXITCODE = 0; ${cmd}; exit $LASTEXITCODE`;
      const encoded = Buffer.from(wrapped, 'utf16le').toString('base64');
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], spawnOpts);
    } else {
      child = spawn('bash', ['-c', cmd], spawnOpts);
    }
    // 注意：不能 unref()——unref 会连带 unref stdio handles，stdout 数据不再保持事件循环存活，
    // 子进程输出到达前的空窗期宿主进程会退出，await 的 promise 永不 settle（Node 报 unsettled top-level await）

    if (opts.timeout && opts.timeout > 0) {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(-1);
      }, opts.timeout);
      timer.unref();
      child.once('close', () => clearTimeout(timer));
    }

    child.stdout?.on('data', (d: Buffer) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderr += String(d);
    });
    child.once('error', () => finish(127)); // spawn 失败（bash/powershell 不存在等）
    child.once('close', (code) => finish(code ?? 1));
  });
}

let execImpl: ExecFn = runExec;

/** 测试注入点：替换 exec 实现（传 undefined 恢复真实实现） */
export function setExecForTest(fn: ExecFn | undefined): void {
  execImpl = fn ?? runExec;
}

export function exec(cmd: string, opts?: ExecOptions): Promise<ExecResult> {
  return execImpl(cmd, opts);
}

// ---- has：command -v / Get-Command 探测 ----

const SAFE_BIN_RE = /^[a-z0-9._-]+$/i;

export async function has(bin: string): Promise<boolean> {
  if (!SAFE_BIN_RE.test(bin)) return false; // bin 会进入 shell 命令，防注入
  if (process.platform === 'win32') {
    const r = await exec(`Get-Command ${bin} -ErrorAction SilentlyContinue`);
    return r.code === 0 && r.stdout.trim().length > 0;
  }
  const r = await exec(`command -v ${bin}`);
  return r.code === 0 && r.stdout.trim().length > 0;
}

// ---- retry：指数退避重试（1x, 2x, 4x…） ----

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref();
  });
}

export async function retry<T>(fn: () => Promise<T>, times = 3, delayMs = 1000): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < times; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < times - 1) {
        await sleep(delayMs * 2 ** attempt);
      }
    }
  }
  throw lastError;
}

// ---- versionGte：语义化版本比较（纯数字，忽略 v 前缀，缺省段按 0） ----

function parseVersion(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((s) => parseInt(s, 10) || 0);
}

export function versionGte(actual: string, min: string): boolean {
  const a = parseVersion(actual);
  const b = parseVersion(min);
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ---- detectTty ----

export function detectTty(): boolean {
  return !!process.stdout.isTTY && !process.env.CI;
}
