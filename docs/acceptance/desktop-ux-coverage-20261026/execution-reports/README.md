# 准确执行版本的结构化复核报告验收（本地，未发布）

2026-10-27，起点 `05f5b235fe104bcefd9d4c6e8674d21f56bd6352`，分支 `codex/desktop-ux-coverage-20261026`。测试用户、项目、报告和材料均为 synthetic；采用真实 PostgreSQL 16、应用读写路径与租约。没有真实模型/供应商、支付、Azure 或客户材料验收。本轮未新增 Word 内容/交付或桌面浏览器验收；相关回归集合的既有执行不升级为这些能力的新验收。

## 实现与校验边界

0128 新增 canonical `bb_review_execution_reports`，主键 `(run_id,execution_version)`、全局唯一报告 ID、完整 owner/project/run/execution/input revision/hash 双 FK，分别绑定不可变执行与复核业务快照。旧表保留；V1 bridge 和 trusted writer 的镜像均原子核对完整身份、业务版本、正文、hash 和 PostgreSQL 微秒时间。canonical-only 读取与关系 view 不依赖 legacy mirror；显式报告在 Word final 交付前仍可读。

SQL 验证 hash 格式、基础 envelope、存储身份、冻结 input/source pin 与 legacy exact copy。报告 evidence locator 允许 JSON 数字和 Unicode key，不能复用 editor 的 SQL canonicalizer；SQL 不重算或声称证明 JavaScript canonical 摘要。可信 writer 与每个正文 reader 使用唯一 contracts `isReviewReport` 和 `inputManifestHash`，并核对冻结 manifest 的 source/scope/version/operation 和 follow-up 来源 ID/hash。格式正确但错误的历史摘要在应用读写路径拒绝，不将 SQL 的精确复制当作摘要真实性证明。

登记事务按 project→run→job 锁定、重新验证 live lease 与固定执行输入。滚动旧 writer 的 40P01 仅重试完整幂等登记事务；不重复模型或 Word 工作。新插入后复验失败抛错回滚，`ON CONFLICT` 未写入时保留原不可变报告。源报告按持久身份解析，不借消费任务 lease 或 current run input，不回退旧报告。

## 采用结果

| 集合 | 独立采用结果 | 冻结轮次 | 原始 receipt |
| --- | --- | --- | --- |
| api-report | 13 tests / 13 pass / 0 fail / 0 cancelled / 0 skip / 0 todo | 2 | [2026-10-26T18-15-31-663Z-api-report-50884-2361cf4c](records/runs/2026-10-26T18-15-31-663Z-api-report-50884-2361cf4c/result.json) |
| worker-report | 12 tests / 12 pass / 0 fail / 0 cancelled / 0 skip / 0 todo | 2 | [2026-10-26T18-15-32-595Z-worker-report-29832-693657c6](records/runs/2026-10-26T18-15-32-595Z-worker-report-29832-693657c6/result.json) |
| api-regression | 94 tests / 94 pass / 0 fail / 0 cancelled / 0 skip / 0 todo | 2 | [2026-10-26T18-16-37-048Z-api-regression-23772-234643a0](records/runs/2026-10-26T18-16-37-048Z-api-regression-23772-234643a0/result.json) |
| worker-regression | 82 tests / 81 pass / 0 fail / 0 cancelled / 1 skip / 0 todo | 3 | [2026-10-26T18-22-20-126Z-worker-regression-21640-50f8f7f5](records/runs/2026-10-26T18-22-20-126Z-worker-regression-21640-50f8f7f5/result.json) |

保留 28 个完整 invocation、145 个原始文件。每个文件的库存、字节数、SHA-256 与来源均在 [summary.json](summary.json) 和 [manifest.json](manifest.json)；不同集合、重复执行和轮次不相加。

skip 按原 Node summary 保留，不计作通过。每个采用集合必须有一个完整 summary，tests/pass/fail/cancelled/skipped/todo 可核对，fail/cancelled/todo 均为 0；不将不同集合或失败重试的计数累加为覆盖率。collector 按约定自动选择各 mode 最新成功记录；如果它之后还有同 mode 失败，另见该采用记录的 `later_same_mode_failures` 及下面完整失败清单，不把较早成功称为较新失败已通过。

构建记录：

- [build](records/runs/2026-10-26T18-08-26-340Z-build-33380-32c1b408/result.json)：4 个命令均退出 0。
- [api-build](records/runs/2026-10-26T18-14-39-206Z-api-build-21276-2670643c/result.json)：1 个命令均退出 0。
- [worker-build](records/runs/2026-10-26T18-21-24-907Z-worker-build-47816-f90aa449/result.json)：1 个命令均退出 0。

采用 reset 后 [完整 fresh migrate](records/runs/2026-10-26T18-07-40-378Z-migrate-51032-86cfe515/result.json)，逐项 Applied 到 0128。最终冻结的 0128 SHA-256 为 `1fb8e0ed7580e435c02735b30f70240b51c282c3a3fb03b3beedb3a3746a3e3d`，包含 `CHECK(isfinite(created_at))`。迁移 receipt 未登记执行当时的 SQL 字节 hash；本档案保存完整 fresh 日志和最终 SQL 的路径/字节数/hash 冻结记录，SQL 正文位于仓库 `db/migrations/0128_review_execution_reports.sql`，未复制进档案。不将这些记录冒称为独立的迁移时字节证明。

## 冻结与失败记录

- 第 1 轮：2290 个文件，before/after 完全一致；[before](records/runs/2026-10-26T18-12-27-406Z-source-before-15812-4c3dcd79/snapshot.json) / [after](records/runs/2026-10-26T18-14-19-051Z-source-after-16540-621547b6/snapshot.json)。
- 第 2 轮：2290 个文件，before/after 完全一致；[before](records/runs/2026-10-26T18-15-26-707Z-source-before-45932-cd85bdbd/snapshot.json) / [after](records/runs/2026-10-26T18-21-18-535Z-source-after-38296-f1d7c156/snapshot.json)。
- 第 3 轮：2290 个文件，before/after 完全一致；[before](records/runs/2026-10-26T18-22-15-337Z-source-before-45396-bf4c4e37/snapshot.json) / [after](records/runs/2026-10-26T18-23-35-693Z-source-after-34964-a6f0291f/snapshot.json)。

最终 source/build inventory 再次与当前树逐字节核对。范围包括 API/Worker 源码与构建、web 源码/测试与 unit 构建、contracts 源码/构建/examples、迁移、包配置、当前 verifier/config，以及 **Python 源码**。只跳过目录名为 `__pycache__` 的缓存；其他文件仍纳入。外部 Node/Python/PostgreSQL runtime 二进制未冻结。原始 verifier 的所有使用版本按 SHA 保留，当前 config 仅作为 reproduction provenance 保存，本轮没有采用浏览器结果。

所有失败与重试原始记录：

- [2026-10-26T18-03-41-603Z-initdb-40600-1729b46b](records/runs/2026-10-26T18-03-41-603Z-initdb-40600-1729b46b/run.log)：initdb，status=1；无完整、可采用的单一 Node summary。失败记录完整保留，不加入采用计数。
- [2026-10-26T18-12-32-425Z-api-report-1756-c1198595](records/runs/2026-10-26T18-12-32-425Z-api-report-1756-c1198595/run.log)：api-report，status=1；13 tests / 12 pass / 1 fail / 0 cancelled / 0 skip / 0 todo。失败记录完整保留，不加入采用计数。
- [2026-10-26T18-12-33-406Z-worker-report-30936-14629e12](records/runs/2026-10-26T18-12-33-406Z-worker-report-30936-14629e12/run.log)：worker-report，status=1；12 tests / 11 pass / 1 fail / 0 cancelled / 0 skip / 0 todo。失败记录完整保留，不加入采用计数。
- [2026-10-26T18-17-25-108Z-worker-regression-42108-66aac2e7](records/runs/2026-10-26T18-17-25-108Z-worker-regression-42108-66aac2e7/run.log)：worker-regression，status=1；82 tests / 79 pass / 2 fail / 0 cancelled / 1 skip / 0 todo。失败记录完整保留，不加入采用计数。

轮次间准确差异见 `summary.json.source_transitions`。未配成成功 before/after 的 baseline 单列保留，不将其称为成功冻结。

## 本地清理与重现

本轮准确 PostgreSQL PID **22604**，目录 `.local/report-postgres/data`，端口 **15540**，角色 `bb_report_test`，模板 `bb_execution_report_template_20261027`。最终独立 audit 与 stop audit 一致，仅原 0027 的四条准确禁用种子，所审计业务表全零，clones/other clients 均为空。记录的同一 direct child 已 stop=0、status=3，当前 PID 文件不存在。见 [audit](records/runs/2026-10-26T18-23-40-444Z-database-audit-39640-5ad6140b/result.json) / [stop](records/runs/2026-10-26T18-23-52-011Z-pg-stop-14196-4a2d4016/result.json)。

本目录的 collector 只读本地记录和源码，不连接数据库、不启动进程、不运行测试。所有校验完成后才创建全新 acceptance 目录，所有输出均 `wx` 禁止覆盖，最后写 manifest。原始 command/start/result/run.log 完整保留；准确命令、环境白名单、时间和退出码见各 receipt。重现需已有仓库依赖、父目录 embedded PostgreSQL 与记录的 Python，使用 `reproduction/verify.mjs`；本次未启动生产服务，也没有 push、PR 或部署。

## Goal 状态与限制

G03 / UX-A03 与完整 UX goal 保持 **active、未完成**。全局 V1 gate、current-input integrity view 和 immutable run origin 未开放新输入采用；storage key 可表示执行版本不等于可以执行 V2。本轮没有补料采用、同 run successor、定价或新增 ledger 授权。

用户已选 B：必要重做另行报价，确认追加金额后继续；B1/B2 计算规则尚未确定，本轮不自行定价或新增扣费。真实旧工作复用与增量处理、同 run 补料后继续、新 Word 桌面完整旅程、M4/其他消费者迁移与 retention/cleanup 后续边界仍需分别完成。本档案不重算整体旅程覆盖率，旧 sealed archives 保持不变。
