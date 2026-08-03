import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getAgent,
  getPrereq,
  installCmd,
  loadManifest,
  stateOf,
  validateManifest,
} from './manifest.js';
import type { Manifest, ToolSpec } from './types.js';
import { setExecForTest } from './utils.js';

function makeManifest(): Manifest {
  return {
    prereq: [
      {
        id: 'node',
        bin: 'node',
        check: 'node -v',
        minVersion: '20.0.0',
        linux: 'fnm install --lts',
        windows: 'winget install --id OpenJS.NodeJS.LTS -e --silent',
      },
      {
        id: 'git',
        bin: 'git',
        check: 'git --version',
        linux: 'apt install -y git',
        windows: 'winget install --id Git.Git -e --silent',
        fallback: 'npm i -g git',
      },
    ],
    agents: [
      {
        id: 'claude-code',
        bin: 'claude',
        check: 'claude --version',
        linux: 'npm i -g @anthropic-ai/claude-code',
        windows: 'npm i -g @anthropic-ai/claude-code',
      },
      {
        id: 'codex',
        bin: 'codex',
        check: 'codex --version',
        minVersion: '0.1.0',
        linux: 'npm i -g @openai/codex',
        windows: 'npm i -g @openai/codex',
        fallback: 'npm i -g @openai/codex --force',
        uninstall: 'npm rm -g @openai/codex',
      },
    ],
  };
}

describe('validateManifest', () => {
  it('合法 manifest 不抛错', () => {
    expect(() => validateManifest(makeManifest())).not.toThrow();
  });

  it('重复 id 抛错并带修复信息', () => {
    const m = makeManifest();
    m.agents.push({ ...m.agents[0], id: 'node' }); // 与 prereq.node 重复
    expect(() => validateManifest(m)).toThrow(/id 重复：node/);
  });

  it('check 为空抛错', () => {
    const m = makeManifest();
    m.agents[0].check = '';
    expect(() => validateManifest(m)).toThrow(/\[claude-code\] check 为空/);
  });

  it('bin 为空抛错', () => {
    const m = makeManifest();
    m.agents[0].bin = '';
    expect(() => validateManifest(m)).toThrow(/\[claude-code\] bin 为空/);
  });

  it('某平台没有任何安装命令抛错', () => {
    const m = makeManifest();
    m.agents[0].linux = undefined;
    m.agents[0].fallback = undefined;
    expect(() => validateManifest(m)).toThrow(/linux 平台缺少安装命令/);
    expect(() => validateManifest(m)).toThrow(/macos 平台缺少安装命令/);
  });

  it('windows 平台缺命令且无 fallback 抛错', () => {
    const m = makeManifest();
    m.agents[0].windows = undefined;
    m.agents[0].fallback = undefined;
    expect(() => validateManifest(m)).toThrow(/windows 平台缺少安装命令/);
  });

  it('minVersion 非语义化版本抛错', () => {
    const m = makeManifest();
    m.agents[0].minVersion = 'latest';
    expect(() => validateManifest(m)).toThrow(/minVersion 不是语义化版本/);
  });

  it('macos 可回退 linux，仅 macos 缺省不算错误', () => {
    const m = makeManifest();
    m.agents[0].macos = undefined; // 有 linux 即可
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('prereq 允许无安装命令（node 由专属逻辑安装，仅 windows 的 pwsh 合法）', () => {
    const m: Manifest = {
      prereq: [
        { id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' },
        { id: 'pwsh', bin: 'pwsh', check: 'pwsh -v', onlyOnWindows: true, windows: 'winget install --id Microsoft.PowerShell' },
      ],
      agents: [
        { id: 'claude-code', bin: 'claude', check: 'claude --version', linux: 'x', windows: 'x' },
      ],
    };
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('optInAgents 同样要求每平台安装命令', () => {
    const m = makeManifest();
    m.optInAgents = [{ id: 'cc-switch', bin: 'cc-switch', check: 'cc-switch', optIn: true }];
    expect(() => validateManifest(m)).toThrow(/cc-switch.*linux 平台缺少安装命令/);
  });

  it('optInAgents 中的重复 id 也被检出', () => {
    const m = makeManifest();
    m.optInAgents = [{ ...m.agents[0], id: 'codex', optIn: true }];
    expect(() => validateManifest(m)).toThrow(/id 重复：codex/);
  });
});

describe('loadManifest（fixture 目录注入，不读真实仓库）', () => {
  it('从指定目录加载并校验', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-manifest-'));
    try {
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(makeManifest()));
      const m = await loadManifest(dir);
      expect(m.prereq.map((p) => p.id)).toEqual(['node', 'git']);
      expect(m.agents.map((a) => a.id)).toEqual(['claude-code', 'codex']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('兼容嵌套深度：src/ 与 dist/ 均向上找到仓库根 manifest.json', async () => {
    const root = await mkdtemp(join(os.tmpdir(), 'ai-stack-root-'));
    try {
      await writeFile(join(root, 'manifest.json'), JSON.stringify(makeManifest()));
      await mkdir(join(root, 'src'), { recursive: true });
      await mkdir(join(root, 'dist'), { recursive: true });
      const fromSrc = await loadManifest(join(root, 'src'));
      const fromDist = await loadManifest(join(root, 'dist'));
      expect(fromSrc.agents).toHaveLength(2);
      expect(fromDist.agents).toHaveLength(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('找不到 manifest.json 抛错', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-empty-'));
    try {
      await expect(loadManifest(dir)).rejects.toThrow(/未找到 manifest\.json/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('非法 JSON 抛错', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-bad-'));
    try {
      await writeFile(join(dir, 'manifest.json'), 'not-json{{');
      await expect(loadManifest(dir)).rejects.toThrow(/不是合法 JSON/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('校验失败（重复 id）时抛错', async () => {
    const dir = await mkdtemp(join(os.tmpdir(), 'ai-stack-dup-'));
    try {
      const m = makeManifest();
      m.agents.push({ ...m.agents[0], id: 'node' });
      await writeFile(join(dir, 'manifest.json'), JSON.stringify(m));
      await expect(loadManifest(dir)).rejects.toThrow(/id 重复/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('getAgent / getPrereq', () => {
  it('getAgent 按 id 查找 agent，找不到返回 undefined', () => {
    const m = makeManifest();
    expect(getAgent(m, 'claude-code')?.bin).toBe('claude');
    expect(getAgent(m, '不存在的工具')).toBeUndefined();
  });

  it('getPrereq 按 id 查找 prereq，找不到返回 undefined', () => {
    const m = makeManifest();
    expect(getPrereq(m, 'node')?.minVersion).toBe('20.0.0');
    expect(getPrereq(m, '不存在的工具')).toBeUndefined();
  });
});

describe('installCmd', () => {
  const tool: ToolSpec = {
    id: 'c',
    bin: 'claude',
    check: 'claude --version',
    linux: 'npm i -g @anthropic-ai/claude-code',
    macos: 'brew install --cask claude',
    windows: 'npm i -g @anthropic-ai/claude-code',
    fallback: 'npm i -g @anthropic-ai/claude-code --force',
  };

  it('按平台选命令，macos 缺省回退 linux', () => {
    expect(installCmd(tool, 'linux')).toBe('npm i -g @anthropic-ai/claude-code');
    expect(installCmd(tool, 'windows')).toBe('npm i -g @anthropic-ai/claude-code');
    expect(installCmd(tool, 'macos')).toBe('brew install --cask claude');
    const noMac: ToolSpec = { ...tool, macos: undefined };
    expect(installCmd(noMac, 'macos')).toBe('npm i -g @anthropic-ai/claude-code');
  });

  it('该平台无命令返回 undefined', () => {
    const onlyLinux: ToolSpec = { ...tool, windows: undefined, macos: undefined, fallback: undefined };
    expect(installCmd(onlyLinux, 'windows')).toBeUndefined();
  });

  it('cn 模式：npm 命令自动加 npmmirror registry', () => {
    expect(installCmd(tool, 'linux', true)).toBe(
      'npm i -g @anthropic-ai/claude-code --registry=https://registry.npmmirror.com',
    );
  });

  it('cn 模式：非 npm 命令（brew/winget 等）不变', () => {
    expect(installCmd(tool, 'macos', true)).toBe('brew install --cask claude');
    const winget: ToolSpec = { ...tool, windows: 'winget install --id Farion.CC-Switch' };
    expect(installCmd(winget, 'windows', true)).toBe('winget install --id Farion.CC-Switch');
    const curl: ToolSpec = { ...tool, linux: 'curl -fsSL https://example.com/install.sh | bash' };
    expect(installCmd(curl, 'linux', true)).toBe('curl -fsSL https://example.com/install.sh | bash');
  });

  it('cn 模式：命令已含 --registry= 时不重复注入', () => {
    const custom: ToolSpec = {
      ...tool,
      linux: 'npm i -g x --registry=https://mirror.example.com',
    };
    expect(installCmd(custom, 'linux', true)).toBe(
      'npm i -g x --registry=https://mirror.example.com',
    );
  });

  it('非 cn 模式不注入 registry', () => {
    expect(installCmd(tool, 'linux', false)).toBe('npm i -g @anthropic-ai/claude-code');
  });
});

describe('stateOf', () => {
  afterEach(() => setExecForTest(undefined));

  it('check 成功取首行版本', async () => {
    setExecForTest(async () => ({ code: 0, stdout: 'v22.5.0\r\nsome warning\r\n', stderr: '' }));
    const s = await stateOf({ id: 'node', bin: 'node', check: 'node -v' });
    expect(s).toEqual({ id: 'node', bin: 'node', installed: true, version: '22.5.0' });
  });

  it('minVersion 不满足视为未装', async () => {
    setExecForTest(async () => ({ code: 0, stdout: 'v18.20.1\n', stderr: '' }));
    const s = await stateOf({ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' });
    expect(s.installed).toBe(false);
  });

  it('minVersion 满足视为已装', async () => {
    setExecForTest(async () => ({ code: 0, stdout: 'v20.0.0\n', stderr: '' }));
    const s = await stateOf({ id: 'node', bin: 'node', check: 'node -v', minVersion: '20.0.0' });
    expect(s.installed).toBe(true);
    expect(s.version).toBe('20.0.0');
  });

  it('check 失败（非零 code）视为未装', async () => {
    setExecForTest(async () => ({ code: 127, stdout: '', stderr: 'command not found' }));
    const s = await stateOf({ id: 'x', bin: 'x', check: 'x --version' });
    expect(s).toEqual({ id: 'x', bin: 'x', installed: false });
  });

  it('check 超时（code -1）视为未装', async () => {
    setExecForTest(async () => ({ code: -1, stdout: '', stderr: '' }));
    const s = await stateOf({ id: 'x', bin: 'x', check: 'x --version' });
    expect(s.installed).toBe(false);
  });

  it('命令成功但无版本输出：无 minVersion 视为已装，有 minVersion 视为未装', async () => {
    setExecForTest(async () => ({ code: 0, stdout: '', stderr: '' }));
    await expect(stateOf({ id: 'a', bin: 'a', check: 'a' })).resolves.toMatchObject({ installed: true });
    await expect(stateOf({ id: 'b', bin: 'b', check: 'b', minVersion: '1.0.0' })).resolves.toMatchObject({
      installed: false,
    });
  });

  it('真实执行 node -e 假 check（集成冒烟：版本满足 minVersion）', async () => {
    const s = await stateOf({
      id: 'fake',
      bin: 'node',
      check: `node -e "console.log('v22.5.0')"`,
      minVersion: '20.0.0',
    });
    expect(s.installed).toBe(true);
    expect(s.version).toBe('22.5.0');
  }, 20_000);

  it('真实执行 node -e 假 check（集成冒烟：版本低于 minVersion 视为未装）', async () => {
    const s = await stateOf({
      id: 'fake',
      bin: 'node',
      check: `node -e "console.log('v9.9.9')"`,
      minVersion: '20.0.0',
    });
    expect(s.installed).toBe(false);
  }, 20_000);
});
