# Worker 图片与解析槽位夹具维护（#1128）

固定候选原样运行两文件的 3 项测试，得到 **1 pass / 2 fail / 0 skip**。两项均在执行入口返回 422 INPUT_REQUIRED，尚未进入图片恢复和解析槽位的原有检查。最终补齐来源、锁定输入、真实报价，以及调度夹具的显式 audit 解析入队后，完整原文件为 **3 pass / 0 fail / 0 skip**，进程耗时合计 31.733 秒。

## 版本与交付关系

- 原样受测候选：`a97e79473105d5b9061acf1b952b81a7c0bcca12`，tree `ee61983bac45828c538acb22fb894013a5e7203c`。
- 修复后受测集成源码：`6bd9481a3419eea6e554470136710c9ef9aa5d3f`，tree `c408fbd6224040040c450137e23d9fa9231349bb`。
- PR 基线 develop：`867dbb22988a450cda05a004cdc2589ff68a7f9c`；聚焦交付源码：`45cd0df9f65beb5b99574a3c0ceddd77c97eb1ed`，tree `867eba81f80dd7959fb95ae3127a92aef09f902f`。其后仅增加本验收文档与证据。
- 两个基线的原测试 blob 相同，完整补丁字节相同，修复后两个测试 blob 相同；见 proof.json 的 sourceMapping 和 patchSha256。
- **本次通过的是上面的集成源码，不是 develop 交付分支完整树。** PR 依赖 #1084 的现有 test-authoring-source helper（blob `ae31c871b79d2f89467dffe3a49c769f795cfc36`）；不复制该 helper，也不把整批集成代码带入本 PR。重新整合后的统一候选仍须运行完整 gate。

## 保留的测试范围

- 仅修改 model-image-stage.pg.test.ts 和 runtime-parse-slots.test.ts 的准入前提。原 28 条 assert 逐字同序保留，仅新增图片夹具首版 input_revision=1 前提断言。3 项原名称、skip、timeout 不变。
- 图片测试继续使用原自有内存 Blob、PNG、hash、image pin、5 秒 fake CLI timeout；保留重启恢复原图、交换/损坏图片不增加模型调用及 measured usage 断言。
- 解析测试保留原 first audit.txt，锁定输入同时含该材料与新增历史 DOCX；不以 helper 替换 audit.txt。原 synthetic parser、parseSlots=[1,0]、500ms 等待、heartbeat=2+parseSlots、parse-only 零 run 断言及所有 WorkerRuntime options 不变；第二项测试全文不变。
- unified_v1 按现有产品契约不自动创建辅助解析任务；调度夹具在原 audit 上传完成后，用现有 transaction + enqueueMaterialParse 显式入队原 first/next audit，使用实际 sha256/version。历史 DOCX 不入队，不交给 TXT-only synthetic parser；原 upload 返回值不变。
- helper 仅使用真实 synthetic 上传、声明、采用、当前报价及短缺积分前提；不修改生产入口、计价、迁移或模型行为。

## 保留的中间诊断

只补准入后的 `5ff2cd2b3393fa5604f0ec143a1077bd19e29edd` 首次为 2 pass / 1 fail / 0 skip，解析首项等待原 audit.txt 超时。没有延长等待。第二次保持该源码原样，仅在 harness 增加隔离 PG 只读 observer，结果仍为 2/3；存活 clone 的材料存在，但没有任何 parse job、parse event 或 parse snapshot，与 complete-upload.ts 的 unified_v1 不自动解析契约一致。随后仅在调度夹具中显式入队 audit。两轮失败证据和逐次观察原样保留；observer 在 clone 被 teardown 删除后的两个 3D000 读取竞争也如实记录，未补造已删除库的数据。

## 完整原文件结果

| 文件 | 当前候选原样 | 修复后 | 修复后耗时 |
|---|---|---|---|
| model-image-stage.pg.test.ts | 0 pass / 1 fail / 0 skip | 1 pass / 0 fail / 0 skip | 4.084 秒 |
| runtime-parse-slots.test.ts | 1 pass / 1 fail / 0 skip | 2 pass / 0 fail / 0 skip | 27.649 秒 |

## 验证与边界

1. 修复前后各用独立 PostgreSQL、Azurite、runner 与内部网络；每次核验 6,651 个 raw Git 文件，依赖 lock 仅有可核验的 LF/CRLF 差异。AST 审计保护原断言、测试 options、关键变量、parser 和 runtime 参数。
2. 每次删除旧 dist 后，严格构建 contracts、domain、rule-pack-registry、rule-applicability-context，以及 API 全部生产源码和 worker 两目标测试及其传递依赖；继承 strict，noEmitOnError=true。每次独立迁移后运行原 3 项，未用 test-name-pattern。
3. 真实 PostgreSQL/Azurite；图片模型为原 fake Codex CLI，解析为原 synthetic parser，没有真实模型调用，不证明真实模型质量。
4. 每次 runner 2 CPU / 2304 MiB，PG 1 CPU / 512 MiB，Azurite 0.5 CPU / 256 MiB；无发布端口。测试结束 clone 数均为 0，runner 只剩 init/sleep 后按精确 ID 删除所有本次容器及网络，并回查不存在。
5. 原 749 文件 gate 的失败 TAP、当前候选原样失败 TAP、两次中间失败和最终 TAP 均保留。展示副本只规范换行和行尾空白；raw 日志 sha256、逐 job 只读观察、构建/迁移退出码、源码映射及清理回执见 proof.json。完整本地材料位于 work/worker-material-admission-20261112。

这是 type:task 测试维护，不计新增产品 Bug。仅凭本次两个文件可将既有 A54 口径从 15 精确源码定向通过 + 2 #1053 候选覆盖证据 + 37 未纳入上述证据，更新为 **17 + 2 + 35 = 54**；这不是全量通过。原 749 文件 gate 仍 failed。代码与定向验证完成，未合并、未部署，用户未验收。
