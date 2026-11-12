# 四项 API 回归准入夹具验证（#1073）

## 结论与范围

固定源码提交 `e39f1632a09bef23b7700cfa24ecdd2d3151b8d6`（tree `b4cad164652853ef84967be09c2355c9a7b85841`）的四个完整 API 测试文件 **13 pass / 0 fail / 0 skip**，串行命令耗时 151.716 秒。此处维护测试夹具，不计为新增产品功能 Bug。代码完成，尚未部署，待统一发布；用户验收尚未进行。

原 #1013 gate `1794418350450-38278111` 的 749 文件回执继续 failed。其 A 类共有 54 文件，本任务仅处理 4 文件；其余 50 文件不纳入本次通过结论。没有运行完整 gate、浏览器、真实模型、支付或生产环境。

| 文件 | 最终 pass / fail / skip | 保留的目标覆盖 |
|---|---|---|
| account-recovery.test.ts | 8 / 0 / 0 | 真实会话、重置后数据/任务保留、撤销旧会话、单次令牌、归属、事务回滚 |
| schema-rejection.test.ts | 1 / 0 / 0 | 非法请求的幂等与审计、归属、秘密脱敏、超大版本、outbox 原子回滚 |
| revision-range.test.ts | 1 / 0 / 0 | 正常任务后的超范围版本冲突、幂等、归属、CSRF、原子回滚 |
| library-admin.test.ts | 3 / 0 / 0 | 逐项安全导入、管理员权限、私有库信息不泄漏到 polling/SSE/Word、下载字节与归属 |

## 改动

共享 test-only helper 准备实际有效的合成 DOCX，经过上传、完成、采用、原稿信息声明和当前输入锁定；真实会话的 origin/cookie/CSRF 继续传递。执行前调用当前 credit-quote，检查绑定范围，并经 grantCredits 仅补齐报价短缺的合成积分。内存 Blob 保存实际字节，不访问 Azure。

library-admin 的成功夹具现在准备两份不同的合成 DOCX，分别保存 hash、回读 evidence 和 artifact，再写入同 run 的 word_delivery_pair；原有固定积分结算触发器照常执行。该部分是明确的合成交付证据，不代表执行了真实模型生成或质量审阅。

原有 261 条 assert 均保留：259 条表达式逐字相同；schema-rejection 的两条管理统计预期仅由数字 4/9 改为已批准 int64 wire 字符串 '4'/'9'，实际计数不变。没有修改内部服务的数字值、生产准入、定价、超时、skip/exclusions，也没有开启历史计费兜底。既有超过安全整数范围的协议测试未作任何更改，本次未额外重跑它们。

## 首轮失败与复验

原 gate 版本为 `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2`；本次基线为 `8a7dc38a9546831346805d8cb36ce88aae456da3`。这四个测试文件的 Git blob 完全一致，但两次运行版本不同，保留原门禁失败，不冒充本次重新执行的 red。

首轮固定提交 `2cc6a47d6c364b3cd2c7a802361b8ecd0f78b046`：**10 pass / 3 fail / 0 skip**，71.546 秒，失败 [TAP](execution-admission-fixtures-20261112/initial-test.tap) 保留。

- schema-rejection 到达管理统计后出现 '4' !== 4，随后只修正两项 wire 类型预期。
- library-admin 的手工成功夹具只有一份 Word，被真实结算触发器以 “Both generated Word files required” 拒绝，随后补齐双产物前提。
- library-admin 安全导入的有效 PDF 被拒，是本次定向编译遗漏通过 Worker URL 动态加载的 upload-inspection-worker 入口。最终编译显式包含此入口，并在测试前确认其 JS 产物存在；原导入断言和生产文档安全校验不变。

最终固定提交重新执行相同的四个完整测试文件，得到 [13 项通过的 TAP](execution-admission-fixtures-20261112/final-test.tap)。没有把不同版本的局部结果拼为全量通过。

## 环境与复现

- 缓存 runner：bondbuddy-pr1013-gate-runner:2eeea45c，镜像 `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`；没有安装或更新依赖。
- Node v22.23.3、TypeScript 5.9.3、pg 8.23.0、Fastify 5.12.5；独立 postgres:16-alpine，internal 网络、无 host 端口、无生产数据。
- 总限额 1 CPU / 3 GiB：runner 0.75 CPU / 2304 MiB，PG 0.25 CPU / 768 MiB。
- 构建前检查全部 6427 个跟踪文件的 raw Git blob；缓存 lock 与 raw 源码 lock 的区别仅为精确的 CRLF/LF 换行变换。首个 raw lock SHA 前检阻断也保留在本地证据中，没有跳过依赖一致性核验。
- 4 个依赖包（contracts、domain、rule-pack-registry、rule-applicability-context）按原配置构建。API 定向配置继承 apps/api/tsconfig.json 的严格设置，include 上述四测试、test-authoring-source.ts 和动态入口 upload-inspection-worker.ts。
- DATABASE_URL 和 BB_TEST_DATABASE_URL 指向本任务独立已迁移模板；各测试文件克隆私有数据库。命令：

```sh
node db/migrate.mjs
node --test --test-concurrency=1 \
  apps/api/dist/account-recovery.test.js \
  apps/api/dist/schema-rejection.test.js \
  apps/api/dist/revision-range.test.js \
  apps/api/dist/library-admin.test.js
```

最终克隆库清理核验为 0。首轮自写审计的 LIKE 错误匹配了模板名；改用精确克隆命名正则复核确认实际无残留，原审计错误不隐藏。本任务运行完成后清理自身两个容器和内部网络，不触碰其他验证资源。

准确版本、两轮命令结果、原断言核对、lock 换行等价核验、源文件 blob 与日志校验值见 [proof.json](execution-admission-fixtures-20261112/proof.json)。PR 中 TAP 展示副本只移除了行尾空白；原始字节日志保存在本地证据目录，proof 同时记录原始与展示副本 SHA-256。

## 剩余 50 个 A 类文件

本任务范围外。以下 review-workspace/review-materials 由 #1051 / #1053 单独处理；不能把本清单都视为尚无人修复，也不能在没有最终同版本门禁的情况下视为已经全部通过。

API 24 文件：

- `apps/api/src/execution-key.test.ts`
- `apps/api/src/issuer-identity-input-lock.test.ts`
- `apps/api/src/non-production-test.test.ts`
- `apps/api/src/ocr.test.ts`
- `apps/api/src/project-list.test.ts`
- `apps/api/src/review-linked-workspace.test.ts`
- `apps/api/src/review-price-activation.pg.test.ts`
- `apps/api/src/review-workspace.test.ts`
- `apps/api/src/zz_observability.test.ts`
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
- `apps/api/src/user-submissions.test.ts`
- `apps/api/src/working-draft-parse-admission.test.ts`
- `apps/api/src/zz_log_ops.test.ts`

Worker 26 文件：

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
