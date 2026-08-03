import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupNpxCache } from './cli.js';
import { setLoggerHome } from './logger.js';
import * as utils from './utils.js';

// mock 各流程模块：验证编排调用顺序与数据传递，不真跑安装
const mocks = vi.hoisted(() => ({
  detect: vi.fn(),
  detectTools: vi.fn(),
  ensurePrereqs: vi.fn(),
  updatePrereqs: vi.fn(),
  installAgent: vi.fn(),
  runDoctor: vi.fn(),
  writeConfigFiles: vi.fn(),
  writeAliasBlock: vi.fn(),
  printFileReport: vi.fn(),
  runWizard: vi.fn(),
  runUninstall: vi.fn(),
}));

vi.mock('./detect.js', () => ({ detect: mocks.detect, detectTools: mocks.detectTools }));
vi.mock('./prereq.js', () => ({ ensurePrereqs: mocks.ensurePrereqs }));
vi.mock('./update.js', () => ({ updatePrereqs: mocks.updatePrereqs }));
vi.mock('./agents.js', () => ({ installAgent: mocks.installAgent }));
vi.mock('./doctor.js', () => ({ runDoctor: mocks.runDoctor }));
vi.mock('./configure.js', () => ({
  writeConfigFiles: mocks.writeConfigFiles,
  writeAliasBlock: mocks.writeAliasBlock,
  printFileReport: mocks.printFileReport,
}));
vi.mock('./tui.js', () => ({ runWizard: mocks.runWizard }));
vi.mock('./uninstall.js', () => ({ runUninstall: mocks.runUninstall }));

import { decideInteractive, main, parseArgs } from './cli.js';

describe('parseArgs', () => {
  it('无参数：默认 install + full + 非 yes/交互/cn', () => {
    expect(parseArgs([])).toEqual({
      command: 'install',
      yes: false,
      interactive: false,
      cn: false,
      profile: 'full',
    });
  });

  it('第一个位置参数为子命令（install/doctor/uninstall/list）', () => {
    expect(parseArgs(['doctor']).command).toBe('doctor');
    expect(parseArgs(['uninstall']).command).toBe('uninstall');
    expect(parseArgs(['list']).command).toBe('list');
    expect(parseArgs(['install']).command).toBe('install');
  });

  it('位置参数与选项可混排', () => {
    expect(parseArgs(['-y', 'uninstall'])).toMatchObject({ command: 'uninstall', yes: true });
  });

  it('-y/--yes、-i/--interactive、--cn 开关解析', () => {
    expect(parseArgs(['-y', '-i', '--cn'])).toMatchObject({ yes: true, interactive: true, cn: true });
    expect(parseArgs(['--yes', '--interactive'])).toMatchObject({ yes: true, interactive: true });
  });

  it('-p/--profile/--profile= 解析 minimal|full', () => {
    expect(parseArgs(['-p', 'minimal']).profile).toBe('minimal');
    expect(parseArgs(['--profile', 'full']).profile).toBe('full');
    expect(parseArgs(['--profile=minimal']).profile).toBe('minimal');
  });

  it('非法值/缺值抛错并提示', () => {
    expect(() => parseArgs(['-p', 'huge'])).toThrow(/minimal 或 full/);
    expect(() => parseArgs(['-p'])).toThrow(/minimal 或 full/);
    expect(() => parseArgs(['-x'])).toThrow(/未知参数：-x/);
    expect(() => parseArgs(['unknown'])).toThrow(/未知子命令：unknown/);
  });
});

describe('decideInteractive（模式选择）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('-i 强制交互（即使 -y 也交互）', () => {
    vi.spyOn(utils, 'detectTty').mockReturnValue(false);
    expect(decideInteractive({ yes: true, interactive: true })).toBe(true);
  });

  it('-y 强制非交互（即使有 TTY）', () => {
    vi.spyOn(utils, 'detectTty').mockReturnValue(true);
    expect(decideInteractive({ yes: true, interactive: false })).toBe(false);
  });

  it('无 -y/-i 且有 TTY → 交互', () => {
    vi.spyOn(utils, 'detectTty').mockReturnValue(true);
    expect(decideInteractive({ yes: false, interactive: false })).toBe(true);
  });

  it('无 -y/-i 且无 TTY（管道/CI）→ 直装', () => {
    vi.spyOn(utils, 'detectTty').mockReturnValue(false);
    expect(decideInteractive({ yes: false, interactive: false })).toBe(false);
  });
});

describe('main（各子命令分派与 install 编排，mock 模块注入 + 临时 home）', () => {
  let tmpRoot: string;
  let home: string;
  const writtenFiles = [
    join('/tmp/home', '.claude', 'settings.json'),
    join('/tmp/home', '.codex', 'config.toml'),
  ];

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-cli-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    mocks.detect.mockReset();
    mocks.detectTools.mockReset();
    mocks.ensurePrereqs.mockReset();
    mocks.updatePrereqs.mockReset();
    mocks.installAgent.mockReset();
    mocks.runDoctor.mockReset();
    mocks.writeConfigFiles.mockReset();
    mocks.writeAliasBlock.mockReset();
    mocks.printFileReport.mockReset();
    mocks.runWizard.mockReset();
    mocks.runUninstall.mockReset();
    mocks.detect.mockResolvedValue({ platform: 'linux', isWsl: false, arch: 'x64', home });
    mocks.detectTools.mockResolvedValue([]);
    // 测试环境跳过运行时版本检查（避免真实 npm view 请求）
    process.env.AI_STACK_SKIP_UPDATE_CHECK = '1';
    mocks.ensurePrereqs.mockResolvedValue({ failed: [] });
    mocks.installAgent.mockResolvedValue('ok');
    mocks.runDoctor.mockResolvedValue(0);
    mocks.writeConfigFiles.mockResolvedValue({
      written: [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')],
    });
    mocks.writeAliasBlock.mockResolvedValue({ rcFile: join(home, '.bashrc'), action: 'written' });
    mocks.printFileReport.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('install -y（直装）：prereq → 4 个 agent（不含 optIn）→ 配置 → doctor → 文件清单，退出码 0', async () => {
    const code = await main(['install', '-y']);
    expect(code).toBe(0);
    expect(mocks.ensurePrereqs).toHaveBeenCalledTimes(1);
    // 全部非 optIn agent，顺序与 manifest 一致
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'opencode',
    ]);
    expect(mocks.writeConfigFiles).toHaveBeenCalledWith('linux', false, home);
    expect(mocks.writeAliasBlock).toHaveBeenCalledWith('linux', home);
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(mocks.printFileReport).toHaveBeenCalledTimes(1);
    // cn 默认关闭
    expect(mocks.ensurePrereqs.mock.calls[0][0].cnMode).toBe(false);
    expect(mocks.installAgent.mock.calls[0][1].cnMode.enabled).toBe(false);
  });

  it('install -y：installed.json 记录本脚本安装的工具与文件（v2）', async () => {
    await main(['install', '-y']);
    const record = JSON.parse(await readFile(join(home, '.ai-stack', 'installed.json'), 'utf8'));
    expect(record.version).toBe(2);
    // 本用例 mock 的 installAgent 全返回 ok → 4 个工具都记录
    expect(record.tools).toEqual(['claude-code', 'codex', 'pi', 'opencode']);
    // 文件带 hash（mock 文件不存在 → hash 为 null/undefined 序列化后消失——检查 path 结构）
    expect(record.files.map((f: { path: string }) => f.path)).toEqual([
      join(home, '.claude', 'settings.json'),
      join(home, '.codex', 'config.toml'),
    ]);
  });

  it('install -y：installAgent 返回 skipped 的工具（用户已有）不记录', async () => {
    mocks.installAgent.mockResolvedValue('skipped');
    await main(['install', '-y']);
    const record = JSON.parse(await readFile(join(home, '.ai-stack', 'installed.json'), 'utf8'));
    expect(record.tools).toEqual([]); // 全为已有 → 不记录任何工具
  });

  it('install -y -p minimal：只装 claude-code', async () => {
    await main(['install', '-y', '-p', 'minimal']);
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['claude-code']);
  });

  it('install -y --cn：prereq 与 agent 安装均启用 cn 模式', async () => {
    await main(['install', '-y', '--cn']);
    expect(mocks.ensurePrereqs.mock.calls[0][0].cnMode).toBe(true);
    expect(mocks.installAgent.mock.calls[0][1].cnMode.enabled).toBe(true);
    expect(mocks.installAgent.mock.calls[0][1].cnMode.registry).toContain('npmmirror');
    expect(mocks.runDoctor).toHaveBeenCalledWith(expect.anything(), true, expect.any(String));
  });

  it('install -y：agent 安装失败不中断，doctor 汇总失败 → 退出码 1', async () => {
    mocks.installAgent.mockImplementation(async (tool: { id: string }) =>
      tool.id === 'codex' ? 'failed' : 'ok',
    );
    mocks.runDoctor.mockResolvedValue(1);
    const code = await main(['install', '-y']);
    expect(code).toBe(1);
    // 失败的工具之后的工具仍然继续安装
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual([
      'claude-code',
      'codex',
      'pi',
      'opencode',
    ]);
  });

  it('install -i（交互）：runWizard 完成后再写 installed.json（工具+文件），返回 doctor 退出码', async () => {
    mocks.runWizard.mockResolvedValue({
      cancelled: false,
      writtenFiles,
      installedTools: ['codex'],
      doctorCode: 0,
    });
    const code = await main(['install', '-i']);
    expect(code).toBe(0);
    expect(mocks.runWizard).toHaveBeenCalledTimes(1);
    // 向导内部已做配置写入，cli 只补 installed.json
    expect(mocks.writeConfigFiles).not.toHaveBeenCalled();
    const record = JSON.parse(await readFile(join(home, '.ai-stack', 'installed.json'), 'utf8'));
    expect(record.tools).toEqual(['codex']);
    expect(record.files.map((f: { path: string }) => f.path)).toEqual(writtenFiles);
  });

  it('install -i 且向导取消（clack cancel）→ 退出码 130', async () => {
    mocks.runWizard.mockResolvedValue({ cancelled: true, writtenFiles: [], installedTools: [], doctorCode: 0 });
    const code = await main(['install', '-i']);
    expect(code).toBe(130);
  });

  it('install -i --cn：向导收到 cnForced，不再询问网络', async () => {
    mocks.runWizard.mockResolvedValue({ cancelled: false, writtenFiles: [], installedTools: [], doctorCode: 0 });
    await main(['install', '-i', '--cn']);
    const ctx = mocks.runWizard.mock.calls[0][0];
    expect(ctx.cnForced.enabled).toBe(true);
  });

  it('doctor 子命令：调 detect 取平台后转交 runDoctor，返回其退出码', async () => {
    mocks.runDoctor.mockResolvedValue(1);
    const code = await main(['doctor']);
    expect(code).toBe(1);
    expect(mocks.detect).toHaveBeenCalled();
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
  });

  it('update 子命令：执行 updatePrereqs（含 cn 透传）+ doctor，全绿返回 0', async () => {
    mocks.updatePrereqs.mockResolvedValue({ updated: ['pwsh'], failed: [], skipped: ['git'] });
    mocks.runDoctor.mockResolvedValue(0);
    const code = await main(['update', '--cn']);
    expect(code).toBe(0);
    expect(mocks.updatePrereqs).toHaveBeenCalledTimes(1);
    expect(mocks.updatePrereqs.mock.calls[0][0].cnMode).toBe(true);
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
  });

  it('update 子命令：有更新失败 → 退出码 1', async () => {
    mocks.updatePrereqs.mockResolvedValue({ updated: [], failed: ['pwsh'], skipped: [] });
    const code = await main(['update']);
    expect(code).toBe(1);
  });

  it('self-update：清理 npx 缓存 + 全局安装最新版', async () => {
    delete process.env.AI_STACK_SKIP_UPDATE_CHECK;
    const calls: string[] = [];
    vi.spyOn(utils, 'exec').mockImplementation(async (cmd: string) => {
      calls.push(cmd);
      if (cmd.includes('npm view')) return { code: 0, stdout: '0.4.6\n', stderr: '' };
      if (cmd.includes('npm i -g ai-stack-installer@latest')) return { code: 0, stdout: '', stderr: '' };
      return { code: 1, stdout: '', stderr: 'unexpected' };
    });
    const code = await main(['self-update']);
    expect(code).toBe(0);
    expect(calls).toContain('npm i -g ai-stack-installer@latest');
  });

  it('运行时检查：有新版本时提示升级', async () => {
    delete process.env.AI_STACK_SKIP_UPDATE_CHECK;
    vi.spyOn(utils, 'exec').mockImplementation(async (cmd: string) => {
      if (cmd.includes('npm view')) return { code: 0, stdout: '99.0.0\n', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    });
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['list']);
    expect(code).toBe(0);
    const out = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('发现新版本 v99.0.0');
    expect(out).toContain('self-update');
  });

  it('list 子命令：detectTools 输出清单', async () => {
    mocks.detectTools.mockResolvedValue([
      { id: 'node', bin: 'node', installed: true, version: 'v22.5.0' },
      { id: 'claude-code', bin: 'claude', installed: false },
    ]);
    const code = await main(['list']);
    expect(code).toBe(1); // 有未安装 → 1
    expect(mocks.detectTools).toHaveBeenCalledTimes(1);
  });

  it('list 退出码：仅 optIn 工具（CC Switch）未装是预期状态 → 0', async () => {
    mocks.detectTools.mockResolvedValue([
      { id: 'node', bin: 'node', installed: true, version: 'v22.5.0' },
      { id: 'claude-code', bin: 'claude', installed: true, version: '2.1.0' },
      { id: 'cc-switch', bin: 'cc-switch', installed: false },
    ]);
    const code = await main(['list']);
    expect(code).toBe(0);
  });

  it('uninstall 子命令：转交 runUninstall（含 yes 透传），退出码 130（交互取消）', async () => {
    mocks.runUninstall.mockResolvedValue(130);
    const code = await main(['uninstall']);
    expect(code).toBe(130);
    expect(mocks.runUninstall.mock.calls[0][0]).toMatchObject({ yes: false, home });
    mocks.runUninstall.mockResolvedValue(0);
    expect(await main(['uninstall', '-y'])).toBe(0);
    expect(mocks.runUninstall.mock.calls[1][0]).toMatchObject({ yes: true });
  });

  it('--help：输出用法并退出 0', async () => {
    const spy = vi.mocked(console.log);
    spy.mockClear();
    const code = await main(['--help']);
    expect(code).toBe(0);
    expect(spy.mock.calls.some((c) => String(c[0]).includes('用法'))).toBe(true);
  });

  it('--version：输出横幅版本号并退出 0（不被当作未知参数）', async () => {
    const spy = vi.mocked(console.log);
    spy.mockClear();
    const code = await main(['--version']);
    expect(code).toBe(0);
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith('ai-stack v'))).toBe(true);
  });

  it('参数解析错误：红字输出错误并返回 1', async () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const code = await main(['-p', 'huge']);
    expect(code).toBe(1);
    const out = spy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(out).toContain('错误');
    expect(out).toContain('minimal 或 full');
  });
});

describe('cleanupNpxCache（执行完毕自动清理，保持下次拉最新版）', () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-npx-'));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('从 npx 缓存运行（cli.js 直跑）：删除整个 <hash> 缓存目录', async () => {
    // 模拟 .../_npx/<hash>/node_modules/ai-stack-installer/dist/cli.js
    const pkgDir = join(tmpRoot, '_npx', 'abc123', 'node_modules', 'ai-stack-installer');
    await mkdir(join(pkgDir, 'dist'), { recursive: true });
    await cleanupNpxCache(join(pkgDir, 'dist', 'cli.js'));
    // <hash> 目录整个被删除
    await expect(rm(join(tmpRoot, '_npx', 'abc123'), { recursive: true, force: false })).rejects.toThrow();
  });

  it('从 npx 缓存运行（.bin 软链入口）：只删 <hash>，不误删 _npx 根', async () => {
    // 模拟 .../_npx/<hash>/node_modules/.bin/ai-stack（bin 指向 dist/bin.js 时 argv[1] 为软链路径）
    const binDir = join(tmpRoot, '_npx', 'def456', 'node_modules', '.bin');
    await mkdir(binDir, { recursive: true });
    const sentinel = join(tmpRoot, '_npx', 'keep.txt');
    await writeFile(sentinel, 'keep');
    await cleanupNpxCache(join(binDir, 'ai-stack'));
    // 只删除 <hash> 目录
    await expect(rm(join(tmpRoot, '_npx', 'def456'), { recursive: true, force: false })).rejects.toThrow();
    // _npx 根与哨兵文件保留，未被误删
    await expect(readFile(sentinel, 'utf8')).resolves.toBe('keep');
  });

  it('非 npx 缓存路径（本地 dist / 全局安装）：不清理', async () => {
    const f = join(tmpRoot, 'local', 'cli.js');
    await mkdir(join(tmpRoot, 'local'), { recursive: true });
    await writeFile(f, 'x');
    await cleanupNpxCache(f);
    await expect(readFile(f, 'utf8')).resolves.toBe('x'); // 文件保留
  });

  it('无入口参数：跳过', async () => {
    await expect(cleanupNpxCache(undefined)).resolves.toBeUndefined();
  });
});
