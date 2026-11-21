# 中期超时修复验收记录

本轮实现已审阅 F01–F10，提交 PR 到 develop；合入和部署另记。现有 PostgreSQL 主任务、供应商 journal、租约、账户账务及全文 Word 质量门继续承担权威状态。新协议默认关闭。

## 实现与源码依据

| Fix | 最终行为与入口 | 主要验证 |
| --- | --- | --- |
| F01 | `apps/worker/src/workflow-authoring-stage.ts:72`、`apps/api/src/queue.ts:285`：固定章节/批次，真实 completed 结果与远端对象验证后提交游标，预算累计 | 章节上传/回读/游标首次故障；已提交章重放；unknown不发；跨上下文预算 |
| F02 | `apps/worker/src/workflow-input.ts:44`：输入、解析/OCR结果和覆盖纳入私有hash快照，缓存命中不再次解析 | 实际缓存入口不进入DB/OCR；材料、coverage及对象hash改变拒绝 |
| F03 | `python/bondbuddy_file_authoring/fixed_edit.py:1120`：请求hash、幂等receipt、旧版本拒绝、独占锁与单manifest提交 | 两个真实进程竞争、提交点中断、长稿/授权原稿结构、分页及修订 |
| F04 | `apps/worker/src/durable-spool.ts:82`、`apps/worker/src/task-execution.ts:80`：call空证明后fsync接管；有界补传与公平退避，未接管不清唯一责任 | 真正子进程强杀/join；8个真实fsync故障；ACK/holder/登记/partial GC失败 |
| F05 | `apps/api/src/queue.ts:309`：同job移交，保留旧token责任至正向释放，新token领取收尾 | 原生handoff、错误proof拒绝、正常移交不计失败、同job跨session资源阻塞 |
| F06 | `apps/api/src/execution-capacity.ts:377`、`0199_workflow_phase_capacity.sql`：phase占槽、SQL准入及预算revision一致 | 原token仍占原phase；旧SQL/角色不能绕过；第3台须预算审批、第4台拒绝 |
| F07 | `apps/api/src/queue.ts:426`、`:1527`：五类恢复共用安全门；四类暂停keyset+持久due；缺条件不重发 | 五原因对象/输入/游标/身份篡改拒绝；20阻塞/21就绪；单项异常、新暂停及迟到CAS |
| F08 | `python/bondbuddy_word_delivery/unified.py:125`：可信整篇组装后执行原质量、私有下载及账务门 | 真实Python Word、两成果提升后崩溃接续、readback/hash、单次60积分结算 |
| F09 | `apps/worker/src/workflow-observability.ts:63`：原call/session、章节、捕获/上传/提交/移交和告警可关联 | 实际IO child被杀后保留completed/active区别；父子区间不相加；缺失unknown |
| F10 | `db/migrations/0200_database_restore_quarantine.sql:2`及`0201_workflow_observability_alerts.sql`：追加迁移、最小权限和恢复隔离 | 必要权限逐项撤销、普通consumer恢复拒绝、真实迁移中断/重放与pg_dump/pg_restore |

详细开启、排空和回滚顺序见 [backend-timeout-workflow.md](../backend-timeout-workflow.md) 与双端部署 runbook。每次调用上限初值20分钟、修补最多2个revision且run累计5分钟；原run累计deadline不变。补传单次120秒、每轮最多3条且累计5分钟。所有初值均须真实金样校准，不是任务总完成时长承诺。

## 同一源码验证

全仓 `npm run build`、`npm run check:contracts` 均通过。下面 21 个定向组累计 **1807 次测试执行，0 fail、0 skip**；这是测试执行计数，含嵌套subtest，不是不同业务案例或真实模型调用数。原生runner按其实际Node TAP计数，未把Python包装器重复累加。

| 分组 | pass | fail | skip | 原始日志 | SHA256 |
| --- | ---: | ---: | ---: | --- | --- |
| python-fixed-edit | 90 | 0 | 0 | `python-fixed-edit.log` | `4ce173b4356fc026ccc3d62ac269083d19297180998e815a7dd72b88e56f87e0` |
| python-unified-word | 13 | 0 | 0 | `python-unified-word.log` | `0af552fb8b9b60bd7ff754964ed72983db3b013c31bd32e1aa99e9472171017a` |
| python-workflow-nodes | 2 | 0 | 0 | `python-workflow-nodes.log` | `0bcb5240c873fdd95a8d117cd59ade3d28ac21734330b9d0e9235e78804b7993` |
| renderer-protocol | 8 | 0 | 0 | `renderer-protocol.log` | `a59406e0e374d3e17e2440e30ece999c73e509ea43188eb9bed916ba9ee60ba2` |
| python-renderer | 7 | 0 | 0 | `python-renderer.log` | `4912f286c563d740ea8d360e599ae6f466e609d7eba7e2438e66d2f8f0600926` |
| B01-isolated | 7 | 0 | 0 | `B01-isolated.log` | `ca73971d1fe52d2608ef5eac3ca940be7e5350a441f05ed276a6ab785c6aacaf` |
| B02-B03-spool | 127 | 0 | 0 | `native-spool-node.log` | `387e9bfa7d8dc9241119d0a465bfe77a1326af7bddffd3ecdcf953b842790de7` |
| new-workflow | 42 | 0 | 0 | `new-workflow.log` | `9838f5be2ada3b097b0cc08518f8ac21dab53137492dfe4834c9961bb669d1be` |
| new-contracts | 3 | 0 | 0 | `new-contracts.log` | `34920c90dba24e66f66fe39e94a24e9823276ce5fb5dbf5961d388db25b22238` |
| performance-trace | 10 | 0 | 0 | `performance-trace.log` | `2edb9955e477c825f5fc30c3f93962f6a15292d87b3fc78d0ddd477ffcbba481` |
| web-unit | 1227 | 0 | 0 | `web-unit.log` | `8e0fb7373f3574ea58e5d99e24e850167a757dfcd37122d804ffc4d7a352d4f2` |
| restore-unit | 7 | 0 | 0 | `restore-unit.log` | `cfdca6000b1d7ae9e8633b57285b1dedaf01867ca90d5f8756072e9a59944dab` |
| capacity-policy | 54 | 0 | 0 | `capacity-policy.log` | `f28778022dc10dab817abbb6d51d64c642b48036342c407763498d324ece1e32` |
| rollback-template-checks | 34 | 0 | 0 | `rollback-template-checks.log` | `3fe70c4401c7d0d90a3e2e81987f86c59af71030f51c5c240b8a587a7629f0a3` |
| native-workflow | 14 | 0 | 0 | `native-workflow-node.log` | `1fe494a7fab700b1e95f0fcccae0b812b2289837c77c038cb2ff1c0fc764cc71` |
| native-B05 | 13 | 0 | 0 | `native-B05-node.log` | `4ef4da7d30383873fc01ca52dc3a4a671b37da1e3f641e58d7ef6e301c1dfe89` |
| native-retention | 3 | 0 | 0 | `native-retention-node.log` | `24b75463f8a94133167b81ed1cb2fd4c0e94d7a3b3be1d627837d6b018dadf96` |
| native-demand | 1 | 0 | 0 | `native-demand-node.log` | `762a2621fbe0c2a039efd7bf493e5aa3495ec9702887cc2d3dbcd04419653b07` |
| native-broker | 10 | 0 | 0 | `native-broker.log` | `1aa6e76386595cd2791ad3b9ecdca3a2c08c1dfc84f41affb7c2ec14ceb5140c` |
| codex-Azurite-B05 | 1 | 0 | 0 | `codex-Azurite-B05.log` | `9a7f37c8a28a19722a6a4b8f8f5846f57ee096e4ed545db0d08be55518bdfd1a` |
| phase-postgres | 134 | 0 | 0 | `native-postgres-node.log` | `c41f5dd66ebc2edf9d4fc21f45bd4dd3f27ffc75e6f6dfe9b31168cc8392bcf8` |

源码、编译产物、fixture镜像、命令和Node版本指纹：`c0891c3f1ad7acbb2d8d0a408a2079ba8381a2901d145536a1670b2c8bc92786`。验证期间这些输入未改变；原始输出另有逐文件SHA256。原始日志在本工作区 `.codex-task/evidence/validation/summary.json` 及对应日志中保留；含本地临时身份的运行目录不提交Git。

## 证据边界与上线待办

- 新链路工程核心已通过本地真实PostgreSQL、原生call/task cgroup、Python编辑/Word及实际Azure SDK→Azurite验证。供应商为synthetic JSON/fake CLI，模型调用不算真实DeepSeek验收。
- V11新增四种中断验证发生在第二章：第一章远端对象保持，第二章证据封存、unknown不变、无正式成果。旧file-workspace的候选回归仍被本地Codex 0.167与生产0.169的named permission前提阻塞，跟踪 [#1689](https://github.com/ITSophiaXu/BondBuddy/issues/1689)。没有降低AppArmor或生产安全配置。
- V14物理整节点丢盘、跨节点完整接管，V16全部移交故障点组合、V24恢复/充值/取消/发布全并发组合、V28发布/结算所有故障点组合，仍需要集成环境扩展验收；现有回归证明具体对象、token、锁序和单次结算边界，不冒充全组合覆盖。
- V32本轮实际中断迁移事务、原字节重试并验证旧consumer拒领与spool保持；真正替换生产镜像/节点模板并回退属于R01。V33实际pg_dump/pg_restore后验证lost intent与旧账务隔离，备份后账务副作用为correction grant；不声称新业务成果结算或生产RPO/RTO。
- R01生产匹配镜像/helper/profile在AppArmor enforce与systemd下的启动、真实云Stop/drain和回退：**NOT_RUN**。R02固定最终tree的DeepSeek金样、整篇渲染及用户私有下载：**NOT_RUN**。R03混合负载、queue p95和真实canary：**NOT_RUN**。本PR不签发发布凭据、不购买或迁移云资源。
- 1000付费用户不是1000并发；容量须以实际任务到达率、阶段占槽时长及排队尾部指标校准。本地测试不宣称已达到1000人生产容量，亦不把历史未归属的90分钟算给DeepSeek。

## 独立审查与自查

审查与验证问题逐项留存于本工作区 `.codex-task/contract.json`；R1–R20已修正或补齐相关验证。重点修正包括旧协议错误路由、正常存储无界占槽、大表范围、完整付费链路、GC不可发现/公平退避、原session ACK重试、恢复对象/权限安全门、暂停扫描饥饿、迁移回退验证、首个fsync残留盘点、终止测试命中正确原因、首次红证据保留、异步等待后的绝对deadline约束及验证输入指纹完整性。指纹包括实际读取的应用配置、模板/原型、发布脚本、编译产物、工具/数据库/存储镜像ID及运行时版本。修复前行为红证据和最终绿证据分别保留；初始fixture遗漏、cleanup或测试环境权限不匹配不当作业务根因。

新增诊断项目来源缺陷跟踪 [#1691](https://github.com/ITSophiaXu/BondBuddy/issues/1691)，旧预约触发器ACL复用 [#1624](https://github.com/ITSophiaXu/BondBuddy/issues/1624)，暂停扫描饥饿跟踪 [#1692](https://github.com/ITSophiaXu/BondBuddy/issues/1692)。这三项随本PR修复，合并和部署状态按实际更新。其他超时/成果问题只关联已覆盖范围，不批量关闭。

红证据分类：R16 首个fsync标记遗漏、R19异步deadline漂移属于实现缺陷的修改前失败；R17曾期待STALE_LEASE而实际返回ALREADY_TERMINAL属于测试语义修正。`lockedLease`原有租约失活行为保持；修正后的负例使用合法已验receipt，并先核同token、job/run仍running且租约确已过期，不能把原错误断言作为业务根因证据。

需要人工看的三处：原任务/模型许可释放顺序；新协议配置及排空回滚顺序；真实金样和负载发布门。没有修改AGENTS或个人skill。按task-retro提出的最小后续规则是：后台补偿测试须覆盖batch+1项前三持续失败、真实child中断以及持久责任首次写入失败；本轮已用回归实现，持久协作规则须用户同意后再改。
