# 实机验收 case

命令均以 `main/scripts/patch-zcode-app/` 为 cwd 执行(acceptance 探针脚本随交付物
入库,位于 test/e2e/)。真实 LLM 调用仅 T9 一次(最小 prompt,共享宿主凭据)。

| 编号 | 场景 | 命令 | 预期 | 关联 |
|---|---|---|---|---|
| T1 | provider-sem 注入:对真实 ZCode.app apply 后 status 识别已应用 | node patch-zcode-app.js apply --patch provider-sem && node patch-zcode-app.js status | exit:0;contains:[x] provider-sem — 已应用 | trunk |
| T2 | 信号量语义:12 个真实并发 admit,上限 10,FIFO 依序放行 | node test/e2e/sem-concurrency.e2e.js | exit:0;contains:peak=10;contains:fifo=ok | trunk |
| T2c | 排队中 abort:第 11、12 个等待者被取消后,前 10 个 release 时不向已取消者放行(名额不泄漏) | node test/e2e/sem-abort.e2e.js | exit:0;contains:cancelled=2;contains:leak=0 | abort-cancel |
| T3 | patch 后 zcode 可启动 + fail-open:注入后的 zcode.cjs 以 `--help` 冒烟(zsem symlink 缺位时注入行 catch 生效,zcode 正常运行) | node test/e2e/zcode-smoke.e2e.js | exit:0;contains:smoke=ok;contains:fail-open=ok | trunk |
| T4 | 观测面:zsem status CLI 读日志输出在途统计 | node zsem/bin/zsem.js status --log ~/.zcode/cli/zsem-log.jsonl | exit:0;contains:providers= | zsem-observe |
| T5 | install 幂等:symlink 重复创建不报错且指向本仓源码 | node patch-zcode-app.js install && node patch-zcode-app.js install && readlink ~/.zcode/cli/zsem | exit:0;contains:scripts/patch-zcode-app/zsem | trunk |
| T6 | 回滚:restore 后 zcode.cjs 恢复基线,status 显示未应用 | node patch-zcode-app.js restore && node patch-zcode-app.js status | exit:0;contains:provider-sem — 未应用 | upgrade-sim |
| T8 | 升级模拟:restore(模拟升级覆盖)→ apply 重打成功且幂等(二次 apply 全 skip) | node test/e2e/upgrade-reapply.e2e.js | exit:0;contains:reapply=ok;contains:idempotent=ok | upgrade-sim |
| T9 | 真实端到端:spawn 真实 zcode.cjs app-server 起会话发一轮最小真实请求,zsem 日志出现该 provider 的 acquire/grant/release | node test/e2e/real-llm.e2e.js | exit:0;contains:grant=1;contains:release=1 | trunk |

<!--
覆盖说明:
- T1/T6/T8 覆盖 G5(统一框架与升级重打);T3/T7(fail-open 并入 T3)覆盖 G6。
- T9 是唯一真实 LLM 调用 case(app-server NDJSON 协议,共享宿主 HOME 凭据)。
- 「真实多窗口跨进程总量」属显式不做(daemon 化二期),无 case,见 design.md。
-->
