# 日志操作与目标确认回归夹具（#1101）

## 结论与范围

固定源码 `94691eecfe2b9d20885c97f84e0c60e9307da982`（tree `542efcf7fd3cef222a9083d69c0a27ab5dd93965`）的两个完整 API 文件 **55 pass / 0 fail / 0 skip**，串行命令耗时 135.292 秒；另两个未改动的协议边界文件 **11 pass / 0 fail / 0 skip**，1.468 秒。本任务是测试维护，不计为新增产品功能 Bug。代码完成，尚未部署，待统一发布；未进行用户验收。

| 文件 | pass / fail / skip | 说明 |
|---|---|---|
| zz_log_ops.test.ts | 53 / 0 / 0 | 原53项完整保留，覆盖脱敏、Blob回读、权限、用量、outbox、进程重放、evidence gate、清理、真实TCP和性能边界 |
| target-confirmation.test.ts | 2 / 0 / 0 | 原目标声明/不可变/归属/重放1项，加独立陈旧输入拒绝1项 |
| billing-int64.test.ts | 5 / 0 / 0 | 未改动，核对高于MAX_SAFE精度、精确冻结分配、null与测量零 |
| billing-wire.test.ts | 6 / 0 / 0 | 未改动，核对当前HTTP字符串、非法数字拒绝、number-v1原请求重放和响应schema |

原 #1013 gate `1794418350450-38278111` 的 749 文件回执继续 failed。没有执行全量门禁、真实模型、浏览器、支付或生产环境。

## 准入前提与协议预期

共享 helper 与 #1084 / #1099 的 Git blob 相同（`ae31c871b79d2f89467dffe3a49c769f795cfc36`），准备有效合成 DOCX，走真实上传、完成、采用、原稿声明、输入锁定与当前 credit-quote，仅补精确短缺的合成积分。zz_log_ops 保留真实 Azurite；target-confirmation 新增合成内存 Blob 保存实际原稿字节，不访问Azure。

原 **466 条 assert 全部保留**：450条表达式逐字相同，16条是明确的HTTP协议调整；新增陈旧输入反例另有14条断言。协议依据为 #814、#1046 及[2026-10-29 int64迁移](../product-decisions/2026-10-29-billing-int64-migration-audit.md)。逐条before/after和DTO路径保存在proof中。

- adminJobTimeline 的累计usage/consumption，adminMetrics 的jobs/attempts/consumption/by_model/operations/errors，以及adminErrors count，按注册的DTO路径断言十进制字符串，原数字值不变。operations至少1的原下界用BigInt比较。
- 两个HTTP schema检查改为对应billingDtoSchema + Int64Schema，与已批准现代协议一致；没有把所有响应或内部字段统一转字符串。
- 内部服务与PG数字断言、attempt_no、provider_status、普通版本号与null未知值均保留。没有用本次实际返回值倒推expected；固定计数仍由合成动作与指定user/project/job过滤核对。额外11项未改动用例验证精度/null/历史number-v1边界。
- 原skip、timeout与全部53项日志测试保持。未开启历史计费fixture，未改生产规则、定价、迁移或exclusions。

## 目标声明的时间顺序与反例

依据[11-05原稿决定](../product-decisions/2026-11-05-required-reference-prospectus.md)，“已有任务及幂等重放保留原输入”，新请求仍必须使用当前输入和报价。

原测试先锁第2版、再锁第3版，然后首次执行第2版，不符合当前新请求准入。本次保留第1未确认、第2已确认、第3替代的编号和所有原断言，在第2版仍为最新时获取报价并创建run，再把原alternative区块（两个断言）移到首次执行之后，锁第3版，最后用原execution_request_id重放已有第2版run。没有把新请求旧输入的拒绝改成允许。

新增独立owner/project反例：没有活动run，锁1→锁2并报价→锁3替代，以新execution_request_id提交旧2/原quote；明确检查409 INPUT_REVISION_CONFLICT、run=0、reservation=0、冻结=0。这避免活动任务互斥先返回错误而掩盖陈旧输入保护。

## 失败证据与准确版本

原门禁源码 `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2`：

- [zz_log_ops原TAP](logops-target-admission-20261112/original-zz_log_ops.tap)：53项，41pass / 12fail / 0skip，12项在runFor被INPUT_REQUIRED阻断。
- [target-confirmation原TAP](logops-target-admission-20261112/original-target-confirmation.tap)：0pass / 1fail / 0skip，首次execute被INPUT_REQUIRED阻断。

本次测试前基线为develop `867dbb22988a450cda05a004cdc2589ff68a7f9c`，两个原测试blob与原gate一致；旧失败来自旧版本，不冒充本次重新执行的red。

本次第一次尝试只在证据AST前检失败：白名单中的完整assert语句带分号，AST call.getText不带分号。raw源码与依赖lock核验已先通过，尚未构建/迁移/测试。修正审计器，让白名单和源码都经过同一个AST解析后，使用相同源码SHA重新开始；[前检失败日志](logops-target-admission-20261112/precheck-audit-failed.log)及其运行/lock记录保留。此失败不是产品或测试用例失败。

随后原提交e19744472db3a9699ac91bbf8cc032bcda6a180a的严格API编译发现测试schema标注为宽泛TSchema，使Value.Check后的响应变量收窄为unknown。保留[首次编译失败日志](logops-target-admission-20261112/initial-build-failed.log)，只将两个schema静态类型明确为现有BillingWireDto对应类型；运行schema和16处协议断言均未变。该轮也尚未迁移数据库或执行测试。

当前固定源码的首次核心执行未完成：[失败TAP](logops-target-admission-20261112/initial-core-incomplete.tap)仅48项有回执，37pass/11fail/0skip，后7项无回执，458.618秒；边界11项先通过。6项sink失败来自定向编译漏动态ndjson-file-sink入口，另3项性能阈值及2项TCP waiter断言在低额度环境失败。三容器合计1CPU/3GiB中runner只获0.65CPU、PG0.2CPU、Azurite0.15CPU；原gate runner是8CPU/12GiB、jobs8，两者不是同资源对照。本轮出现无回执的prompt deadline测试含无界entered等待，未据此推定确定产品根因。终止已核验owned子进程后有1克隆库，随后3容器及网络精确删除，PG tmpfs随容器清空；完整诊断与清理记录保留。

复验仅补动态编译入口、流式日志、有界进程组收尾并使用下述足够CPU额度，生产源码与原测试断言/timeout/性能阈值未改变。关键log-ops/server/admin-routes/sink/test-database生产blob与原gate相同；data.ts变化仅落盘pipeline/下载销毁收尾，prompt所用getIfExistsBounded未改。相同固定源码重新进行raw/AST审计、严格构建和完整测试。

[最终55项TAP](logops-target-admission-20261112/final-test.tap)与[11项协议边界TAP](logops-target-admission-20261112/wire-boundaries.tap)均来自同一固定源码。之后只增加验收材料。

## 环境与复现

- 原缓存runner、PostgreSQL16 Alpine、Azurite3.35.0，按不可变镜像ID运行，--pull never；未安装或更新依赖。
- Node v22.23.3、TypeScript 5.9.3、pg 8.23.0、Fastify 5.12.5。缓存依赖lock与Git raw lock逐字节比较，仅允许明确的LF/CRLF换行等价；精确SHA-256与匹配结果保留。
- 全部6430个跟踪文件逐一核对raw Git blob。4依赖包按原配置构建；API继承原严格tsconfig，定向include上述4测试、helper、动态upload-inspection-worker.ts及ndjson-file-sink.ts，并确认两个JS入口存在。
- internal网络，无host端口。合计3.5 CPU / 3 GiB：runner2CPU/2304MiB、PG1CPU/512MiB、Azurite0.5CPU/256MiB。PG/Blob均独立合成数据tmpfs，各阶段cgroup配额与节流数据保留。runner使用init回收子进程，外层阶段进程组有界收尾；不改变测试内timeout与性能阈值。
- 独立迁移bb1101_template，完整文件各自克隆私库，以下命令串行：

```sh
node db/migrate.mjs
node --test --test-concurrency=1 apps/api/dist/billing-int64.test.js apps/api/dist/billing-wire.test.js
node --test --test-concurrency=1 apps/api/dist/target-confirmation.test.js apps/api/dist/zz_log_ops.test.js
```

结束后按`^bb1101_template_t[0-9]+_[0-9a-f]+$`核对克隆库为0，确认runner只剩init和sleep，按精确ID删除本任务3容器和internal网络，并复查不存在；没有修改其他测试资源。

版本、命令/耗时、AST白名单、raw/lock、镜像和清理证明见[proof.json](logops-target-admission-20261112/proof.json)。TAP展示副本只去除行尾空白和文件末尾多余空行；proof同时记录原始/展示SHA-256，原字节日志在本地证据目录保留。

## 范围外的45个A类文件

原A类54文件中，#1084处理4项、#1099处理3项、本任务处理2项，其余45项不纳入本次通过结论。其中review-workspace/review-materials由#1053单独处理；不能据清单推定都尚无人修复，也不能在没有同版本全量门禁时声称全部通过。

authoring-task-kind明确覆盖历史billing disabled/enabled；当前默认commercial=true，不能简单给两边补quote冒称仍验证旧双分支，保持未解决。execution-key/project-list/project-collection/project-kind-conversion也仍需按已有输入/旧成果/转换竞态分别审查。

- `apps/api/src/execution-key.test.ts`
- `apps/api/src/issuer-identity-input-lock.test.ts`
- `apps/api/src/non-production-test.test.ts`
- `apps/api/src/project-list.test.ts`
- `apps/api/src/review-linked-workspace.test.ts`
- `apps/api/src/review-price-activation.pg.test.ts`
- `apps/api/src/review-workspace.test.ts`
- `apps/api/src/zz_trial_guard.test.ts`
- `apps/api/src/authoring-task-kind.pg.test.ts`
- `apps/api/src/commerce-coverage.pg.test.ts`
- `apps/api/src/deletion-lifecycle.test.ts`
- `apps/api/src/project-collection.pg.test.ts`
- `apps/api/src/project-kind-conversion.pg.test.ts`
- `apps/api/src/queue.test.ts`
- `apps/api/src/review-action-events.pg.integration.test.ts`
- `apps/api/src/review-materials.test.ts`
- `apps/api/src/server.test.ts`
- `apps/api/src/storage-lifecycle.test.ts`
- `apps/api/src/working-draft-parse-admission.test.ts`
- `apps/worker/src/codex-durable.test.ts`
- `apps/worker/src/file-authoring.pg.test.ts`
- `apps/worker/src/m4-pipeline.pg.test.ts`
- `apps/worker/src/pending-issuer-working-draft.test.ts`
- `apps/worker/src/project-qa-e2e.pg.test.ts`
- `apps/worker/src/reconcile-run.test.ts`
- `apps/worker/src/review-file-delivery.pg.test.ts`
- `apps/worker/src/rule-applicability-context.test.ts`
- `apps/worker/src/run-runtime.test.ts`
- `apps/worker/src/runtime-interactive-slots.pg.test.ts`
- `apps/worker/src/user-reference-outline.test.ts`
- `apps/worker/src/workpaper-paid-checks.pg.test.ts`
- `apps/worker/src/m2-paid-worker.test.ts`
- `apps/worker/src/m3-review-pipeline.pg.integration.test.ts`
- `apps/worker/src/model-image-stage.pg.test.ts`
- `apps/worker/src/project-files-e2e.pg.test.ts`
- `apps/worker/src/provider-reconciliation.test.ts`
- `apps/worker/src/review-reassembly.test.ts`
- `apps/worker/src/runtime-entry.test.ts`
- `apps/worker/src/runtime-isolation.test.ts`
- `apps/worker/src/runtime-parse-slots.test.ts`
- `apps/worker/src/unified-authoring.pg.test.ts`
- `apps/worker/src/workpaper-assessment.pg.test.ts`
- `apps/worker/src/workpaper-library.pg.test.ts`
- `apps/worker/src/workpaper-shared-stage.pg.test.ts`
- `apps/worker/src/workpapers.pg.test.ts`
