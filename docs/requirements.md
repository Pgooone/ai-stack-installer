# AI Stack Installer — 原始需求文档（由最终实现与修复历史反推）

> 本文档从 45 个提交的实现与修复中反推原始需求，可直接作为需求基线使用。
> 每项需求标注了对应的最终实现与验证方式。

## 一、项目概述

- **目标**：一条命令在 **Windows / Linux（含 WSL）/ macOS** 上安装「AI Agent 开发工具链」——Claude Code、Codex、Pi、OpenCode 四件套 + 可选 CC Switch——同时完成依赖安装、轻量配置注入、自检报告、系统组件维护与卸载。
- **使用场景**：公开分发项目（GitHub 公开仓库 + npm 发布），主要受众在国内（国内网络适配是刚需）。
- **技术栈**：Node.js + TypeScript 核心 CLI（npm 包 `ai-stack-installer`，bin `ai-stack`）；薄入口 `install.sh`（POSIX sh）+ `install.ps1`（PowerShell 5.1+）；交互 UI `@clack/prompts`；测试 vitest；CI GitHub Actions 三平台矩阵。

## 二、功能需求

### A. 安装

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-1 | **一条命令完成安装**：curl 下载入口脚本 → 本地运行 → 完成全套安装 | 双薄入口 + npx 拉核心包；README 快速开始 |
| FR-2 | **交互向导**：功能选择（安装 Agent / 更新系统组件 / 全部执行）→ 工具多选（已装置灰）→ 网络确认 → CC Switch 询问 → 汇总确认 → 执行（失败可重试/跳过/终止）→ 报告 | tui.ts 向导流程 |
| FR-3 | **非交互直装**：`-y` 跳过向导；管道/CI 环境自动直装 | TTY 检测 + 模式选择 |
| FR-4 | **幂等可重复**：已装工具跳过、配置不重复写入、rc 标记块不重复追加 | installAgent 状态检查 + 标记块幂等 |
| FR-5 | **安装降级链**：官方安装器失败自动降级 npm（fallback） | agents.ts 主通道 → fallback |
| FR-6 | **失败不中断**：单个工具失败记录后继续，最后统一汇报 | prereq/agents 失败汇总 |

### B. 系统组件维护

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-7 | **系统组件安装与更新**：Node / Git / PowerShell 7 三件套 | update 子命令 + prereq |
| FR-8 | **更新先检测再选择**：交互模式检测可用更新（有更新/已最新/无法检测），多选后只更新选中项 | detectUpdates + multiselect |
| FR-9 | **已最新不下载**：检测到已最新时跳过下载（避免无谓下载大体积安装包） | updatePrereqs 预检 |
| FR-10 | **未安装状态准确识别**：未安装 ≠ 已最新（winget dry-run 对未装包与无更新返回相同退出码，需先判安装态） | detectUpdates 安装态优先判断 |
| FR-11 | **pwsh 用官方 MSI 安装**（而非 winget）：GitHub Releases 下载 + msiexec，含完整终端集成（右键菜单等） | manifest MSI 命令链，winget 仅作降级 |
| FR-12 | **交互模式呼出 MSI 安装向导**：用户可勾选完整选项；非交互/CI 静默安装 | AI_STACK_INTERACTIVE 环境变量控制 /quiet |

### C. PowerShell 7 集成

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-13 | **系统 PATH 优先**：pwsh 路径提升到**系统 PATH 首位**（Windows 解析顺序系统在前，仅提升用户 PATH 无效）；无管理员权限时降级用户 PATH 并提示 | promotePwshInPath（Machine 级） |
| FR-14 | **Windows Terminal 默认 PowerShell 7**：读取 WT profiles 列表识别真实 pwsh profile 的 GUID 并设为 defaultProfile；**不添加与内置动态 profile 冲突的静态 profile**；历史误加残留自动清理 | setTerminalDefault + findPwshProfileGuid + removeStaticPwshProfile |
| FR-15 | **pwsh profile 写入 UTF-8**：防中文乱码 | configure 标记块 UTF-8 段 |

### D. 网络适配（国内）

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-16 | **代理检测与询问**：按优先级检测环境变量代理 → Windows 系统代理（注册表）→ 本地常见端口（7890/7897/10809）；检测到后询问是否使用 | detectProxy |
| FR-17 | **窗口内设置代理**：使用代理时仅注入当前会话 env（HTTP_PROXY/HTTPS_PROXY），不永久改系统设置；被墙的官方安装器（claude.ai/chatgpt.com/GitHub Releases）可走通 | applyCnMode env 注入 |
| FR-18 | **代理与镜像独立**：镜像（npmmirror）与代理可分别选择（仅代理 / 代理+镜像 / 仅镜像 / 直连） | CnMode 拆分 proxy/mirror |
| FR-19 | **入口脚本镜像自动选择**：无代理时探测 npmjs.org 可达性，不可达自动用 npmmirror 拉核心包；官方源失败自动镜像重试 | 入口脚本 pick_registry + 重试 |
| FR-20 | **被墙工具如实报告**：需要代理才能装的工具（needsProxy）失败时给出明确提示与建议 | doctor 建议 + 失败提示 |

### E. 卸载安全

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-21 | **只卸脚本安装的工具**：installed.json 记录本脚本实际安装的工具 id，用户原有的绝不卸载 | installed.json v2 tools 字段 |
| FR-22 | **只删未修改的文件**：记录写入时 SHA-256，卸载前重新计算——被用户改过的文件保留并警告 | installed.json v2 hash 字段 |
| FR-23 | **旧记录保守处理**：无工具归属/hash 的旧记录 → 不卸工具、不删文件，提示刷新记录 | v1 兼容逻辑 |
| FR-24 | **破坏性操作默认确认**：uninstall 交互确认（默认拒绝），非 TTY 无 -y 拒绝执行 | runUninstall 确认门 |

### F. 配置注入（轻量）

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-25 | **配置模板不存在才写**：不覆盖用户已有配置（settings.json / config.toml） | writeConfigFiles |
| FR-26 | **Shell 别名/代理函数**：标记块包裹、幂等追加、可移除 | writeAliasBlock / removeAliasBlock |
| FR-27 | **密钥不落地**：各 Agent 登录由用户自行完成，脚本不写密钥 | 设计明确不做 |

### G. 自检与透明性

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-28 | **doctor 自检**：结果表（工具/版本/状态）+ 修复建议 + 退出码；平台不适用项（Linux 上的 pwsh）不误计失败 | runDoctor 平台过滤 |
| FR-29 | **list 清单**：工具清单与安装状态；optIn 工具未装不计失败 | runList |
| FR-30 | **文件位置透明**：安装/卸载报告输出每个写入文件的位置与删除方式 | printFileReport / collectFileReport |
| FR-31 | **脚本自身可清理**：执行完毕自动删除入口脚本（AI_STACK_KEEP=1 保留） | 入口脚本尾部清理 |

### H. 版本与升级

| 编号 | 需求 | 最终实现与佐证 |
|---|---|---|
| FR-32 | **每次执行显示版本号**：一眼识别是否命中旧缓存 | cli 启动版本行 |
| FR-33 | **运行时检查新版本**：发现新版提示升级（网络异常静默，AI_STACK_SKIP_UPDATE_CHECK=1 跳过） | checkForUpdate |
| FR-34 | **self-update 强制刷新**：清 npx 缓存 + 全局安装 @latest | runSelfUpdate |
| FR-35 | **执行完毕自动清理 npx 缓存**：下次必然拉取最新版 | cleanupNpxCache |
| FR-36 | **入口脚本强制 @latest**：npx/npm i -g 全部显式 @latest（避免 npx 缓存命中旧版） | install.sh/install.ps1 9 处命令 |

## 三、非功能需求

| 编号 | 需求 | 佐证 |
|---|---|---|
| NFR-1 | **跨平台一致性**：双入口脚本逻辑对齐（registry 选择/镜像重试/自清理/@latest 等） | install.sh 与 install.ps1 逐项对照 |
| NFR-2 | **发布质量**：CI 三平台矩阵（ubuntu/windows/macos）单测 + 门禁 + 真实冒烟安装 | GitHub Actions |
| NFR-3 | **自动化友好**：非交互模式、退出码语义（有未就绪=1）、TTY 检测 | cli 模式选择 |
| NFR-4 | **不破坏用户环境**：不覆盖已有配置、不误删用户数据、不误卸用户工具、不影响已装 Agent | 幂等 + 卸载安全 + 已装跳过 |
| NFR-5 | **国内网络可用**：镜像自动选择、代理独立询问、被墙工具如实报告 | cn 模式全家桶 |
| NFR-6 | **可维护性**：manifest 驱动（工具数据与逻辑分离）、模块化、228 用例单测 | 架构 + 测试 |
| NFR-7 | **可回退**：细粒度提交（每卡一提交）+ 语义化版本 + git tag | 45 提交历史 |

## 四、明确不做（当前版本）

- 版本锁（`claude@x.y.z` 固定版本安装）——后续迭代
- MCP 配置模板注入——后续迭代
- Dockerfile / devcontainer——后续迭代
- 交互式密钥询问——明确不做（用户自行登录）
- macOS 本地验证（无环境，靠 CI）

## 五、需求 → 用户反馈溯源（附）

每轮用户反馈对应的需求编号（用于追溯原始诉求）：

| 用户反馈/诉求 | 需求 |
|---|---|
| 一条命令装好工具链 | FR-1~FR-6 |
| 卸载会删用户原有配置/程序导致崩溃 | FR-21~FR-24 |
| node/pwsh 更新应检测后让用户选择 | FR-8~FR-10 |
| pwsh 更新完必须提升环境变量到第一（用户 PATH 无效，必须系统 PATH） | FR-13 |
| 终端设置默认使用 PowerShell 7 | FR-14 |
| 检测用户代理 → 询问 → 窗口内设置 | FR-16~FR-17 |
| 不启用代理连安装脚本都做不到 → 用国内镜像 | FR-19 |
| 每次使用显示版本号；自动清理脚本和缓存 | FR-32, FR-35 |
| 升级强制刷新缓存，不会运行老版本 | FR-34, FR-36 |
| pwsh 未装显示"未知·已最新"且安装失败 | FR-10 |
| pwsh 不能用 winget，要用 .msi | FR-11 |
| 脚本无法呼出 MSI 安装界面 | FR-12 |
| 已最新则不下载，检测系统 PATH 最优先、WT 默认 pwsh7 | FR-9, FR-13, FR-14 |
| WT 报「多个相同 GUID」 | FR-14（不添加冲突 profile） |
| 重下还是老版本（npx 无 @latest） | FR-36 |
