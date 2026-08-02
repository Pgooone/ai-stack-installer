# AI Stack Installer — 概要设计（模块划分）

> 详细设计见 docs/detailed-design.md；需求见 docs/proposal.md

## 模块职责表

| 模块 | 职责 |
|------|------|
| `src/types.ts` | 共享类型定义（ToolSpec / DetectInfo / InstallResult 等） |
| `src/manifest.ts` | 加载、校验 manifest.json，提供工具查询（按 id / 平台取命令） |
| `src/detect.ts` | 探测 OS / 架构 / WSL / 已有工具与版本（check 命令） |
| `src/prereq.ts` | 安装前置依赖：Node（fnm/winget）、Git、PowerShell 7（仅 Windows） |
| `src/agents.ts` | 按 manifest 执行安装（主通道 → fallback 降级）、卸载单个工具 |
| `src/configure.ts` | 幂等写入配置：settings.json 模板、alias 标记块、proxy 函数 |
| `src/proxy.ts` | cn 模式：检测本地代理端口、切换 npm registry、设置代理环境变量 |
| `src/doctor.ts` | 逐个 check 工具，输出结果表（✓/✗ + 版本 + 修复建议），返回退出码 |
| `src/tui.ts` | @clack/prompts 交互向导：多选/确认/失败三选一/报告 |
| `src/cli.ts` | 子命令入口：install / doctor / uninstall / list；参数解析；TTY 检测与模式选择 |
| `src/uninstall.ts` | 卸载流程：逐工具卸载 + 配置清理 + 文件位置清单 |
| `src/logger.ts` | 日志：彩色输出 + ~/.ai-stack/install.log 追加 |
| `src/utils.ts` | 通用工具：has(command)、retry、spawn 封装、版本比较 |
| `src/fs-locations.ts` | 路径常量：~/.ai-stack、配置文件路径、rc 文件路径（按平台） |
| 入口 `install.sh` / `install.ps1` | 薄入口：探测/安装 Node → 拉起 `npx -y ai-stack-installer` 并透传参数 |

## 依赖关系（实现顺序依据）

```
types / utils / logger / fs-locations   （无依赖，最底层）
        ↓
manifest / detect / proxy               （依赖底层）
        ↓
prereq / agents / configure / doctor    （依赖上面）
        ↓
tui / uninstall                         （依赖流程模块）
        ↓
cli                                     （依赖所有，最顶层）
        ↓
install.sh / install.ps1                （薄入口，最后）
```

## 关键设计点（来自已批准设计文档）

- manifest 驱动：工具数据唯一事实来源，`needsProxy` / `npmMirror` / `optIn` 字段
- 交互策略：TTY → 向导；无 TTY → 自动直装；`-y` 强制直装；`-i` 强制向导
- 6 步向导：工具多选 → 网络 → CC Switch → 汇总 → 执行 → 报告
- cn 模式：npm registry 切 npmmirror；代理 127.0.0.1:7890（可配）；检测常见代理端口
- 配置轻量幂等：settings.json 不存在才写；rc 标记块包裹；密钥不落地
- 透明性：报告输出文件位置清单
- 平台验证：Windows 真机 + WSL 验 Linux，macOS 待 CI
