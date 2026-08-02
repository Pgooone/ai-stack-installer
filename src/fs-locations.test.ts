import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { aiStackDir, configFiles, logFile, markers, npxCacheDir, rcFiles } from './fs-locations.js';

describe('fs-locations（home 显式注入，不触碰真实用户目录）', () => {
  it('aiStackDir/logFile/npxCacheDir 基于 home 拼接', () => {
    expect(aiStackDir('/fake/home')).toBe(join('/fake/home', '.ai-stack'));
    expect(logFile('/fake/home')).toBe(join('/fake/home', '.ai-stack', 'install.log'));
    expect(npxCacheDir('/fake/home')).toBe(join('/fake/home', '.npm', '_npx'));
  });

  it('linux：rc 文件只列存在的', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-rc-'));
    try {
      await writeFile(join(dir, '.bashrc'), '# bash');
      // 故意不创建 .zshrc
      const files = rcFiles('linux', dir);
      expect(files).toEqual([join(dir, '.bashrc')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('linux：两个 rc 文件都存在时按序列出', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-rc-'));
    try {
      await writeFile(join(dir, '.bashrc'), '# bash');
      await writeFile(join(dir, '.zshrc'), '# zsh');
      expect(rcFiles('linux', dir)).toEqual([join(dir, '.bashrc'), join(dir, '.zshrc')]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('linux：目录为空时返回空数组', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-rc-'));
    try {
      expect(rcFiles('linux', dir)).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('windows：返回 pwsh Profile.CurrentUserAllHosts 路径（不要求存在）', () => {
    const files = rcFiles('windows', 'C:\\Users\\tester');
    expect(files).toEqual([
      win32.join('C:\\Users\\tester', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    ]);
  });

  it('configFiles：claude settings 与 codex config 模板', () => {
    const files = configFiles('/fake/home');
    expect(files).toContainEqual({
      path: join('/fake/home', '.claude', 'settings.json'),
      template: 'claude.settings.json',
    });
    expect(files).toContainEqual({
      path: join('/fake/home', '.codex', 'config.toml'),
      template: 'codex.config.toml',
    });
  });

  it('markers 为幂等块标记', () => {
    expect(markers.start).toBe('# >>> ai-stack >>>');
    expect(markers.end).toBe('# <<< ai-stack <<<');
  });

  it('默认 home 使用真实 os.homedir()', () => {
    expect(aiStackDir()).toBe(join(os.homedir(), '.ai-stack'));
  });
});
