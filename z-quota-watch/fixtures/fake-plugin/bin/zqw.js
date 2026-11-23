#!/usr/bin/env node
// 门控测试夹具：替换真 zqw.js 的位置，被 sh 门控 exec 时写 marker 并输出空 JSON。
'use strict';
const fs = require('fs');
const out = process.env.ZQW_TEST_MARKER || '/tmp/zqw-gate-test-marker';
fs.writeFileSync(out, String(Date.now()) + '\n');
process.stdout.write('{}\n');
