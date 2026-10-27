# 执行身份与完整业务快照

本记录为 `25c39048` 之后的独立增量。目标是让真实 M3/M4 读取路径按完整执行身份读取业务快照，继续为 G03 同任务补料续做铺设必要边界。**G03 / UX-A03 和完整 UX goal 仍未完成。** 当前执行仍限 V1，没有采用新材料、后继调用、新报价、追加扣款或补料后的新 Word 证据。

## 实现范围

- 新增 `0124_run_execution_business_snapshots.sql`，不改已发布迁移。两张完整业务快照表绑定 owner/project/run/execution_version/input_revision/input_hash，业务 `version` 与执行版本分列；原业务内容、行及创建时间保留。
- 实际迁移精确回填 V1；现有业务 INSERT 在原事务自动桥接，缺失或不匹配使原 INSERT 一并回滚。迁移先排空 M4 topic 行锁，再锁 input/run，覆盖真实创建路径的锁顺序。正整数 JSONB `1.0` 与 `1` 保持一致语义。
- 共同 reader 只查准确版本新表，核对唯一契约和冻结内容。必需快照缺失、错归属/输入/内容均拒绝，不回退旧业务表或最新草稿；普通 M1 无业务快照仍可读取。
- 真实 M1、M3 legacy/file、M4 loader 及 M3/M4 的 input_lock、模型调用前 gate 接入准确读取和持久身份复核。传入快照及伪造 V2 身份不能绕过；读取不改原输入、历史、检查点或账本。

没有页面改动，本轮不新增浏览器截图或用户旅程通过数。SQL 形状检查仅为存储边界；公共输入协议仍来自 `packages/contracts`。

## 验证与证据

最终结果、选用轮次、跳过/排除和源码冻结见 [summary.json](summary.json)，逐文件完整性见 [manifest.json](manifest.json)。各调用分别报告，不能把探索轮、针对性修正或旧浏览器基线相加。

| 本轮选用调用 | 结果 |
| --- | --- |
| API 准确输入、业务快照、真实迁移与锁竞争 | 21 pass / 0 fail |
| API 补料、私有文件、留存及业务完整相关文件 | 186 pass / 0 fail |
| 知识范围、动态计费断言及默认能力配置修正 | 6 pass / 0 fail |
| 原执行/预检等默认能力配置回归 | 6 pass / 0 fail |
| Worker 单元 | 62 pass / 0 fail / 2 skip |
| Worker 真实 PostgreSQL 输入与执行边界 | 37 pass / 0 fail / 4 skip |
| 上传检查四个准确标题、独立充足预算 | 4 pass / 0 fail |

API 整体探索轮保留 **610 tests：484 pass、50 fail、3 cancelled、73 skip**，没有完整重跑为一次全通过。失败归因及补验对应见 [broad-failure-triage.json](records/broad-failure-triage.json)：默认运行能力配置、旧计费/知识断言、不完整业务快照 fixture，以及上传检查 60 秒预算。旧全局 runtime=1 来自保留的会话记录；原命令未采集有效环境，不把推断冒充进程环境实测。后续默认配置命令独立通过，最终命令回执显式记录 runtime flag 为空。

上传三个循环测试在原 60 秒预算超时，随后 single-flight 出现队列超时；四个准确标题以 240 秒预算隔离补验通过，最长约 123 秒。未修改上传生产逻辑或测试源码，也未整套重跑上传文件。五个 Windows NDJSON sink 标题额外按准确名称排除，**不在 73 skip 中，也不构成本轮验收**。Worker 单元跳过两条 Linux 专用 symlink 检查；PostgreSQL 组跳过四条依赖 Azurite 的完整交付链，均未实测。

最终 API/worker 构建及契约检查通过。广测与最终冻结之间仅六个 API 测试的 src/编译 JS 改变，生产源码、contracts、迁移及 worker 字节不变；最终 before/after **1,656 项一致**。完整迁移从空库实际回放至 0124。初次清理检查发现先前中断轮遗留的 19 个私有测试 clone，核对准确名称、owner、专用集群与无连接后清除；两个模板均为空，最终无 clone/其他连接，并按原启动 PID **38148** 停止 PostgreSQL 16.14（15526）。失败、启动脚本错误、中断和清理历史全部保留。

快照专项的实体、材料和模型结果均为 synthetic；API 整体探索轮另有仓库已授权样本的上传检查，原件未复制进本证据包。PostgreSQL、事务、约束、迁移和实际 worker 输入读取是实测；未调用真实模型、Azure 或支付，不代表业务内容或 Word/WPS 专业验收。

复现重点：构建 contracts/API/worker 后，在空的已迁移私有测试模板上设置 `BB_TEST_DATABASE_URL`，运行 API `run-execution-business-snapshots.pg.test.js`、`run-execution-input.test.js`、`run-execution.pg.integration.test.js` 及 worker `execution-input-loaders.pg.test.js`、`review-input-execution.test.js`、`m4-input.test.js`。测试 helper 为每个集合创建并删除独立数据库 clone；迁移竞争与故障注入只作用于这些 clone。

## 保持开放的依赖

同一 run 的真实后继采用仍需 CAS/幂等回执和活动执行、版本检查点/调用身份、版本化业务报告/成果/授权、增量旧工作复用及材料保留。用户已选择 B“必要重做另行报价并确认”，具体公式尚待已有异步问题的答复。当前快照表仍只接受现有 V1 业务来源，不能用它宣称 V2 已可执行。

本轮仅本地提交，不推送、创建 PR 或部署。
