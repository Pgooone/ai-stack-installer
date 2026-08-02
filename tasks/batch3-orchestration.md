# 批次 3：编排与入口

- [ ] src/tui.ts：runWizard 6 步（多选/网络/CC Switch/汇总/执行/报告）+ 失败三选一
- [ ] src/uninstall.ts：runUninstall（确认/逐工具卸载/只删 installed.json 清单/删 ~/.ai-stack/位置清单）
- [ ] src/cli.ts：参数解析/模式选择（TTY/-y/-i）/install/doctor/uninstall/list/main 错误处理
- [ ] install.sh：薄入口（node≥20 检查/fnm/npx 拉起/参数透传/透明性提示）
- [ ] install.ps1：薄入口（UTF8/winget Node+PATH 刷新/npx 拉起/参数透传）
- [ ] manifest.json：prereq + 4 agents + optIn cc-switch（字段按详细设计）
- [ ] config/ 模板：claude.settings.json / codex.config.toml
- [ ] 门禁：npm test 全绿 + tsc 无错 + lint 无错
