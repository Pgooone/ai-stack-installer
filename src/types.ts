// 共享类型定义：manifest 数据结构与运行时状态（无依赖）

export type Platform = 'windows' | 'linux' | 'macos';

export interface DetectInfo {
  platform: Platform;
  isWsl: boolean; // linux 且 /proc/version 含 microsoft
  arch: string; // os.arch() 原样
  home: string; // os.homedir()
}

export interface ToolSpec {
  id: string; // 'claude-code'
  bin: string; // 'claude'（check 用）
  check: string; // 'claude --version'
  minVersion?: string; // 语义化版本下限，不满足视为未装
  needsProxy?: boolean; // 官方安装器直连海外，必须代理
  npmMirror?: boolean; // 纯 npm 安装，可走 npmmirror
  optIn?: boolean; // CC Switch 等默认不装的可选工具
  linux?: string; // 各平台安装命令（POSIX shell）
  macos?: string; // 缺省回退 linux
  windows?: string; // PowerShell 命令
  fallback?: string; // 主通道失败后的 npm 安装命令
  uninstall?: string; // 卸载命令（按平台可分别给出 uninstall.windows 等）
  uninstallWindows?: string;
}

export interface Manifest {
  prereq: ToolSpec[];
  agents: ToolSpec[];
}

export type InstallStatus = 'ok' | 'skipped' | 'failed' | 'missing';

export interface ToolState {
  id: string;
  bin: string;
  installed: boolean;
  version?: string;
}
