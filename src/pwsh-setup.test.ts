import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLoggerHome } from './logger.js';
import { ensurePwshIntegration } from './pwsh-setup.js';
import { setExecForTest } from './utils.js';

const WT_SETTINGS = join(
  'Packages',
  'Microsoft.WindowsTerminal_8wekyb3d8bbwe',
  'LocalState',
  'settings.json',
);
const PWSH_GUID = '{574e775e-4f2a-5b96-ac1e-a2962a402336}';

describe('ensurePwshIntegration（mock exec + 临时 LOCALAPPDATA）', () => {
  let tmpRoot: string;
  let originalLocalAppData: string | undefined;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-pwsh-'));
    setLoggerHome(tmpRoot);
    originalLocalAppData = process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA = tmpRoot;
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    setExecForTest(undefined);
    vi.restoreAllMocks();
    if (originalLocalAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = originalLocalAppData;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('非 windows 平台：跳过', async () => {
    const r = await ensurePwshIntegration('linux');
    expect(r).toEqual({ pathFixed: false, terminalDefaultSet: false });
  });

  it('未找到 pwsh：跳过并提示', async () => {
    setExecForTest(async () => ({ code: 1, stdout: '', stderr: 'not found' }));
    const r = await ensurePwshIntegration('windows');
    expect(r.pathFixed).toBe(false);
    expect(r.terminalDefaultSet).toBe(false);
    expect(r.note).toContain('未找到 pwsh');
  });

  it('pwsh 已在系统 PATH 首位且终端已默认 pwsh：无改动（幂等）', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `${pwshDir};C:\\Windows\\system32\n`, stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    // 预置 Windows Terminal settings 且 defaultProfile 已是 pwsh
    const wt = join(tmpRoot, WT_SETTINGS);
    await mkdir(join(wt, '..'), { recursive: true });
    await writeFile(wt, `{\n  "defaultProfile": "${PWSH_GUID}",\n  "profiles": { "list": [ { "source": "PowerShell" } ] }\n}`, 'utf8');
    const r = await ensurePwshIntegration('windows');
    expect(r.pathFixed).toBe(false);
    expect(r.terminalDefaultSet).toBe(false);
  });

  it('pwsh 不在系统 PATH 首位：提升到系统首位（Machine）', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    const writes: string[] = [];
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `C:\\Windows\\system32;${pwshDir}\n`, stderr: '' };
      if (cmd.includes('SetEnvironmentVariable("Path"')) {
        writes.push(cmd);
        return { code: 0, stdout: '', stderr: '' };
      }
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.pathFixed).toBe(true);
    // 提升后的 PATH 以 pwsh 目录开头，且写的是 Machine 级
    const newPath = /SetEnvironmentVariable\("Path", '([^']+)', "Machine"\)/.exec(writes[0])?.[1] ?? '';
    expect(newPath.startsWith(pwshDir)).toBe(true);
    expect(writes[0]).toContain('"Machine"');
  });

  it('无管理员权限（系统 PATH 写入失败）：降级提升用户 PATH 并提示', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    const writes: string[] = [];
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `C:\\Windows\\system32;${pwshDir}\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","User")'))
        return { code: 0, stdout: `C:\\Windows\\system32\n`, stderr: '' };
      if (cmd.includes('SetEnvironmentVariable("Path"')) {
        writes.push(cmd);
        // Machine 写失败（无权限），User 写成功
        return { code: cmd.includes('"Machine"') ? 1 : 0, stdout: '', stderr: 'access denied' };
      }
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.pathFixed).toBe(true); // 降级用户级成功
    expect(writes.length).toBe(2); // Machine 失败 → User 重试
    expect(writes[1]).toContain('"User"');
  });

  it('Windows Terminal 存在但 defaultProfile 未设 pwsh：修改 settings.json 保留注释', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    const wt = join(tmpRoot, WT_SETTINGS);
    await mkdir(join(wt, '..'), { recursive: true });
    await writeFile(
      wt,
      '// Windows Terminal 配置\n{\n  "profiles": { "list": [ { "guid": "{1111}", "name": "cmd" }, { "source": "PowerShell" } ] }\n}\n',
      'utf8',
    );
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `${pwshDir};C:\\Windows\\system32\n`, stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.terminalDefaultSet).toBe(true);
    const after = await readFile(wt, 'utf8');
    expect(after).toContain(`"defaultProfile": "${PWSH_GUID}"`);
    expect(after).toContain('// Windows Terminal 配置'); // 注释保留
  });

  it('用户自定义 pwsh profile（commandline 指向 pwsh + 自定义 GUID）：用实际 GUID 设置', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    const customGuid = '{11111111-2222-3333-4444-555555555555}';
    const wt = join(tmpRoot, WT_SETTINGS);
    await mkdir(join(wt, '..'), { recursive: true });
    await writeFile(
      wt,
      `{\n  "profiles": { "list": [ { "guid": "{aaaa}", "name": "cmd" }, { "guid": "${customGuid}", "name": "PowerShell 7", "commandline": "C:\\\\Program Files\\\\PowerShell\\\\7\\\\pwsh.exe" } ] }\n}\n`,
      'utf8',
    );
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `${pwshDir};C:\\Windows\\system32\n`, stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.terminalDefaultSet).toBe(true);
    const after = await readFile(wt, 'utf8');
    expect(after).toContain(`"defaultProfile": "${customGuid}"`); // 用实际 GUID 而非固定值
  });

  it('Windows Terminal 中无 PowerShell 7 profile：自动添加 profile 并设为默认', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    const wt = join(tmpRoot, WT_SETTINGS);
    await mkdir(join(wt, '..'), { recursive: true });
    await writeFile(
      wt,
      '{\n  "profiles": { "list": [ { "guid": "{aaaa}", "name": "cmd" } ] }\n}\n',
      'utf8',
    );
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `${pwshDir};C:\\Windows\\system32\n`, stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.terminalDefaultSet).toBe(true); // 自动添加 + 设为默认
    const after = await readFile(wt, 'utf8');
    expect(after).toContain(`"defaultProfile": "${PWSH_GUID}"`);
    expect(after).toContain('PowerShell 7'); // profile 已添加
    expect(after).toContain('pwsh.exe'); // commandline 指向 pwsh
  });

  it('无 Windows Terminal：跳过终端设置', async () => {
    const pwshDir = 'C:\\Program Files\\PowerShell\\7';
    setExecForTest(async (cmd) => {
      if (cmd.includes('Get-Command pwsh')) return { code: 0, stdout: `${pwshDir}\\pwsh.exe\n`, stderr: '' };
      if (cmd.includes('GetEnvironmentVariable("Path","Machine")'))
        return { code: 0, stdout: `${pwshDir};C:\\Windows\\system32\n`, stderr: '' };
      throw new Error(`不应执行：${cmd}`);
    });
    const r = await ensurePwshIntegration('windows');
    expect(r.terminalDefaultSet).toBe(false);
  });
});
