# 批次 3：编排与入口

- [x] src/tui.ts：runWizard 6 步（多选/网络/CC Switch/汇总/执行/报告）+ 失败三选一
- [x] src/uninstall.ts：runUninstall（确认/逐工具卸载/只删 installed.json 清单/删 ~/.ai-stack/位置清单）
- [x] src/cli.ts：参数解析/模式选择（TTY/-y/-i）/install/doctor/uninstall/list/main 错误处理
- [x] install.sh：薄入口（node≥20 检查/fnm/npx 拉起/参数透传/透明性提示）
- [x] install.ps1：薄入口（UTF8+ BOM/winget Node+PATH 刷新/npx 拉起/参数透传）
- [x] manifest.json：prereq + 4 agents + optIn cc-switch（字段按详细设计）
- [x] config/ 模板：claude.settings.json / codex.config.toml（批次 0 已建）
- [x] 门禁：npm test 全绿 + tsc 无错 + lint 无错
- [x] 附加：installed.json 记录模块（src/installed.ts）；修复 utils.exec 的 unref 导致真实 CLI 挂起 bug；tsconfig 排除 *.test.ts 使 dist 打包干净
