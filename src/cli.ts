#!/usr/bin/env node
// CLI 入口：参数解析/模式选择/子命令分派/main 错误处理（依赖：全部模块）
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { rm } from 'node:fs/promises';
import { installAgent } from './agents.js';
import { printFileReport, writeAliasBlock, writeConfigFiles } from './configure.js';
import { detect, detectTools } from './detect.js';
import { runDoctor } from './doctor.js';
import { hashFile, writeInstalledJson } from './installed.js';
import { fail, log, ok } from './logger.js';
import { getAgent, loadManifest } from './manifest.js';
import { ensurePrereqs } from './prereq.js';
import { defaultCnMode } from './proxy.js';
import { ensurePwshIntegration } from './pwsh-setup.js';
import { executeUpdate, runWizard } from './tui.js';
import type { Manifest, Platform } from './types.js';
import { runUninstall } from './uninstall.js';
import { updatePrereqs } from './update.js';
import { detectTty, exec, versionGte } from './utils.js';

export type CliCommand = 'install' | 'doctor' | 'update' | 'self-update' | 'uninstall' | 'list';
export type Profile = 'minimal' | 'full';

export interface CliOptions {
  command: CliCommand;
  yes: boolean;
  interactive: boolean;
  cn: boolean;
  profile: Profile;
}

export interface CliEnv {
  platform: Platform;
  home: string;
}

const USAGE = `ai-stack — AI Agent 一键安装脚本（跨平台）

用法: ai-stack [子命令] [参数]

子命令:
  install      安装（默认）：探测 → 向导/直装 → 依赖 → 工具 → 配置 → 自检
  update       更新系统组件（Node / Git / PowerShell 升级到最新）后自检
  self-update  升级脚本自身（清缓存 + 全局安装最新版）
  doctor       自检：输出各工具版本与状态（退出码：有未就绪为 1）
  uninstall    卸载：移除工具、配置与 ~/.ai-stack（默认交互确认）
  list         列出 manifest 工具清单与安装状态

参数:
  -y, --yes               跳过向导直装
  -i, --interactive       强制进入交互向导
  --cn                    强制 cn 模式（npmmirror 镜像 + 本地代理）
  -p, --profile <mode>    直装范围: minimal=仅 claude-code, full=全部（默认 full）
  -h, --help              显示本帮助`;

/** 解析参数：第一个位置参数为子命令（缺省 install），其余为选项；非法参数抛错 */
export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = { command: 'install', yes: false, interactive: false, cn: false, profile: 'full' };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '-y':
      case '--yes':
        opts.yes = true;
        break;
      case '-i':
      case '--interactive':
        opts.interactive = true;
        break;
      case '--cn':
        opts.cn = true;
        break;
      case '-p':
      case '--profile': {
        const val = argv[++i];
        if (val === 'minimal' || val === 'full') {
          opts.profile = val;
        } else {
          throw new Error(`-p/--profile 需要 minimal 或 full（收到：${val ?? '(缺失)'}）`);
        }
        break;
      }
      case '--profile=minimal':
        opts.profile = 'minimal';
        break;
      case '--profile=full':
        opts.profile = 'full';
        break;
      default:
        if (arg.startsWith('-')) {
          throw new Error(`未知参数：${arg}`);
        }
        positional.push(arg);
    }
  }
  const cmd = positional[0];
  if (cmd) {
    if (
      cmd === 'install' ||
      cmd === 'doctor' ||
      cmd === 'update' ||
      cmd === 'self-update' ||
      cmd === 'uninstall' ||
      cmd === 'list'
    ) {
      opts.command = cmd;
    } else {
      throw new Error(`未知子命令：${cmd}`);
    }
  }
  return opts;
}

/** 模式选择：interactive = (-i) || (!-y && detectTty()) */
export function decideInteractive(opts: Pick<CliOptions, 'yes' | 'interactive'>): boolean {
  return opts.interactive || (!opts.yes && detectTty());
}

/** 顶层入口：main() 内 catch 全部错误，红字输出并返回退出码 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  try {
    // 每次执行显示版本号，便于识别是否命中 npx 旧缓存
    console.log(`ai-stack v${packageVersion()}`);
    await checkForUpdate(); // 运行时检查新版本（失败静默，不阻塞主流程）
    if (argv.includes('-h') || argv.includes('--help')) {
      console.log(USAGE);
      return 0;
    }
    const opts = parseArgs(argv);
    if (opts.command === 'self-update') return runSelfUpdate();
    const manifest = await loadManifest();
    if (opts.command === 'doctor') return runDoctor(manifest, opts.cn, (await detect()).platform);
    if (opts.command === 'list') return runList(manifest);
    // home 取自 detect()：测试可注入临时目录，不触碰真实用户目录
    const info = await detect();
    const env: CliEnv = { platform: info.platform, home: info.home };
    if (opts.command === 'update') return runUpdate(env, manifest, opts.cn);
    if (opts.command === 'install') return runInstall(opts, env, manifest);
    return runUninstall({ manifest, platform: env.platform, home: env.home, yes: opts.yes });
  } catch (err) {
    await fail(`错误：${(err as Error).message}`);
    return 1;
  } finally {
    await cleanupNpxCache(process.argv[1]); // 执行完毕自动清理 npx 缓存（保持下次拉最新版）
  }
}

/** 运行时检查 npm 最新版；有新版提示；网络异常静默（AI_STACK_SKIP_UPDATE_CHECK=1 可跳过） */
async function checkForUpdate(): Promise<void> {
  if (process.env.AI_STACK_SKIP_UPDATE_CHECK === '1') return;
  try {
    const r = await exec('npm view ai-stack-installer version', { timeout: 3000 });
    if (r.code !== 0) return;
    const latest = r.stdout.trim();
    const current = packageVersion();
    if (latest && latest !== current && !versionGte(current, latest)) {
      await log(`发现新版本 v${latest}（当前 v${current}），运行 ai-stack self-update 升级`);
    }
  } catch {
    /* 网络异常静默 */
  }
}

/** self-update：清 npx 缓存（强制刷新）+ 全局安装最新版 */
async function runSelfUpdate(): Promise<number> {
  await cleanupNpxCache(process.argv[1]); // 强制刷新缓存，避免拉到旧版
  await log('升级中：npm i -g ai-stack-installer@latest');
  const r = await exec('npm i -g ai-stack-installer@latest');
  if (r.code === 0) {
    await ok('升级完成，请重新运行以使用新版本');
    return 0;
  }
  await fail(`升级失败：${r.stderr.trim() || '(无错误输出)'}`);
  return 1;
}

/** 从 package.json 读版本（dist/ 与 src/ 深度不同，向上查找） */
function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* 继续向上 */
    }
    dir = dirname(dir);
  }
  return 'unknown';
}

/** 执行完毕自动清理 npx 缓存中的本包目录（下次 npx 重新拉取最新版）；仅当从 _npx 缓存运行且非测试/本地包 */
export async function cleanupNpxCache(entry: string | undefined): Promise<void> {
  if (!entry) return;
  const norm = entry.replace(/\\/g, '/');
  if (!norm.includes('/_npx/')) return; // 非 npx 缓存运行（本地 dist / 全局安装）不清理
  // entry = .../_npx/<hash>/node_modules/ai-stack-installer/dist/cli.js → 上溯 4 层到 <hash>
  const cacheDir = dirname(dirname(dirname(dirname(entry))));
  try {
    await rm(cacheDir, { recursive: true, force: true });
    await log(`已清理 npx 缓存（${cacheDir}），下次将拉取最新版`);
  } catch {
    /* 清理失败不影响结果 */
  }
}

async function runInstall(opts: CliOptions, env: CliEnv, manifest: Manifest): Promise<number> {
  if (decideInteractive(opts)) return runInstallWizard(opts, env, manifest);
  return runInstallDirect(opts, env, manifest);
}

// ---- update：更新系统组件（node/git/pwsh 升级到最新），cn 模式下注入镜像/代理 ----

async function runUpdate(env: CliEnv, manifest: Manifest, cn: boolean): Promise<number> {
  if (detectTty()) {
    // 交互：先检测可用更新 → 多选 → 只更新选中的
    const cnMode = cn ? defaultCnMode(true) : defaultCnMode(false);
    const result = await executeUpdate(
      {
        manifest,
        platform: env.platform,
        home: env.home,
        states: await detectTools(manifest),
        cnForced: cn ? cnMode : undefined,
      },
      cnMode,
    );
    if (result.cancelled) return 130;
    return result.doctorCode;
  }
  // 非交互（管道/CI/-y 场景）：全部更新
  const result = await updatePrereqs({ manifest, platform: env.platform, home: env.home, cnMode: cn });
  if (result.failed.length > 0) await fail(`更新失败：${result.failed.join(', ')}`);
  await ensurePwshIntegration(env.platform); // Windows：pwsh 升级后 PATH 首位 + 终端默认
  const code = await runDoctor(manifest, cn, env.platform);
  return result.failed.length > 0 || code !== 0 ? 1 : 0;
}

// ---- install（交互向导）：runWizard 6 步完成后记录 installed.json ----

async function runInstallWizard(opts: CliOptions, env: CliEnv, manifest: Manifest): Promise<number> {
  const states = await detectTools(manifest);
  const result = await runWizard({
    manifest,
    platform: env.platform,
    home: env.home,
    states,
    cnForced: opts.cn ? defaultCnMode(true) : undefined,
  });
  if (result.cancelled) return 130; // clack cancel（Ctrl+C）
  await writeInstalledJson(env.home, await hashFiles(result.writtenFiles), result.installedTools);
  await ensurePwshIntegration(env.platform); // Windows：pwsh PATH 首位 + 终端默认（幂等）
  if (result.doctorCode !== 0) await fail('部分工具未就绪（doctor 结果见上），退出码 1');
  return result.doctorCode;
}

/** 对刚写入的文件计算内容 hash（卸载时校验用；读不到的跳过） */
async function hashFiles(paths: string[]): Promise<{ path: string; hash?: string }[]> {
  const out: { path: string; hash?: string }[] = [];
  for (const p of paths) {
    out.push({ path: p, hash: await hashFile(p) });
  }
  return out;
}

// ---- install（直装）：prereq → 逐个安装（失败跳过继续）→ 配置 → doctor → 文件清单 → installed.json ----

async function runInstallDirect(opts: CliOptions, env: CliEnv, manifest: Manifest): Promise<number> {
  const cnMode = opts.cn ? defaultCnMode(true) : defaultCnMode(false);
  await log('非交互环境：跳过向导，使用默认配置（-i 进入向导）');
  const targets =
    opts.profile === 'minimal'
      ? [getAgent(manifest, 'claude-code')].filter((t): t is NonNullable<typeof t> => t !== undefined)
      : manifest.agents.filter((t) => t.optIn !== true);
  await ensurePrereqs({ manifest, platform: env.platform, home: env.home, cnMode: cnMode.enabled });
  const installedTools: string[] = [];
  for (const tool of targets) {
    const r = await installAgent(tool, { platform: env.platform, cnMode });
    if (r === 'ok') installedTools.push(tool.id); // 仅记录实际安装的，用户已有（skipped）绝不记录
  }
  const { written } = await writeConfigFiles(env.platform, false, env.home);
  await writeAliasBlock(env.platform, env.home);
  await ensurePwshIntegration(env.platform); // Windows：pwsh PATH 首位 + 终端默认（幂等）
  const doctorCode = await runDoctor(manifest, cnMode.enabled, env.platform);
  await printFileReport(env.platform, env.home);
  await writeInstalledJson(env.home, await hashFiles(written), installedTools);
  if (doctorCode !== 0) await fail('部分工具未就绪（doctor 结果见上），退出码 1');
  return doctorCode;
}

// ---- list：detectTools 表格输出，退出码 = 全部就绪 ? 0 : 1 ----

const LIST_NAME_W = 16;

async function runList(manifest: Manifest): Promise<number> {
  const states = await detectTools(manifest);
  await log('工具清单（manifest）与安装状态：');
  for (const s of states) {
    await log(`${s.id.padEnd(LIST_NAME_W)} | ${s.installed ? `✓ ${s.version ?? '已安装'}` : '✗ 未安装'}`);
  }
  // 退出码只计非 optIn 工具的缺失（optIn 未装是预期状态，如 CC Switch），与 doctor 同规则
  const optInIds = new Set((manifest.optInAgents ?? []).map((t) => t.id));
  return states.every((s) => s.installed || optInIds.has(s.id)) ? 0 : 1;
}

// ---- bin 入口：npm 包指向 dist/cli.js；测试 import 本模块时跳过 ----

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (err) {
    await fail(`错误：${(err as Error).message}`);
    process.exitCode = 1;
  }
}
