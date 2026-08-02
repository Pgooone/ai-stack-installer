# 批次 0：项目脚手架

- [ ] package.json：name=ai-stack-installer、bin=ai-stack、type=module、engines.node>=20、scripts（build/test/lint/typecheck）
- [ ] tsconfig.json：strict、ES2022、outDir=dist、declaration
- [ ] vitest 配置（vitest.config.ts，覆盖 src/**/*.test.ts）
- [ ] eslint 配置（typescript-eslint recommended）
- [ ] 安装依赖：typescript / vitest / @clack/prompts / eslint 等
- [ ] 门禁验证：`npm run build && npm test`（空测试可过）
