import { describe, expect, expectTypeOf, it } from 'vitest';
import type { DetectInfo, InstallStatus, Manifest, Platform, ToolSpec, ToolState } from './types.js';

describe('types（编译期形状 + 运行时枚举）', () => {
  it('Platform 仅包含三种平台值', () => {
    const platforms: Platform[] = ['windows', 'linux', 'macos'];
    expect(platforms).toHaveLength(3);
    expect(platforms).toContain('linux');
  });

  it('InstallStatus 包含四种状态', () => {
    const statuses: InstallStatus[] = ['ok', 'skipped', 'failed', 'missing'];
    expect(statuses).toHaveLength(4);
  });

  it('DetectInfo 结构完整', () => {
    expectTypeOf<DetectInfo>().toEqualTypeOf<{
      platform: Platform;
      isWsl: boolean;
      arch: string;
      home: string;
    }>();
  });

  it('ToolSpec 核心字段类型正确', () => {
    expectTypeOf<ToolSpec>().toHaveProperty('id').toEqualTypeOf<string>();
    expectTypeOf<ToolSpec>().toHaveProperty('bin').toEqualTypeOf<string>();
    expectTypeOf<ToolSpec>().toHaveProperty('check').toEqualTypeOf<string>();
    expectTypeOf<ToolSpec>().toHaveProperty('minVersion').toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('needsProxy').toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('npmMirror').toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('optIn').toEqualTypeOf<boolean | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('linux').toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('macos').toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('windows').toEqualTypeOf<string | undefined>();
    expectTypeOf<ToolSpec>().toHaveProperty('fallback').toEqualTypeOf<string | undefined>();
  });

  it('Manifest 由 prereq 与 agents 组成', () => {
    expectTypeOf<Manifest>().toHaveProperty('prereq').toEqualTypeOf<ToolSpec[]>();
    expectTypeOf<Manifest>().toHaveProperty('agents').toEqualTypeOf<ToolSpec[]>();
  });

  it('ToolState：installed 必选，version 可选', () => {
    expectTypeOf<ToolState>().toHaveProperty('installed').toEqualTypeOf<boolean>();
    expectTypeOf<ToolState>().toHaveProperty('version').toEqualTypeOf<string | undefined>();
  });
});
