import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLoggerHome } from './logger.js';
import type { Manifest, ToolState } from './types.js';

// mock @clack/prompts：每个 prompt 用 mockResolvedValueOnce 序列驱动，验证 6 步顺序与分支
const mocks = vi.hoisted(() => {
  const CANCEL = Symbol('cancel');
  return {
    CANCEL,
    multiselect: vi.fn(),
    select: vi.fn(),
    confirm: vi.fn(),
    spinner: vi.fn(() => ({
      start: vi.fn(),
      stop: vi.fn(),
      message: vi.fn(),
      cancel: vi.fn(),
      error: vi.fn(),
      clear: vi.fn(),
    })),
    logMessage: vi.fn(),
    isCancel: (v: unknown): boolean => v === CANCEL,
    detectProxy: vi.fn(),
    ensurePwshIntegration: vi.fn(),
    installAgent: vi.fn(),
    ensurePrereqs: vi.fn(),
    updatePrereqs: vi.fn(),
    detectUpdates: vi.fn(),
    runDoctor: vi.fn(),
    writeConfigFiles: vi.fn(),
    writeAliasBlock: vi.fn(),
    printFileReport: vi.fn(),
  };
});

vi.mock('@clack/prompts', () => ({
  multiselect: mocks.multiselect,
  select: mocks.select,
  confirm: mocks.confirm,
  spinner: mocks.spinner,
  isCancel: mocks.isCancel,
  log: { message: mocks.logMessage },
}));

vi.mock('./proxy.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('./proxy.js')>();
  return { ...orig, detectProxy: mocks.detectProxy };
});
vi.mock('./agents.js', () => ({ installAgent: mocks.installAgent }));
vi.mock('./pwsh-setup.js', () => ({ ensurePwshIntegration: mocks.ensurePwshIntegration }));
vi.mock('./prereq.js', () => ({ ensurePrereqs: mocks.ensurePrereqs }));
vi.mock('./update.js', () => ({ updatePrereqs: mocks.updatePrereqs, detectUpdates: mocks.detectUpdates }));
vi.mock('./doctor.js', () => ({ runDoctor: mocks.runDoctor }));
vi.mock('./configure.js', () => ({
  writeConfigFiles: mocks.writeConfigFiles,
  writeAliasBlock: mocks.writeAliasBlock,
  printFileReport: mocks.printFileReport,
}));

import { runWizard } from './tui.js';

function makeManifest(): Manifest {
  return {
    prereq: [{ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' }],
    agents: [
      { id: 'claude-code', bin: 'claude', check: 'claude --version', linux: 'x', windows: 'x' },
      { id: 'codex', bin: 'codex', check: 'codex --version', linux: 'x', windows: 'x' },
      { id: 'pi', bin: 'pi', check: 'pi --version', linux: 'x', windows: 'x' },
    ],
    optInAgents: [{ id: 'cc-switch', bin: 'cc-switch', check: 'cc-switch', optIn: true, linux: 'x', windows: 'x' }],
  };
}

function makeStates(): ToolState[] {
  return [
    { id: 'claude-code', bin: 'claude', installed: true, version: 'v2.0.0' }, // 已装 → ① 置灰
    { id: 'codex', bin: 'codex', installed: false },
    { id: 'pi', bin: 'pi', installed: false },
    { id: 'cc-switch', bin: 'cc-switch', installed: false },
  ];
}

describe('runWizard（mock 每个 prompt 返回序列，验证 6 步顺序与分支）', () => {
  let tmpRoot: string;
  let home: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-tui-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
    mocks.multiselect.mockReset();
    mocks.select.mockReset();
    mocks.confirm.mockReset();
    mocks.spinner.mockClear();
    mocks.logMessage.mockReset();
    mocks.detectProxy.mockReset();
    mocks.ensurePwshIntegration.mockReset();
    mocks.ensurePwshIntegration.mockResolvedValue({ pathFixed: false, terminalDefaultSet: false });
    mocks.installAgent.mockReset();
    mocks.ensurePrereqs.mockReset();
    mocks.updatePrereqs.mockReset();
    mocks.detectUpdates.mockReset();
    mocks.runDoctor.mockReset();
    mocks.writeConfigFiles.mockReset();
    mocks.writeAliasBlock.mockReset();
    mocks.printFileReport.mockReset();
    mocks.detectProxy.mockResolvedValue(null);
    mocks.ensurePrereqs.mockResolvedValue({ failed: [] });
    mocks.updatePrereqs.mockResolvedValue({ updated: [], failed: [], skipped: [] });
    mocks.detectUpdates.mockResolvedValue([]);
    mocks.installAgent.mockResolvedValue('ok');
    mocks.runDoctor.mockResolvedValue(0);
    mocks.writeConfigFiles.mockResolvedValue({
      written: [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')],
    });
    mocks.writeAliasBlock.mockResolvedValue({ rcFile: join(home, '.bashrc'), action: 'written' });
    mocks.printFileReport.mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('①功能选择+已装置灰+预选未装；②代理检测到→cn；③装 cc-switch；④汇总；⑤安装 codex+cc-switch；⑥doctor+清单', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.detectProxy.mockResolvedValueOnce({ host: '127.0.0.1', port: 7890 });
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('proxy'); // ② 网络（使用代理+镜像）
    mocks.confirm.mockResolvedValueOnce(true); // ③ cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // ④ 汇总
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });

    // ①：功能选择文案
    expect(mocks.select.mock.calls[0][0].message).toContain('选择要执行的操作');

    // ③（原①）：claude-code 已装置灰并标注版本，未装工具预选
    const msCall = mocks.multiselect.mock.calls[0][0];
    const ccOption = msCall.options.find((o: { value: string }) => o.value === 'claude-code');
    expect(ccOption.disabled).toBe(true);
    expect(ccOption.hint).toContain('v2.0.0');
    expect(msCall.initialValues).toEqual(['codex', 'pi']);

    // ②：代理检测到 → 询问文案含检测结果
    expect(mocks.select.mock.calls[1][0].message).toContain('检测到代理 127.0.0.1:7890');

    // ③④：两次 confirm（cc-switch → 汇总）
    expect(mocks.confirm).toHaveBeenCalledTimes(2);
    expect(mocks.confirm.mock.calls[1][0].message).toContain('将安装 2 个工具');
    expect(mocks.confirm.mock.calls[1][0].message).toContain('codex, cc-switch');

    // ⑤：按序安装 codex 与 cc-switch
    expect(mocks.ensurePrereqs).toHaveBeenCalledTimes(1);
    expect(mocks.ensurePrereqs.mock.calls[0][0].cnMode).toBe(true); // cn 模式透传给 prereq
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex', 'cc-switch']);
    expect(mocks.installAgent.mock.calls[0][1].cnMode.enabled).toBe(true);
    // spinner 逐项提示
    const spin = mocks.spinner.mock.results[0].value;
    expect(spin.start.mock.calls.some((c: string[]) => String(c[0]).includes('安装 codex'))).toBe(true);

    // ⑥：doctor + 文件清单
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(mocks.printFileReport).toHaveBeenCalledTimes(1);

    expect(result).toEqual({
      cancelled: false,
      writtenFiles: [join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')],
      installedTools: ['codex', 'cc-switch'],
      doctorCode: 0,
    });
  });

  it('工具多选全已装：跳过多选（否则全置灰无法继续），直接进入②网络', async () => {
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.confirm.mockResolvedValueOnce(false); // ③ cc-switch 否（cc-switch 保持未装，询问正常进行）
    mocks.confirm.mockResolvedValueOnce(true); // ④ 汇总确认
    // 只把 3 个 agent 标为已装；cc-switch（optIn）保持未装以正常走③询问
    const allInstalled = makeStates().map((s) =>
      s.id === 'cc-switch' ? s : { ...s, installed: true, version: 'v9.9.9' },
    );
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: allInstalled });
    expect(mocks.multiselect).not.toHaveBeenCalled(); // 工具多选跳过
    expect(mocks.select).toHaveBeenCalledTimes(2); // 功能选择 + 网络
    expect(mocks.installAgent).not.toHaveBeenCalled(); // 无工具可装
    expect(result.cancelled).toBe(false);
    expect(result.writtenFiles).toEqual([join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')]);
  });

  it('②未检测到代理：可选 npmmirror 镜像，或直连', async () => {
    mocks.multiselect.mockResolvedValueOnce([]);
    mocks.detectProxy.mockResolvedValueOnce(null);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('mirror'); // ② 网络（无代理 → 选镜像）
    mocks.confirm.mockResolvedValueOnce(false); // ③ cc-switch 否
    mocks.confirm.mockResolvedValueOnce(true); // ④ 汇总（装 0 个）
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result.cancelled).toBe(false);
    expect(mocks.select.mock.calls[1][0].message).toContain('未检测到代理');
    // 无代理时提供镜像选项
    const options = mocks.select.mock.calls[1][0].options.map((o: { label: string }) => o.label);
    expect(options).toContain('使用 npmmirror 镜像');
    expect(options).toContain('直连（默认源）');
    // 汇总文案：装 0 个
    expect(mocks.confirm.mock.calls[1][0].message).toContain('将安装 0 个工具');
  });

  it('③不装 cc-switch：只装勾选工具，汇总不出现 cc-switch', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct');
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch 否
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex']);
    expect(mocks.confirm.mock.calls[1][0].message).toContain('将安装 1 个工具');
  });

  it('④汇总不确认 → 返回工具多选重新选择（循环直到确认）', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct');
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch 否
    mocks.confirm.mockResolvedValueOnce(false); // 汇总不确认 → 回 工具多选
    mocks.multiselect.mockResolvedValueOnce(['codex', 'pi']);
    mocks.confirm.mockResolvedValueOnce(false); // 第二轮 cc-switch 否
    mocks.confirm.mockResolvedValueOnce(true); // 第二轮汇总确认
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(mocks.multiselect).toHaveBeenCalledTimes(2);
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex', 'pi']);
    expect(result.cancelled).toBe(false);
  });

  it('⑤安装失败 → 三选一「重试」成功继续', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.select.mockResolvedValueOnce('retry'); // ⑤ 失败三选一
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    mocks.installAgent
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ok');
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result.cancelled).toBe(false);
    expect(mocks.installAgent).toHaveBeenCalledTimes(2); // 失败一次 + 重试一次
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex', 'codex']);
    // 三选一文案
    expect(mocks.select.mock.calls[2][0].message).toContain('安装失败');
    expect(mocks.select.mock.calls[2][0].options.map((o: { label: string }) => o.label)).toEqual([
      '重试',
      '跳过',
      '终止（保留已装部分）',
    ]);
  });

  it('⑤安装失败 → 「跳过」：不重试，继续下一个工具', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex', 'pi']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.select.mockResolvedValueOnce('skip'); // ⑤ codex 失败 → 跳过
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    mocks.installAgent
      .mockResolvedValueOnce('failed')
      .mockResolvedValueOnce('ok');
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result.cancelled).toBe(false);
    // codex 失败跳过，pi 仍安装
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex', 'pi']);
  });

  it('⑤安装失败 → 「终止」：停止后续安装，仍写配置 + doctor + 文件清单', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex', 'pi']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.select.mockResolvedValueOnce('abort'); // ⑤ codex 失败 → 终止
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    mocks.installAgent.mockResolvedValueOnce('failed');
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result.cancelled).toBe(false);
    expect(mocks.installAgent).toHaveBeenCalledTimes(1); // pi 不再安装
    expect(mocks.writeConfigFiles).toHaveBeenCalledTimes(1); // 配置仍写入
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(mocks.printFileReport).toHaveBeenCalledTimes(1);
    expect(mocks.logMessage.mock.calls.some((c: unknown[]) => String(c[0]).includes('终止'))).toBe(true);
  });

  it('功能选择被取消（clack cancel）→ cancelled=true', async () => {
    mocks.select.mockResolvedValueOnce(mocks.CANCEL);
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result).toEqual({ cancelled: true, writtenFiles: [], installedTools: [], doctorCode: 0 });
  });

  it('功能选择「更新系统组件」：先检测 → 多选要更新的 → 只更新选中项', async () => {
    mocks.select.mockResolvedValueOnce('update'); // ① 功能选择 → 更新
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.detectUpdates.mockResolvedValueOnce([
      { tool: { id: 'node' }, current: 'v20.0.0', hasUpdate: true },
      { tool: { id: 'pwsh' }, current: '7.6.4', hasUpdate: false },
    ] as never);
    mocks.multiselect.mockResolvedValueOnce(['node']); // 只选 node（pwsh 已最新不预选）
    mocks.updatePrereqs.mockResolvedValueOnce({ updated: ['node'], failed: [], skipped: [] });
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(mocks.confirm).not.toHaveBeenCalled();
    // 检测结果呈现：多选文案含状态标记
    const msCall = mocks.multiselect.mock.calls[0][0];
    expect(msCall.message).toContain('选择要更新的系统组件');
    expect(msCall.initialValues).toEqual(['node']); // 已最新的 pwsh 不预选
    // 只更新选中的
    expect(mocks.updatePrereqs).toHaveBeenCalledTimes(1);
    expect(mocks.updatePrereqs.mock.calls[0][1]).toEqual(['node']);
    expect(mocks.ensurePwshIntegration).toHaveBeenCalledTimes(1); // pwsh 更新后 PATH 提升（幂等）
    expect(mocks.runDoctor).toHaveBeenCalledTimes(1);
    expect(mocks.printFileReport).toHaveBeenCalledTimes(1);
    expect(result.cancelled).toBe(false);
  });

  it('功能选择「更新系统组件」且多选被取消 → cancelled', async () => {
    mocks.select.mockResolvedValueOnce('update'); // ① 功能选择 → 更新
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.detectUpdates.mockResolvedValueOnce([]);
    mocks.multiselect.mockResolvedValueOnce(mocks.CANCEL);
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(result).toEqual({ cancelled: true, writtenFiles: [], installedTools: [], doctorCode: 0 });
  });

  it('功能选择「全部执行」：先更新组件，再走安装流程', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.select.mockResolvedValueOnce('all'); // ① 功能选择 → 全部
    mocks.select.mockResolvedValueOnce('direct'); // ② 网络
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    mocks.updatePrereqs.mockResolvedValueOnce({ updated: ['node'], failed: [], skipped: [] });
    const result = await runWizard({ manifest: makeManifest(), platform: 'linux', home, states: makeStates() });
    expect(mocks.updatePrereqs).toHaveBeenCalledTimes(1); // 全部执行先更新
    expect(mocks.installAgent.mock.calls.map((c) => c[0].id)).toEqual(['codex']);
    expect(result.cancelled).toBe(false);
  });

  it('--cn 强制（cnForced）：跳过网络询问', async () => {
    mocks.multiselect.mockResolvedValueOnce(['codex']);
    mocks.select.mockResolvedValueOnce('install'); // ① 功能选择
    mocks.confirm.mockResolvedValueOnce(false); // cc-switch
    mocks.confirm.mockResolvedValueOnce(true); // 汇总
    const result = await runWizard({
      manifest: makeManifest(),
      platform: 'linux',
      home,
      states: makeStates(),
      cnForced: { enabled: true, registry: 'https://registry.npmmirror.com', proxyHost: '127.0.0.1', proxyPort: 7890 },
    });
    expect(mocks.select).toHaveBeenCalledTimes(1); // 仅功能选择，网络询问被跳过
    expect(mocks.detectProxy).not.toHaveBeenCalled();
    expect(mocks.installAgent.mock.calls[0][1].cnMode.enabled).toBe(true);
    expect(result.cancelled).toBe(false);
  });
});
