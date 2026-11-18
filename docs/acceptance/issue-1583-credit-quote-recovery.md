# Issue #1583 募集书更新报价恢复

## 根因与只读核对

已用只读事务核对 issue 指定项目的输入、报价、范围和任务元数据。仓库报告仅保存故障机制，不包含客户金额、精确操作时间、项目标识、材料正文或输入 hash。

输入内容不变但 input_revision 递增时，范围报价按 input_hash 复用，原 credit quote 仍绑定旧输入版本。索引 `bb_scope_credit_quote_identity` 对 `(owner_user_id, scope_quote_id)` 唯一，后续报价插入被 `ON CONFLICT DO NOTHING` 跳过；再按新版 input_revision 查询为空，`quoteDto` 读取缺失 `input_hash.trim()` 产生 500。任务尚未创建。跨项目切换是复现路径，版本与范围身份不一致是直接原因。

## 修复

1. 0192 新增迁移：编制报价按 `(owner, scope_quote_id, input_revision)` 唯一，复核报价保持一个 scope 一条报价。原报价、输入、scope、价格和账本保留。
2. INSERT RETURNING 优先读回已插入的准确记录；冲突只读同 owner/project/revision/price/scope 的报价。无法匹配时返回现有 `409 QUOTE_CHANGED`，不挪用旧版报价。
3. API 按整个编制 scope 检查是否已有积分预留；数据库新增不可变 scope-reservation 关联及唯一约束，回填历史预留。包括旧 API 和无 work-plan 的人工范围报价，均不能通过另一个输入版本重复预留/扣费。
4. 复用现有错误码与前端恢复行为，无页面、公共 DTO、价格或新依赖变化。

## 与 PR #1594 的关系

#1594 是部分修复，给空记录加 409/503 分支；未更改 scope 唯一索引，原项目重新保存后仍不能形成可执行的新版本报价。本 PR 包含相同故障的保护和完整版本关联修复，与其 billing.ts 代码重叠。集成时保留本 PR 的 INSERT RETURNING、准确版本查询、防重约束与实际恢复测试；不能把同输入新版应成功的回归改回恒定 409。

## 验证

环境：本任务独立 Docker 网络、PostgreSQL 16、Node 22.23.2；合成输入与积分，真实 Fastify HTTP 注入和 PostgreSQL。复用本机测试镜像依赖，覆盖为本分支 API / packages / db 源码。Windows 检出中的历史 SQL 在测试副本统一为 Git/Linux LF 后执行，测试仅连接本任务隔离库，线上只读取证与测试分开，未修改生产或其他本地验收库。

- 原代码 + 原索引的相同输入重保存对照：1 项预期失败，HTTP 实际 500（原始问题稳定复现）。
- API、contracts、domain、rule-pack-registry、rule-applicability-context 构建通过。
- 6 个 PostgreSQL 文件共 21/21 通过，0 失败/0 跳过：automatic-billing、outcome-billing、billing、review-billing、scope-quotations、billing-int64。
- 自动复核和标准范围计费另 6/6 通过，0 失败/0 跳过。合计 27 项。
- 对齐 develop e7ce930f 后，API 再次构建通过，5/5 核心定向回归再次通过；27 项原回归使用同一修复的 79c7b367 基线，新增上游提交为独立的 provider-reconcile 修复。
- 公共契约 72/72；179 个公共 + 12 个内部合成样例、4 个生命周期样例通过。
- 新增 5 项回归覆盖并发重复报价、跨项目切换与同 hash 的第 2/3/4 版恢复、旧索引冲突 409、历史数据不变与迁移回填、人工范围跨版本防重复预留（包括直接旧写入路径的数据库拒绝）。

执行命令：

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
node db/migrate.mjs
npm run check:examples -w @bondbuddy/contracts
node --test --test-concurrency=1 apps/api/dist/automatic-billing.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/api/dist/billing.pg.test.js apps/api/dist/review-billing.pg.test.js apps/api/dist/scope-quotations.pg.test.js apps/api/dist/billing-int64.pg.test.js
node --test --test-concurrency=1 apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/scope-standard-pricing.pg.test.js
```

测试仅声明报价、输入版本和账务链路通过；未运行生产模型生成、真实付款、浏览器全流程或最终 Word 质量验收。最终统一验收待办：集成版真实页面继续更新；指定发布 chat 执行本批生产发布后，核验原项目可获得当前版本报价并开始任务。

## 发布与回滚

代码完成后仍需本地集成与用户验收、指定发布 chat 统一上线。本次不执行生产迁移或服务切换。

发布需要 API 与迁移 `0192_authoring_scope_quote_input_revision.sql`。数据库新增范围预留约束保护新旧代码交叠期间；旧 API + 旧索引仍保留原故障。旧 API 在新 schema 下可按新版输入读回报价，但缺失结构化异常保护，不能作为修复验收版本。

回滚应用时保留新 schema 和历史不可变数据。已有多输入版本报价后不得恢复旧唯一索引、删除旧报价或修改历史账本以强行回滚。
