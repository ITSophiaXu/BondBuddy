# OCR、提交记录与可观测性回归夹具（#1090）

## 结论与范围

固定源码提交 `843219173ec54b3fcea6d40499ee8844c9c834c5`（tree `161376666e3b0e136d87c399da74f3212f80f330`）的三个完整 API 测试文件 **5 pass / 0 fail / 0 skip**，串行命令耗时 41.161 秒。本任务是测试维护，不计为新增产品功能 Bug。代码完成，尚未部署，待统一发布；未进行用户验收。

| 文件 | pass / fail / skip | 保留的目标覆盖 |
|---|---|---|
| ocr.test.ts | 2 / 0 / 0 | 原 PNG、OCR 回执与修正、不可变/幂等、归属、活动 run 授权与隐私 |
| user-submissions.test.ts | 2 / 0 / 0 | 原 audit PDF、提交文本/附件版本、幂等、角色隔离与清理生命周期 |
| zz_observability.test.ts | 1 / 0 / 0 | 内部用量、脱敏、归属、生产执行禁用、错误输入和 outbox 原子性 |

原 #1013 gate `1794418350450-38278111` 的 749 文件回执继续 failed。本次没有执行全量门禁、真实模型、浏览器、支付或生产环境。

## 改动与断言

使用与 #1084 完全相同的 test-authoring-source.ts（Git blob `ae31c871b79d2f89467dffe3a49c769f795cfc36`），准备有效合成 DOCX，经过实际上传、完成、采用、原稿声明与输入锁定，再走当前 credit-quote，仅补报价短缺的合成积分。OCR 的自定义 origin 继续传入 helper。

OCR 的 PNG 与提交记录的 audit PDF 均保留，并和新加的原稿一起锁在第一个输入修订。提交记录的 materialVersions 按 API material_id/material_version 规范顺序排序，避免随机 UUID 导致原 deepEqual 间歇失败。可观测性场景把原 Azure Blob 注入应用，让新增上传与既有快照共享实际存储。

三个测试文件的 **143 条原 assert 表达式逐字相同**（OCR 33、提交记录 49、可观测性 61）。直接内部 queryUsage/usageTotals 的数字断言不变；原 skip 条件、超时和全部后续断言保留。生产规则、定价、迁移与 exclusions 均未改，也未启用 legacy fixture。三文件继续使用真实 Azurite；没有改用 helper 内存 Blob。

## 原失败与本次准确版本

原门禁源码 `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2` 的三个文件均在期望正常 run 返回 202 时收到 422 INPUT_REQUIRED：

- [原 OCR TAP](api-observability-admission-20261112/original-ocr.tap)：1 pass / 1 fail / 0 skip。
- [原提交记录 TAP](api-observability-admission-20261112/original-user-submissions.tap)：1 pass / 1 fail / 0 skip。
- [原可观测性 TAP](api-observability-admission-20261112/original-zz_observability.tap)：0 pass / 1 fail / 0 skip。

本次测试前 rebase 至 develop `867dbb22988a450cda05a004cdc2589ff68a7f9c`。三测试在该基线与原门禁的 Git blob 一致，但旧回执属于旧版本，没有冒充本次重新执行的 red。本次固定源码三个完整文件执行一次，得到 [最终 TAP](api-observability-admission-20261112/final-test.tap)。之后只增加验收材料。

## 环境与复现

- 原缓存 runner、PostgreSQL 16 Alpine、Azurite 3.35.0，按不可变镜像 ID 运行并指定 --pull never。没有安装或更新依赖。
- Node v22.23.3、TypeScript 5.9.3、pg 8.23.0、Fastify 5.12.5。缓存 package-lock 和 Git raw 源码只差精确 CRLF/LF 换行，前检通过。
- 完整 6430 个跟踪文件逐一核对 raw Git blob。构建 contracts、domain、rule-pack-registry、rule-applicability-context 后，以原严格 API tsconfig 定向编译三测试、helper 和通过 Worker URL 动态加载的 upload-inspection-worker.ts；执行前确认动态 worker JS 存在。
- 专属 internal 网络，无 host 端口。合计上限 1 CPU / 3 GiB：runner 0.65 CPU / 2304 MiB、PG 0.2 CPU / 512 MiB、Azurite 0.15 CPU / 256 MiB；PG 和 Blob 均为合成数据 tmpfs。
- 独立迁移 bb1090_template，各完整文件使用独立克隆库，串行执行：

```sh
node db/migrate.mjs
node --test --test-concurrency=1 \
  apps/api/dist/ocr.test.js \
  apps/api/dist/user-submissions.test.js \
  apps/api/dist/zz_observability.test.js
```

结束后按精确正则 `^bb1090_template_t[0-9]+_[0-9a-f]+$` 检查克隆库为 0；确认 runner 仅剩 sleep，立即按精确容器 ID 删除三个本任务容器与 internal 网络，并复查不存在。其他测试资源未修改。

准确版本、执行命令/耗时、143 条断言核对、raw/lock 核验、镜像和清理证明见 [proof.json](api-observability-admission-20261112/proof.json)。TAP 展示副本只去除行尾空白和文件末尾多余空行；proof 同时保存原始/展示 SHA-256，原字节日志留在本地证据目录。

## 范围外的 47 个 A 类文件

原 A 类 54 文件中，先前 4 文件由 #1084 处理，本次处理 3 文件，以下 47 文件未纳入本次通过结论。其中 review-workspace/review-materials 由 #1053 单独处理，不能据清单推定都尚无人修复，也不能在没有同版本全量门禁的情况下声称全部通过。

execution-key、project-list、project-collection、project-kind-conversion 涉及已有输入/旧单 Word/转换竞态，仍需按 11-05“新任务必填，已有任务保留原输入”分别审查；未机械补 historical 使转换恒拒、未改成果计数过关。zz_log_ops 本轮也未修改。

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
- `apps/api/src/target-confirmation.test.ts`
- `apps/api/src/working-draft-parse-admission.test.ts`
- `apps/api/src/zz_log_ops.test.ts`
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
