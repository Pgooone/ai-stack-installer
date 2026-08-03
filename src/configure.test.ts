import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  collectFileReport,
  rcFileFor,
  removeAliasBlock,
  setConfigDirForTest,
  writeAliasBlock,
  writeConfigFiles,
} from './configure.js';
import { markers } from './fs-locations.js';
import { setLoggerHome } from './logger.js';

const TEMPLATES = {
  'claude.settings.json': '{"hasCompletedOnboarding": true}\n',
  'codex.config.toml': '# codex config skeleton\n',
};

describe('writeConfigFiles（临时模板目录 + 临时 home，不触碰真实用户目录）', () => {
  let tmpRoot: string;
  let configDir: string;
  let home: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-conf-'));
    configDir = join(tmpRoot, 'config');
    home = join(tmpRoot, 'home');
    await mkdir(configDir, { recursive: true });
    await writeFile(join(configDir, 'claude.settings.json'), TEMPLATES['claude.settings.json']);
    await writeFile(join(configDir, 'codex.config.toml'), TEMPLATES['codex.config.toml']);
    setConfigDirForTest(configDir);
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    setConfigDirForTest(undefined);
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('首次写入全部模板：返回实际写入路径，内容与模板一致', async () => {
    const r = await writeConfigFiles('linux', false, home);
    expect(r.written).toHaveLength(2);
    expect(r.written).toContain(join(home, '.claude', 'settings.json'));
    expect(r.written).toContain(join(home, '.codex', 'config.toml'));
    await expect(readFile(join(home, '.claude', 'settings.json'), 'utf8')).resolves.toBe(
      TEMPLATES['claude.settings.json'],
    );
    await expect(readFile(join(home, '.codex', 'config.toml'), 'utf8')).resolves.toBe(
      TEMPLATES['codex.config.toml'],
    );
  });

  it('幂等：目标已存在时不覆盖、不返回，文件内容保持用户修改', async () => {
    await writeConfigFiles('linux', false, home);
    await writeFile(join(home, '.claude', 'settings.json'), '{"user": "custom"}\n');
    const r = await writeConfigFiles('linux', false, home);
    expect(r.written).toEqual([]);
    await expect(readFile(join(home, '.claude', 'settings.json'), 'utf8')).resolves.toBe(
      '{"user": "custom"}\n',
    );
  });

  it('force 覆盖已存在的文件', async () => {
    await writeConfigFiles('linux', false, home);
    await writeFile(join(home, '.claude', 'settings.json'), '{"user": "custom"}\n');
    const r = await writeConfigFiles('linux', true, home);
    expect(r.written).toEqual([join(home, '.claude', 'settings.json'), join(home, '.codex', 'config.toml')]);
    await expect(readFile(join(home, '.claude', 'settings.json'), 'utf8')).resolves.toBe(
      TEMPLATES['claude.settings.json'],
    );
  });

  it('模板缺失时跳过该文件，不影响其余模板', async () => {
    await rm(join(configDir, 'codex.config.toml'));
    const r = await writeConfigFiles('linux', false, home);
    expect(r.written).toEqual([join(home, '.claude', 'settings.json')]);
  });
});

describe('writeAliasBlock（标记块幂等）', () => {
  let tmpRoot: string;
  let home: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-alias-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('linux：rc 文件不存在时创建，写入标记块（alias c 与 proxy 函数）', async () => {
    const r = await writeAliasBlock('linux', home);
    expect(r.rcFile).toBe(join(home, '.bashrc'));
    expect(r.action).toBe('written');
    const content = await readFile(join(home, '.bashrc'), 'utf8');
    expect(content).toContain(markers.start);
    expect(content).toContain(markers.end);
    expect(content).toContain("alias c='claude'");
    expect(content).toContain('proxy_on()');
    expect(content).toContain('unset http_proxy');
  });

  it('幂等：已有标记块时跳过，不重复追加', async () => {
    await writeAliasBlock('linux', home);
    const before = await readFile(join(home, '.bashrc'), 'utf8');
    const r = await writeAliasBlock('linux', home);
    expect(r.action).toBe('exists');
    const after = await readFile(join(home, '.bashrc'), 'utf8');
    expect(after).toBe(before);
    expect(after.match(/ai-stack/g)).toHaveLength(2); // 仅起止两个标记，未重复追加
  });

  it('windows：写入 $PROFILE（Profile.CurrentUserAllHosts），内容用 PowerShell 语法', async () => {
    const r = await writeAliasBlock('windows', home);
    expect(r.rcFile).toBe(join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'));
    expect(r.action).toBe('written');
    const content = await readFile(r.rcFile, 'utf8');
    expect(content).toContain(markers.start);
    expect(content).toContain('Set-Alias -Name c -Value claude');
    expect(content).toContain('function proxy_on');
    expect(content).toContain('$env:http_proxy');
  });

  it('已有 rc 内容（无标记块）时追加而非覆盖', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, 'export EDITOR=vim\n');
    const r = await writeAliasBlock('linux', home);
    expect(r.action).toBe('written');
    const content = await readFile(rc, 'utf8');
    expect(content).toContain('export EDITOR=vim');
    expect(content.indexOf('export EDITOR=vim')).toBeLessThan(content.indexOf(markers.start));
  });

  it('rcFileFor：windows 用 Profile 路径，其余平台用 .bashrc', () => {
    expect(rcFileFor('windows', 'C:\\Users\\tester')).toBe(
      join('C:\\Users\\tester', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    );
    expect(rcFileFor('linux', home)).toBe(join(home, '.bashrc'));
    expect(rcFileFor('macos', home)).toBe(join(home, '.bashrc'));
  });
});

describe('removeAliasBlock（writeAliasBlock 的反向操作）', () => {
  let tmpRoot: string;
  let home: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(os.tmpdir(), 'ai-stack-rmalias-'));
    home = join(tmpRoot, 'home');
    setLoggerHome(tmpRoot);
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it('移除标记块，用户原有内容保留', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, 'export EDITOR=vim\n# >>> ai-stack >>>\nalias c=\'claude\'\n# <<< ai-stack <<<\n');
    const r = await removeAliasBlock('linux', home);
    expect(r.action).toBe('removed');
    const content = await readFile(rc, 'utf8');
    expect(content).toBe('export EDITOR=vim\n');
    expect(content).not.toContain('ai-stack');
  });

  it('标记块在中间：移除后前后内容拼接', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, 'A\n# >>> ai-stack >>>\nx\n# <<< ai-stack <<<\nB\n');
    await removeAliasBlock('linux', home);
    const content = await readFile(rc, 'utf8');
    expect(content).toBe('A\nB\n');
  });

  it('rc 只有标记块（脚本创建）：整个文件删除', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, '# >>> ai-stack >>>\nalias c=\'claude\'\n# <<< ai-stack <<<\n');
    await removeAliasBlock('linux', home);
    await expect(readFile(rc, 'utf8')).rejects.toThrow();
  });

  it('无标记块 → absent，文件原样保留', async () => {
    const rc = join(home, '.bashrc');
    await mkdir(home, { recursive: true });
    await writeFile(rc, 'export EDITOR=vim\n');
    const r = await removeAliasBlock('linux', home);
    expect(r.action).toBe('absent');
    await expect(readFile(rc, 'utf8')).resolves.toBe('export EDITOR=vim\n');
  });

  it('rc 文件不存在 → absent，不报错', async () => {
    const r = await removeAliasBlock('linux', home);
    expect(r.action).toBe('absent');
  });

  it('windows 平台移除 Profile 中的 PowerShell 标记块', async () => {
    const rc = join(home, 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1');
    await mkdir(dirname(rc), { recursive: true });
    await writeFile(rc, '# >>> ai-stack >>>\nSet-Alias -Name c -Value claude\n# <<< ai-stack <<<\n');
    const r = await removeAliasBlock('windows', home);
    expect(r.rcFile).toBe(rc);
    expect(r.action).toBe('removed');
    // 内容只有标记块（脚本创建的文件）→ 整个删除
    await expect(readFile(rc, 'utf8')).rejects.toThrow();
  });
});

describe('collectFileReport', () => {
  it('列出 config 文件与 rc 文件位置（linux）', async () => {
    const report = await collectFileReport('linux', '/fake/home');
    expect(report.map((f) => f.path)).toEqual([
      join('/fake/home', '.claude', 'settings.json'),
      join('/fake/home', '.codex', 'config.toml'),
      join('/fake/home', '.bashrc'),
    ]);
    expect(report[0].desc).toContain('claude.settings.json');
    expect(report[2].desc).toContain('别名');
  });

  it('windows 平台 rc 文件为 Profile 路径', async () => {
    const report = await collectFileReport('windows', 'C:\\Users\\tester');
    expect(report[2].path).toBe(
      join('C:\\Users\\tester', 'Documents', 'PowerShell', 'Microsoft.PowerShell_profile.ps1'),
    );
  });
});
