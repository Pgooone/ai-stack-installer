#!/usr/bin/env node
// npm bin 入口（package.json bin → dist/bin.js）
//
// 背景：npx 通过 _npx/<hash>/node_modules/.bin/ai-stack 软链（或 shim）调用本文件，
// 此时 cli.js 底部的 argv 自检（argv[1] === import.meta.url）不成立（argv[1] 是软链路径），
// main 不会执行。因此 bin 必须指向本文件，无条件调用 main；
// cli.js 底部自检仅供 `node dist/cli.js` 直跑与测试 import 使用。
import { main } from './cli.js';

process.exitCode = await main();
