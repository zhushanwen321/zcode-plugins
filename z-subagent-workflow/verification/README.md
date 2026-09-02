# verification 资产（不入 npm 包）

收口交付的真实场景验收脚本与收口前行为基线，供回溯复现（设计 zsw-socket-record-convergence-design.md §4 场景 A5-A8/P-mount）。

- gen-fixture.js / acceptance.js：record compact 真实验收（acceptance.js 顶部插件路径为录制环境绝对路径，重跑时按需调整）
- make-legacy-state-files.js：从 test/fixtures/ 迁入——node --test 无参形态会把 test/ 树内全部 .js 当测试执行（既有误扫，一致性审查区 C 发现），fixture 生成器移出扫描面
- 行为基线（CLI 双路径 + 帧级）在 ../test/fixtures/baseline/*.txt（.txt 不在 node --test 扫描面）
