# 原任务输入保护：G03 的独立前提

日期：2026-10-26。基准为 `a79c7ba0`。本次只落实原任务身份不可覆盖的既有要求；补料另行报价采用 B，具体计价公式仍待确定。同任务新输入采用、执行版本和补料续做仍未实现，G03 保持开放。

## 改动与边界

[新增迁移 0117](../../../../db/migrations/0117_run_origin_input_immutable.sql)为 `bb_runs` 增加数据库保护：已有行的业务 run ID、用户、项目、原输入 revision/hash、原执行请求 ID 和 request hash 不得替换。相同值更新以及正常状态、阶段、积分和成果更新仍允许。这确保后续采用补料只能追加执行版本，不能直接覆盖原任务依据。

既有输入快照仍不可变。本迁移不重写历史数据，不提供新的采用入口、费率或活动执行版本；SQL 初次插入的异常历史记录仍由既有恢复校验拒绝，不以本次保护冒充完整执行准入验证。

两处旧负例曾通过更新 run hash 制造异常，现改为直接插入明确标注的合成历史异常记录。队列负例保留事件/outbox 与暂停状态；复核负例保留准确输入快照和合成模型结果，仍验证恢复被拒绝且证据不变。未禁用任何触发器，也未删除这些拒绝断言。

## 实际验证

使用 Windows、Node 24.22.1、PostgreSQL 16.14。专用本机集群仅监听 `127.0.0.1:15526`；测试使用已迁移空模板的独立克隆，完成后清理克隆。本轮无真实模型、支付或外部 Blob 调用；文件证据使用合成字节与内存存储。源码哈希与隔离库检查见 [sources.json](sources.json)。

验收后已确认没有剩余测试克隆、模板没有业务 run，随后停止专用数据库。存档日志仅规范化行末空白，原始输出保留于本机 `.local/g03-*.log`。

| 证据 | 结果 | 证明范围 |
| --- | --- | --- |
| [旧数据库红例](red.log) | 0 pass / 9 fail，预期失败 | 迁移至 0116 的旧库缺少原身份保护；部分替换被旧外键拒绝，部分更新可执行。此计数包含父测试，不等于九个独立产品缺陷 |
| [应用迁移](migration.log) | 0117 成功 | 只向隔离模板新增保护，不修改已部署迁移 |
| [最终回归](green-final.log) | **34 pass / 0 fail / 1 skip**，84.53 秒 | 新保护、原请求重放、原检查点恢复、历史异常恢复及编制/M4/复核动态积分兼容性 |
| [API 构建](api-build.log)、[worker 构建](worker-build.log) | 均通过 | 当前源码与新增/调整测试均可编译 |

新保护用例共 9 个 Node 测试项（父测试和八个子测试），分别拒绝七项身份替换及同项目有效后继输入的 revision/hash 组合。每次拒绝后核对任务、job/检查点、调用记录、事件和 outbox 不变；随后验证同值更新、原 execute 重放、暂停后继续和正常终态结算。

最终 34 个 pass 包含上述父/子测试，不用于计算场景覆盖率。唯一 skip 是 `queue.test.ts` 中依赖真实 Azurite 的既有整条队列/交付测试；本轮没有配置该连接，不宣称通过这条测试。另一个队列恢复用例实际执行通过。

首次迁移后回归为 33 pass / 1 fail / 1 skip，见 [first-green.log](first-green.log)：复核测试依赖现有任务控制开关，环境清理时未设置，暂停 API 返回 `CAPABILITY_NOT_READY`。补齐 `BB_RUN_RUNTIME_ENABLED=1` 后重跑全部同组选集，原断言不变；采用最终日志，首次结果保留。

从仓库根目录构建并运行以下选集，`BB_TEST_DATABASE_URL` 必须指向已应用 0117、可创建隔离克隆的专用测试模板：

```powershell
npm run build --workspace @bondbuddy/api
npm run build --workspace @bondbuddy/worker
$env:BB_TEST_DATABASE_URL='<isolated migrated test template URL>'
$env:BB_RUN_RUNTIME_ENABLED='1'
node --test --test-concurrency=1 apps/api/dist/run-origin-immutability.pg.test.js apps/api/dist/queue.test.js apps/worker/dist/authoring-pause.pg.test.js apps/worker/dist/review-reassembly.test.js apps/api/dist/authoring-dynamic-balance.pg.test.js apps/api/dist/review-dynamic-balance.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js
```

本轮没有重跑既有 662 项浏览器基线或上一轮 11 项桌面修复。上述数据库证据不与它们相加，也不证明已支持新材料进入同一 run。执行版本、准确新输入/成果绑定、追加报价确认与账务、三类业务补料处理及桌面连续旅程仍按[完整实施提案](../../../ux/pause-supplement-resume-20261026.md)推进。没有推送或部署。
