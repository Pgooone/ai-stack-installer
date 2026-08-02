# 批次 2：流程模块（含单测）

- [ ] src/prereq.ts：ensurePrereqs（node≥20 检查/fnm/winget+PATH 刷新，git/pwsh），失败不中断
- [ ] src/agents.ts：installAgent（已装跳过/主通道/fallback 降级/失败记录）/uninstallAgent
- [ ] src/configure.ts：writeConfigFiles（不存在才写）/writeAliasBlock（标记块幂等）/collectFileReport
- [ ] src/doctor.ts：runDoctor（结果表+修复建议+退出码）
- [ ] 门禁：npm test 全绿 + tsc 无错 + lint 无错
