# AI Stack Installer — 需求文档

> 从已批准设计沉淀（docs/superpowers/specs/2026-08-02-ai-stack-installer-design.md）

## 项目概述

- **目标**：一条命令在 Windows / Linux（含 WSL）/ macOS 上安装「AI Agent 开发工具链」：
  探测环境 → 装依赖（Node/Git/PowerShell 7）→ 装 Agent（Claude Code / Codex / Pi / OpenCode）
  → 注入轻量配置 → doctor 自检报告。可重复执行（幂等）、可校验、可卸载。
- **性质**：公开分发项目（GitHub 公开仓库 + npm 发布），社区贡献友好。
- **技术栈**：Node.js + TypeScript 核心（CLI 包 `ai-stack-installer`，bin: `ai-stack`），
  薄入口 `install.sh`（POSIX sh）+ `install.ps1`（PowerShell 5.1+），交互 UI 用 `@clack/prompts`，
  测试用 vitest。**架构决策：清单驱动（manifest.json 为工具数据唯一事实来源）**。

## 功能需求

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-1 | 一条命令安装 | `bash install.sh` / `.\install.ps1` 完成全套安装 |
| FR-2 | 交互向导 | TTY 下 6 步向导：工具多选 → 网络确认 → CC Switch 询问 → 汇总确认 → 执行 → 报告 |
| FR-3 | 非交互直装 | `-y` 跳过向导；无 TTY（管道/CI）自动直装 |
| FR-4 | 幂等可重复 | 已装的跳过，不重复追加 rc 文件，重复执行无副作用 |
| FR-5 | 安装降级 | 官方安装器失败自动降级 npm（fallback） |
| FR-6 | cn 模式 | npm 镜像 + 代理开关；`needsProxy`/`npmMirror` 标记区分必须代理/可走镜像 |
| FR-7 | 配置注入（轻量） | settings.json 模板（不存在才写）、alias 标记块（幂等）、proxy_on/off 函数 |
| FR-8 | doctor 自检 | 逐个 check，输出结果表 + 修复建议，退出码反映失败 |
| FR-9 | uninstall 卸载 | 按 manifest 卸载 + 清理脚本写入的配置 + 文件位置清单明示 |
| FR-10 | list 清单 | 打印工具清单与安装状态 |
| FR-11 | 文件透明性 | 安装/卸载报告明示每个写入文件的位置与删除方式 |

## 非功能需求

- **NFR-1**：核心逻辑一份代码全平台（仅 manifest 命令按平台分列）
- **NFR-2**：每个模块有 vitest 单测；CI 矩阵（ubuntu/windows/macos）全新建环境实测
- **NFR-3**：TS 类型检查 + lint 全绿
- **NFR-4**：支持 Node ≥ 20
- **NFR-5**：密钥不落地——各 Agent 登录由用户自行完成，脚本不写密钥

## 明确不做（第一版）

- 版本锁（`claude@x.y.z`）— 后续迭代
- MCP 配置模板注入 — 后续迭代
- Dockerfile / devcontainer — 后续迭代
- 交互式密钥询问 — 明确不做
- macOS 本地验证（无环境，靠 CI）
