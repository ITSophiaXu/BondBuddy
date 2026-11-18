# Issue #1613：供应商核对不再永久占用活动任务

## 为什么发生：已证实的故障链

调查基线为 `34e22dcd2bc79e6e0ba20fec5a0f940c575f5682`，线上证据取于 2026-11-18。原问题是编制 run `cdcc823b-7e87-42c5-a22e-d16dca6e54e0` 的 `file-authoring-v1` 调用超时后永久停在 `provider_reconcile`。

1. **触发点是实际部署的运行时限。** 模板显式设置 `BB_CODEX_AUTHORING_TIMEOUT_MS=5400000`、`BB_CODEX_TIMEOUT_MS=5400000`。实际 runtime 为 5,400,030 ms、`SIGTERM`、`MODEL_TIMEOUT`。完整执行日志 926,982 bytes，SHA-256 `e691f9f4535e5cc213958cf7c3eb8bbc9bc1e093c4270276a7c3c1797d5be43f`，包含 82 次命令完成记录；超时前仍在读取原稿表格、处理财务扫描材料。没有 provider error、turn.failed 或 turn.completed 事件。**没有证据证明某一客户文件或模型供应商故障导致此次失败，也没有进入最终文件收集完成阶段的证据。** OCR 子命令出现过局部失败，但随后继续工作，不能把它们直接认定为最终根因。
2. **进度没有形成可跨节点恢复的文件快照。** 已部署 `file-authoring-stage.js` 只传入 `prepare/collect/completionCheck`，缺少 `onFailure`。该 run 的 checkpoint 只有 `input_lock`、`materials_ready`、`file_authoring_v1_prompt`，没有 `file_authoring_recovery` 或 capture，provider result refs 为 0。提示词和阶段记录不等于临时工作目录。已部署 `recoverUnifiedTimeout` 只接受 `unified-v3-*` / `unified-v4-*`，不支持该调用 ID。
3. **恢复扫描饥饿。** 已部署 runtime 固定 `pausedRuns(...,20)`，queue 按 `updated_at,id` 取最旧 20 条；默认 `codex_no_lookup` 恒为 unknown，恢复失败不推进排序。27 条暂停编制任务中本任务排第 27。16:30–16:40 日志的 780 条 reconcile 是相同 20 条各 39 次，与数据库首 20 条完全一致。本任务超时后约 6 分钟仍有执行 worker，但被扫描 0 次。
4. **执行节点缩容放大故障。** 此任务实际在腾讯 CVM 执行。16:40 会话正常排空，16:42 云端停止回执；停机晚于卡住。paused/unknown 不计入可执行需求，节点可缩至 0；原恢复循环随节点消失。原 heartbeat 汇总把健康 parser 当成总体 worker 健康，未发现编制能力缺失。

线上归档 SHA-256 `c2a67c07f99f1204400d4c8d161bcaae2bc592a776889908cb19f6a52c70bec3`；其中 runtime / queue / file-authoring-stage 哈希分别为 `6daea161ac9d2c40cd5be9a28ef08d66b153d6be16490a63660d35bf5d269d3b`、`3463f7e95c4e5fc8a5c2cd3c929ab90344c3c22dfa3baeca0f8a2b1c74c17f12`、`dc4fcacfba0e5ef836b10278f2eff630ff637abcb4c09bc624f70f1d89ff2fe8`。线上未采用已合并 #1483 的快照恢复和 #1595 的 unknown 限期记录。代码合并不能代替实际节点版本核验。

## 为什么之前测试没有发现

- 不是完全没有文件测试。`codex-file-authoring.test.ts` 已覆盖 collect 验证失败与存储异常；`file-authoring-recovery.test.ts` 已覆盖工作文件字节恢复；`file-authoring.pg.test.ts` 已覆盖真实 Word 收集、私有 Blob 回读、下载 SHA-256 与跨用户拒绝。
- 原 `unified-timeout-recovery.test.ts` 的 unknown 用例只要求一小时后不再进入 `pausedRuns`；它没有断言 run/job 必须失败、积分合同必须结束。旧实现停止扫描却继续 paused，也会通过。
- 单阶段恢复测试没有覆盖“首 20 条不能推进 + 第 27 条任务”，也没有把弹性执行节点全离线、parser 仍健康、常驻协调和账务收尾串起来。
- 已验证的最新源码与部署归档不一致。新增测试不能单独补救发布版本偏差；发布必须同时核对主站 ops 和现存/未来执行节点的实际文件。

## 为什么不能把一次失败变成整项工作丢失

- 本修复复用既有文件恢复协议：固定原输入、原 run / reservation，验证 capture、完整快照、文件哈希、退出证据、重试次数及原总 deadline。恢复 `input.json`、`scratch/`、`output/`；前面已完成的 pipeline 阶段从 checkpoint 重放，只重新进入未完成阶段。
- 完整快照必须全部写入私有 Blob 并回读匹配，才能标记 saved。路径越界、链接、文件变化、容量超限、存储失败或不完整 capture 都不能冒充已保存。测试保留并检查这些失败分支。
- 一轮模型调用内部的未保存临时内容不等于持久化进度。历史问题 run 没有文件快照，不能从 prompt 或日志凭空还原；新代码也不会把一次全量重跑称为无损续跑。已有源材料、输入和持久化阶段记录继续保留。
- 确认本地进程已结束、没有可用恢复材料且适配器无查询能力时，任务失败。不能确认的结果每分钟核对一次，从不可变暂停事件起最多一小时；旧版本 exhausted 记录也终结。供应商观察、unknown 用量、进程 fencing 均不改写。
- `run/job failed`、错误记录、checkpoint 审计、outbox 和原信用合同的失败释放/退款在同一事务完成。账务隔离仍走 `billing_reconcile`，不绕过钱包保护。纯业务暂停（用户主动暂停、积分不足、等待材料）保持既有语义；恢复期限或次数已被证据确认耗尽的执行仍按原恢复协议失败。
- 自动继续只使用已验证恢复证据；失败终态不会自动复活。用户明确重新提交时，使用新的 execution_request_id，留下独立任务与账务审计。

## 实现

`provider-reconcile-sweep.ts` 为 worker 与常驻 ops 共用恢复器。每批最多 20 条，keyset 游标先前进再处理，单条异常不阻断后续任务；候选仅为当前 provider 核对态，不扫描失败/取消历史。新任务提交和 claim 不调用这个恢复器。

ops 新增默认开启的 `provider_reconcile` 调度任务（30 秒，沿用数据库调度租约）。默认恢复路径只访问数据库，不执行模型、不需要 Blob 凭据；安全续跑重新排队后，由现有容量管理拉起执行节点。环境开关 `BB_OPS_PROVIDER_RECONCILE` 和间隔 `BB_OPS_PROVIDER_RECONCILE_SECONDS` 用于既有运维配置。

调度日志记录 scanned/progressed/errors、paused_count、oldest_paused_age_seconds、worker_alive；调度失败走已有 scheduled_task_failed，积压/能力缺失复用 queue_backlog_stale / worker_heartbeat_stale，scope 为 provider_reconcile。托管节点按当前 epoch/session 和所需 authoring/review/probe 能力核对，非托管模式只认 run heartbeat，parser 不计。

已交付成果但待供应商用量结算的 `settlement_pending` 保持既有结算核对路径，不按普通执行失败退款。本次新增终态规则只处理尚未完成的 `paused/provider_reconcile`，避免把已交付任务错误终结。

公共 run/job 状态枚举、计费费率和数据库 schema 不变；公共运维任务枚举增加一个任务名。页面沿用既有失败态和操作，仅补充“不再等待核对”的失败原因文案；归档/删除项目明确终结，不提示直接重新执行。对照原型为 `product-prototype/public/authoring-live-progress.html?state=word_failed`、`review-live-progress.html`（原型基线 `164a1b74`）。未改页面布局、步骤或入口，新文案落实本 Issue 要求的确定性失败；浏览器截图与断言使用 synthetic HTTP 数据，真实文件链路由单独 PostgreSQL/Azurite 用例验证。

## 自动化验证

测试材料、账号、积分及供应商响应全部为 synthetic；不调用真实模型，不读取生产账务。新增 PostgreSQL 回归包括：无快照的 90 分钟本地超时、并发终结与 outbox 失败回滚、已有动态扣费退款、27 条队列与新提交、查询异常隔离、无执行 worker 的 ops 收尾、旧 exhausted 记录、业务暂停、归档项目及 review/generation/QA 共用终态策略。

端到端文件用例增加：真实写入 scratch/output → 明确 413 失败 → 完整快照 → 常驻协调恢复 → 新 CLI 核对原字节 → Word 收集/交付 → 两份下载哈希一致。该用例使用真实文件、数据库、Azurite 和 Word 工具，模型为合成 CLI。总期限耗尽的 timeout 必须失败，不能通过重置 deadline 伪造可恢复。

验证源码为 `c3763478f2513f8d8272f19d839965025693b7ef`，已 rebase 到 `develop fa96f8b9`。环境为 Linux Docker、Node 22.23.2、PostgreSQL 16、独立 Azurite、Python 3.11、LibreOffice、Codex CLI 0.169.0。模型响应来自 fake CLI，网关请求数为 0。新增 review/generation/QA 用例验证共享队列状态机，不冒充各产品的完整入口验收。

| 验证 | 结果 | 命令 / 用例 |
| --- | --- | --- |
| 工作区构建 | 通过 | `npm run build` 的 contracts/domain/registry/context/API，随后 `npm run build -w @bondbuddy/worker` 和 `npm run build -w @bondbuddy/web`；最新 rebase 仅改前端，再次复验 web |
| 公共契约 | 72 pass / 0 fail / 0 skip，示例与生命周期检查通过 | `npm run check:contracts`（32 + 29 + 11） |
| API、工作文件快照、交付与原生文件模式 | 28 pass / 0 remaining fail / 0 skip | `node --test --test-force-exit --test-concurrency=1`：API 的 provider-reconcile-unknown/file-authoring-recovery；worker 的 file-authoring-recovery/file-authoring-delivery/codex-file-authoring |
| 队列、供应商核对和执行能力隔离 | 11 pass / 0 fail / 0 skip | `node --test --test-force-exit --test-concurrency=1 apps/worker/dist/provider-reconcile-sweep.pg.test.js apps/worker/dist/provider-reconciliation.test.js apps/worker/dist/runtime-isolation.test.js` |
| 调度租约、日志、原统一编制恢复 | 11 pass / 0 fail / 0 skip | `node --test --test-force-exit --test-concurrency=1 apps/worker/dist/ops-scheduler.test.js apps/worker/dist/unified-timeout-recovery.test.js` |
| 文件恢复 PostgreSQL | 2 pass / 0 fail / 0 skip | `node --test --test-force-exit apps/worker/dist/file-authoring-payload-recovery.pg.test.js`；含 42 条统一队列，最多 3 批到达可恢复任务 |
| 完整文件与下载链路 | 1 pass / 0 fail / 0 skip | `node --test --test-force-exit apps/worker/dist/file-authoring.pg.test.js`；同一 run 的 attempt 1 failed/unknown → attempt 2 completed/measured，原工作字节与两份下载哈希一致 |
| 前端状态单元 | 12 pass / 0 fail / 0 skip | web 的 `tsc -p tsconfig.test.json` 后运行 review-timeline / project-execution-poll |
| Chromium 状态与操作 | 2 pass / 0 fail / 0 skip | `playwright test tests/project-execution.spec.ts --grep "terminal reconciliation|legacy reconciliation"`；新失败态可明确进入下一轮，旧暂停事件不能提前显示失败 |

初轮失败如实保留在本地日志：旧测试缺少当前必传材料/报价策略、假定文件专用扫描固定两批；本地容器缺少 namespace 权限与 machine-id。修正测试夹具和隔离环境，没有关闭生产校验。单元组中 23 项首次已通过，5 项 native 测试在允许嵌套 namespace 的测试容器内单独重跑通过。原有失效测试断言已改为真实持久化 run/job 状态、分页上限和不可变观察证据，未把日志报错改写成成功。

PostgreSQL 用例设置 `BB_TRIAL_GUARD=off`、`BB_TEST_DATABASE_URL`、`BB_TEST_AZURITE_CONNECTION_STRING`，均指向本任务独立合成环境；测试容器拥有独立 machine-id，允许 Codex 的真实内层文件沙箱，不开放模型网络调用。测试准备沿用 #1583 的 Linux LF SQL 副本流程；不修改已部署迁移。开发依赖复用锁文件完全一致的本机测试容器，锁文件 SHA-256 为 `849caa9b9f385714c6b1796cc4037a6cc5520ee0bef9f62265b298874965acd2`。

页面对照（1440 × 960）：[现有失败态原型](issue-1613-ui/prototype.png)、[本次实现](issue-1613-ui/implementation.png)。实现图裁去视口以下区域；原完整截图保留在本地验证目录。五步进度、失败摘要、材料保留、继续修改/查看材料入口不变；失败阶段从原型的“保存文档”显示为本例实际“编制募集书”，原因文案按用户本次要求明确终态。没有引入新页面布局或未经确认的新操作流程。

## 统一发布与验收

代码完成后仍需由指定发布 chat 交付同一固定版本的 API、worker、ops 和 web。无新增迁移。发布需覆盖现存节点、未来节点模板/overlay，确认恢复任务在常驻 ops 的任务列表中；核验日志中的进度与能力指标。

存量任务由新版恢复器按同一规则处理；本开发任务不直接修改生产任务、账务，不重启生产服务。既有未知用量继续可审计，缺快照旧任务不会被自动重发。统一验收应检查原 run 的明确失败和原合同收尾、新任务可开始、用户暂停保留以及有效快照的实际续跑/下载。真实模型内容质量和用户实际验收仍需在统一测试版完成。
