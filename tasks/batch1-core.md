# 批次 1：底层模块（含单测）

- [ ] src/types.ts：Platform/DetectInfo/ToolSpec/Manifest/ToolState/InstallStatus
- [ ] src/utils.ts：has/exec（跨平台包装）/retry/versionGte/detectTty
- [ ] src/logger.ts：log/ok/fail + ~/.ai-stack/install.log 追加
- [ ] src/fs-locations.ts：aiStackDir/logFile/rcFiles/configFiles/markers/npxCacheDir（home 可注入）
- [ ] src/manifest.ts：loadManifest/validateManifest/getAgent/installCmd（cn 镜像注入）/stateOf
- [ ] src/detect.ts：detect（platform/arch/isWsl）/detectNode（≥20）/detectTools
- [ ] src/proxy.ts：detectLocalProxy（7890/7897/10809 探测）/applyCnMode/npmRegistryFor
- [ ] 门禁：npm test 全绿 + tsc 无错 + lint 无错
