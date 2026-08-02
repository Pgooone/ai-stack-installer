// 日志：彩色输出 + ~/.ai-stack/install.log 追加（依赖：utils, fs-locations；home/TTY 可注入以便测试）
import { appendFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import { dirname } from 'node:path';
import { logFile } from './fs-locations.js';
import { detectTty } from './utils.js';

const ANSI = {
  cyan: '[36m',
  green: '[32m',
  red: '[31m',
  reset: '[0m',
} as const;

type Level = 'log' | 'ok' | 'fail';

const PREFIX: Record<Level, string> = {
  log: '',
  ok: '✓ ',
  fail: '✗ ',
};

const COLOR: Record<Level, keyof typeof ANSI> = {
  log: 'cyan',
  ok: 'green',
  fail: 'red',
};

let homeDir: string = os.homedir();
let colorEnabled: boolean = detectTty();

export function setLoggerHome(home: string): void {
  homeDir = home;
}

export function setLoggerColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

/** 追加到 ~/.ai-stack/install.log（UTF-8）；写入失败不阻塞主流程 */
async function appendToLog(line: string): Promise<void> {
  try {
    const file = logFile(homeDir);
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${line}\n`, 'utf8');
  } catch {
    // 日志失败静默：不因日志问题中断安装
  }
}

async function write(level: Level, msg: string): Promise<void> {
  const text = `${PREFIX[level]}${msg}`;
  const painted = colorEnabled ? `${ANSI[COLOR[level]]}${text}${ANSI.reset}` : text;
  console.log(painted);
  await appendToLog(text); // 日志文件只留纯文本，无 ANSI
}

export function log(msg: string): Promise<void> {
  return write('log', msg);
}

export function ok(msg: string): Promise<void> {
  return write('ok', msg);
}

export function fail(msg: string): Promise<void> {
  return write('fail', msg);
}
