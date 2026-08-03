// 交互向导：6 步（① 工具多选 ② 网络 ③ CC Switch ④ 汇总确认 ⑤ 执行 ⑥ 报告），只在 TTY 下被调用
// 依赖：clack/prompts, manifest, detect, proxy, configure, prereq, agents, doctor, logger
import { confirm, isCancel, log as clackLog, multiselect, select, spinner } from '@clack/prompts';
import { installAgent } from './agents.js';
import { printFileReport, writeAliasBlock, writeConfigFiles } from './configure.js';
import { runDoctor } from './doctor.js';
import { configFiles } from './fs-locations.js';
import { log } from './logger.js';
import { ensurePrereqs } from './prereq.js';
import { defaultCnMode, detectLocalProxy, type CnMode } from './proxy.js';
import { updatePrereqs } from './update.js';
import type { Manifest, Platform, ToolSpec, ToolState } from './types.js';

export interface WizardContext {
  manifest: Manifest;
  platform: Platform;
  home: string;
  /** 已探测的工具状态（① 步已装置灰/预选、③ 步 cc-switch 跳过用） */
  states: ToolState[];
  /** --cn 强制启用时传入，跳过步骤②的网络询问 */
  cnForced?: CnMode;
}

export interface WizardResult {
  /** 交互被取消（Ctrl+C / clack cancel）→ 调用方退出码 130 */
  cancelled: boolean;
  /** configure 实际写入的配置文件（写 installed.json 用） */
  writtenFiles: string[];
  /** doctor 汇总退出码：有工具未就绪时为 1 */
  doctorCode: number;
}

type ExecOutcome = 'ok' | 'skipped' | 'aborted' | 'cancelled';

/** 向导：①功能选择 → ②网络 → ③工具多选 → ④cc-switch → ⑤汇总 → ⑥执行+⑦报告 */
export async function runWizard(ctx: WizardContext): Promise<WizardResult> {
  const action = await askAction(); // ① 功能选择
  if (action.cancelled) return cancelledResult();
  if (action.mode === 'update') {
    // 仅更新系统组件：网络确认 → 执行更新 → doctor + 文件清单
    const net = await askNetwork(ctx);
    if (net.cancelled) return cancelledResult();
    return executeUpdate(ctx, net.cnMode);
  }
  for (;;) {
    const picked = await selectTools(ctx); // ③ 工具多选
    if (picked.cancelled) return cancelledResult();
    const cnMode = await askNetwork(ctx); // ② 网络
    if (cnMode.cancelled) return cancelledResult();
    const cc = await askCcSwitch(ctx); // ④
    if (cc.cancelled) return cancelledResult();
    const confirmed = await askSummary(ctx, picked.tools, cc.install); // ⑤
    if (confirmed.cancelled) return cancelledResult();
    if (!confirmed.ok) continue; // 不确认 → 返回 ③

    const targets = cc.install && cc.tool ? [...picked.tools, cc.tool] : picked.tools;
    return execute(ctx, targets, cnMode.cnMode, action.mode === 'all'); // ⑥ 执行 + ⑦ 报告
  }
}

// ---- ① 功能选择：安装 Agent / 更新系统组件 / 全部执行 ----

type WizardAction = { cancelled: boolean; mode: 'install' | 'update' | 'all' };

async function askAction(): Promise<WizardAction> {
  const choice = await select({
    message: '选择要执行的操作',
    options: [
      { value: 'install', label: '安装 AI Agent（已装自动跳过）' },
      { value: 'update', label: '更新系统组件（Node / Git / PowerShell 升级到最新）' },
      { value: 'all', label: '全部执行（先更新组件，再安装 Agent）' },
    ],
  });
  if (isCancel(choice)) return { cancelled: true, mode: 'install' };
  return { cancelled: false, mode: (choice as 'install' | 'update' | 'all') ?? 'install' };
}

/** 仅更新系统组件：updatePrereqs → doctor + 文件清单 */
async function executeUpdate(ctx: WizardContext, cnMode: CnMode): Promise<WizardResult> {
  const spin = spinner();
  spin.start('更新系统组件');
  const pre = await updatePrereqs({
    manifest: ctx.manifest,
    platform: ctx.platform,
    home: ctx.home,
    cnMode: cnMode.enabled,
  });
  spin.stop(pre.failed.length === 0 ? '系统组件更新完成' : `更新失败：${pre.failed.join(', ')}`);
  const doctorCode = await runDoctor(ctx.manifest, cnMode.enabled, ctx.platform);
  await printFileReport(ctx.platform, ctx.home);
  return { cancelled: false, writtenFiles: [], doctorCode };
}

function cancelledResult(): WizardResult {
  return { cancelled: true, writtenFiles: [], doctorCode: 0 };
}

// ---- ① 工具多选：预选未装的非 optIn 工具，已装的置灰并标版本 ----

interface PickResult {
  cancelled: boolean;
  tools: ToolSpec[];
}

async function selectTools(ctx: WizardContext): Promise<PickResult> {
  const candidates = ctx.manifest.agents.filter((t) => t.optIn !== true);
  const options = candidates.map((t) => {
    const state = ctx.states.find((s) => s.id === t.id);
    const installed = state?.installed === true;
    return {
      value: t.id,
      label: t.id,
      hint: installed ? `已装 ${state.version ?? ''}` : undefined,
      disabled: installed ? true : undefined,
    };
  });
  // 全部已装：无可选项（多选会全置灰导致无法继续），直接跳过选择
  if (options.every((o) => o.disabled === true)) {
    await log(
      `所有 AI Agent 均已安装（${candidates.map((t) => t.id).join(', ')}），跳过工具选择，继续配置与检查`,
    );
    return { cancelled: false, tools: [] };
  }
  const initialValues = options.filter((o) => !o.disabled).map((o) => o.value);
  const picked = await multiselect({
    message: '选择要安装的 AI Agent（a 全选 · 空格切换 · 回车确认）',
    options,
    initialValues,
  });
  if (isCancel(picked)) return { cancelled: true, tools: [] };
  return { cancelled: false, tools: candidates.filter((t) => (picked as string[]).includes(t.id)) };
}

// ---- ② 网络：有本地代理询问启用 cn 模式，无代理提示需自行开启仍可启用 ----

interface NetworkResult {
  cancelled: boolean;
  cnMode: CnMode;
}

async function askNetwork(ctx: WizardContext): Promise<NetworkResult> {
  if (ctx.cnForced) return { cancelled: false, cnMode: ctx.cnForced };
  const proxy = await detectLocalProxy();
  const choice = await select({
    message: proxy
      ? `检测到本地代理 ${proxy.host}:${proxy.port}，启用 cn 模式（npmmirror 镜像 + 代理）？`
      : '未检测到本地代理（需自行开启代理），仍可启用 cn 模式？',
    options: [
      { value: 'cn', label: '启用 cn 模式（镜像 + 代理）' },
      { value: 'direct', label: '直连（不启用）' },
    ],
  });
  if (isCancel(choice)) return { cancelled: true, cnMode: defaultCnMode(false) };
  if (choice !== 'cn') return { cancelled: false, cnMode: defaultCnMode(false) };
  return {
    cancelled: false,
    cnMode: {
      enabled: true,
      registry: 'https://registry.npmmirror.com',
      proxyHost: proxy?.host ?? '127.0.0.1',
      proxyPort: proxy?.port ?? 7890,
    },
  };
}

// ---- ③ CC Switch（optIn）：已装跳过，未装询问 ----

interface CcSwitchResult {
  cancelled: boolean;
  install: boolean;
  tool: ToolSpec | null;
}

async function askCcSwitch(ctx: WizardContext): Promise<CcSwitchResult> {
  const cc = ctx.manifest.optInAgents?.find((t) => t.optIn === true);
  if (!cc) return { cancelled: false, install: false, tool: null };
  const state = ctx.states.find((s) => s.id === cc.id);
  if (state?.installed === true) {
    log(`[${cc.id}] 已安装，跳过`);
    return { cancelled: false, install: false, tool: null };
  }
  const want = await confirm({
    message: '是否安装 CC Switch（Claude Code 供应商切换器，桌面版）？',
    initialValue: false,
  });
  if (isCancel(want)) return { cancelled: true, install: false, tool: null };
  return { cancelled: false, install: want === true, tool: cc };
}

// ---- ④ 汇总确认：将安装 N 个 / 写入文件列表 / 跳过项 ----

interface SummaryResult {
  cancelled: boolean;
  ok: boolean;
}

async function askSummary(
  ctx: WizardContext,
  tools: ToolSpec[],
  installCcSwitch: boolean,
): Promise<SummaryResult> {
  const ids = tools.map((t) => t.id);
  if (installCcSwitch) ids.push('cc-switch');
  const files = configFiles(ctx.home).map((cf) => `  ${cf.path}`).join('\n');
  const skipped = ctx.manifest.agents
    .filter((t) => t.optIn !== true && !ids.includes(t.id))
    .map((t) => t.id);
  const msg = `将安装 ${ids.length} 个工具：${ids.join(', ') || '(无)'}\n将写入配置文件：\n${files}`;
  const msgFull = skipped.length > 0 ? `${msg}\n跳过（未勾选）：${skipped.join(', ')}` : msg;
  const confirmed = await confirm({ message: `${msgFull}\n确认继续？`, initialValue: true });
  if (isCancel(confirmed)) return { cancelled: true, ok: false };
  return { cancelled: false, ok: confirmed === true };
}

// ---- ⑤ 执行 + ⑥ 报告：prereq → 逐工具安装（失败三选一）→ 配置写入 → doctor + 文件清单 ----

async function execute(
  ctx: WizardContext,
  tools: ToolSpec[],
  cnMode: CnMode,
  doUpdate = false,
): Promise<WizardResult> {
  const spin = spinner();
  if (doUpdate) {
    // 全部执行模式：先更新系统组件，再装 Agent
    spin.start('更新系统组件');
    const pre = await updatePrereqs({
      manifest: ctx.manifest,
      platform: ctx.platform,
      home: ctx.home,
      cnMode: cnMode.enabled,
    });
    spin.stop(pre.failed.length === 0 ? '系统组件更新完成' : `更新失败：${pre.failed.join(', ')}`);
  }
  spin.start('检查前置依赖');
  const pre = await ensurePrereqs({
    manifest: ctx.manifest,
    platform: ctx.platform,
    home: ctx.home,
    cnMode: cnMode.enabled,
  });
  spin.stop(pre.failed.length === 0 ? '前置依赖就绪' : `前置依赖：${pre.failed.join(', ')} 安装失败`);

  for (const tool of tools) {
    const outcome = await installWithRetry(tool, ctx, cnMode, spin);
    if (outcome === 'cancelled') return cancelledResult();
    if (outcome === 'aborted') {
      clackLog.message('已终止后续安装，保留已装部分');
      break;
    }
  }

  const { written } = await writeConfigFiles(ctx.platform, false, ctx.home);
  await writeAliasBlock(ctx.platform, ctx.home);

  const doctorCode = await runDoctor(ctx.manifest, cnMode.enabled, ctx.platform);
  await printFileReport(ctx.platform, ctx.home);
  return { cancelled: false, writtenFiles: written, doctorCode };
}

/** 安装单个工具：失败时 select 三选一（重试/跳过/终止），重试可反复；Ctrl+C 整体取消 */
async function installWithRetry(
  tool: ToolSpec,
  ctx: WizardContext,
  cnMode: CnMode,
  spin: ReturnType<typeof spinner>,
): Promise<ExecOutcome> {
  for (;;) {
    spin.start(`安装 ${tool.id}`);
    const r = await installAgent(tool, { platform: ctx.platform, cnMode });
    if (r !== 'failed') {
      spin.stop(r === 'ok' ? `安装 ${tool.id} 成功` : `${tool.id} 已安装，跳过`);
      return r;
    }
    spin.stop(`安装 ${tool.id} 失败`);
    const choice = await select({
      message: `「${tool.id}」安装失败，请选择下一步`,
      options: [
        { value: 'retry', label: '重试' },
        { value: 'skip', label: '跳过' },
        { value: 'abort', label: '终止（保留已装部分）' },
      ],
    });
    if (isCancel(choice)) return 'cancelled';
    if (choice === 'skip') {
      await log(`跳过 ${tool.id}`);
      return 'skipped';
    }
    if (choice === 'abort') return 'aborted';
    // retry → 继续循环
  }
}
