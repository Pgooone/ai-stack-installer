import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fail, log, ok, setLoggerColorEnabled, setLoggerHome } from './logger.js';

describe('logger', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-logger-'));
    setLoggerHome(dir);
    setLoggerColorEnabled(true);
  });

  afterEach(async () => {
    setLoggerColorEnabled(false);
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('log/ok/fail 彩色输出（青/绿/红）', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await log('信息');
    await ok('成功');
    await fail('失败');
    const outputs = spy.mock.calls.map((c) => String(c[0]));
    expect(outputs[0]).toContain('[36m');
    expect(outputs[1]).toContain('[32m');
    expect(outputs[2]).toContain('[31m');
  });

  it('无 TTY 时输出去色', async () => {
    setLoggerColorEnabled(false);
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await log('plain');
    await fail('red-plain');
    const outputs = spy.mock.calls.map((c) => String(c[0]));
    expect(outputs[0]).not.toContain('[');
    expect(outputs[1]).not.toContain('[');
  });

  it('ok/fail 带状态前缀', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await ok('完成');
    await fail('出错');
    const outputs = spy.mock.calls.map((c) => String(c[0]));
    expect(outputs[0]).toContain('✓ 完成');
    expect(outputs[1]).toContain('✗ 出错');
  });

  it('追加写入 home/.ai-stack/install.log（UTF-8 纯文本，无 ANSI）', async () => {
    await log('第一行');
    await ok('第二行');
    await fail('第三行');
    const content = await readFile(join(dir, '.ai-stack', 'install.log'), 'utf8');
    const lines = content.trim().split(/\r?\n/);
    expect(lines).toEqual(['第一行', '✓ 第二行', '✗ 第三行']);
    expect(content).not.toContain('[');
  });

  it('多次调用为追加而非覆盖', async () => {
    await log('甲');
    await log('乙');
    const content = await readFile(join(dir, '.ai-stack', 'install.log'), 'utf8');
    expect(content.trim().split(/\r?\n/)).toEqual(['甲', '乙']);
  });
});
