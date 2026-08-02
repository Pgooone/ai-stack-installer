// 路径与标记：安装目录、日志、rc/config 文件（依赖：types；home 通过参数注入以便测试）
import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import type { Platform } from './types.js';

export interface ConfigFile {
  path: string;
  template: string;
}

// 幂等块标记
export const markers = {
  start: '# >>> ai-stack >>>',
  end: '# <<< ai-stack <<<',
} as const;

export function aiStackDir(home: string = os.homedir()): string {
  return join(home, '.ai-stack');
}

export function logFile(home: string = os.homedir()): string {
  return join(aiStackDir(home), 'install.log');
}

/** rc 文件：linux/macos 列存在的 ~/.bashrc、~/.zshrc；windows 为 pwsh Profile.CurrentUserAllHosts 路径 */
export function rcFiles(platform: Platform, home: string = os.homedir()): string[] {
  if (platform === 'windows') {
    return [join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1')];
  }
  return ['.bashrc', '.zshrc'].map((f) => join(home, f)).filter((p) => existsSync(p));
}

/** 配置模板文件：目标路径 + config/ 目录下的模板名 */
export function configFiles(home: string = os.homedir()): ConfigFile[] {
  return [
    { path: join(home, '.claude', 'settings.json'), template: 'claude.settings.json' },
    { path: join(home, '.codex', 'config.toml'), template: 'codex.config.toml' },
  ];
}

/** npx 缓存目录（透明性报告用） */
export function npxCacheDir(home: string = os.homedir()): string {
  return join(home, '.npm', '_npx');
}
