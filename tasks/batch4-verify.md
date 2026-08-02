# 批次 4：本地验证 + 收尾

- [x] Windows 真机：install.ps1 直装（-y）实测（node 已装场景）
- [x] Windows 真机：交互向导实测（工具多选/网络/CC Switch/汇总/执行/报告）
- [x] Windows 真机：doctor / list 实测（退出码回归 0）；uninstall 仅验证拒绝路径（执行路径靠单测，避免真实卸载风险）
- [x] WSL：install.sh 实测（agent 队员执行：全链路/幂等/降级/向导 TTY 渲染）
- [x] README.md：两条命令 + 文件位置透明性 + WSL 提示
- [x] .gitignore / LICENSE（MIT）
- [x] npm pack 验证发布物完整（manifest.json/config 打包进包）
- [x] 门禁全绿（177 用例）+ progress.md 全勾选
- [x] 验证发现修复：doctor 平台过滤 / exec 超时 / pi 主通道 npm / installed.json 累计合并 / 文案 / fnm 降级链
- [x] WSL 测试产物已清理（pi/claude npm 全局、config.toml、bashrc 标记块、~/.ai-stack）
