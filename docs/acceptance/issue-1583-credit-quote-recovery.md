# Issue #1583 募集书更新报价恢复

## 结论与根因

本地报价与任务启动修复已验证。相同材料重复保存为新输入版本后，可以取得匹配版本的报价并创建一个更新任务；并发重复提交只预留一次积分。代码完成，尚未部署，待统一发布。

已用只读事务核对 issue 指定项目的输入、报价、范围和任务元数据。仓库报告仅保存故障机制，不包含客户金额、精确操作时间、项目标识、材料正文或输入 hash。

输入内容不变但 input_revision 递增时，范围报价按 input_hash 复用，原 credit quote 仍绑定旧输入版本。索引 `bb_scope_credit_quote_identity` 对 `(owner_user_id, scope_quote_id)` 唯一，后续报价插入被 `ON CONFLICT DO NOTHING` 跳过；再按新版 input_revision 查询为空，`quoteDto` 读取缺失 `input_hash.trim()` 产生 500。任务尚未创建。跨项目切换是复现路径，版本与范围身份不一致是直接原因。

## 修复

1. 0192 新增迁移：编制报价按 `(owner, scope_quote_id, input_revision)` 唯一，复核报价保持一个 scope 一条报价。原报价、输入、scope、价格和账本保留。
2. INSERT RETURNING 优先读回已插入的准确记录；冲突只读同 owner/project/revision/price/scope 的报价。无法匹配时返回现有 `409 QUOTE_CHANGED`，不挪用旧版报价。
3. API 按整个编制 scope 检查是否已有积分预留；数据库新增不可变 scope-reservation 关联及唯一约束，回填历史预留。包括旧 API 和无 work-plan 的人工范围报价，均不能通过另一个输入版本重复预留/扣费。
4. 复用现有错误码与前端恢复行为，无页面、公共 DTO、价格或新依赖变化。

## PR #1594 对照与恢复结果

精确 PR #1594 提交 `5c63a5d6926adcaa592586d6c4fbb78d6e89bdca` 单独归档、构建并在保留旧索引的独立数据库验证。该 PR 原 7 个测试通过，但业务恢复用例失败：重保存后的六次报价全为 409，项目没有 run 或 reservation。它只消除了空值 500，未解决新版输入无法获得报价的问题。

本 PR #1598 的持久回归 `apps/api/src/authoring-quote-recovery.pg.test.ts` 使用相同业务路径，并继续验证实际执行和账务结果：

| 步骤 | #1594 | 完整修复 |
| --- | --- | --- |
| A 上传参考稿和审计材料、保存、报价、启动 | 200 / 202 | 200 / 202 |
| B 首次保存及报价，返回 A 再回到 B | 200 | 200 |
| B 相同材料保存为第 2、3、4 版，每版两次报价 | 六次 409 | 六次 200；同版报价 ID 相同，均绑定正确版本 |
| 用旧报价执行最新版本 | 409 | 409，未创建任务 |
| 用最新报价并发提交同一 execution_request_id | 无可用新版报价 | 两次 202，返回同一个 run |
| B 最终任务与预留 | 0 / 0 | 1 个 run、1 个 reservation、1 个 scope claim |
| 历史报价、材料与余额 | 报价旧版、材料保留、未预留 | 原报价全行不变、两份材料保留、仅冻结一次准确报价金额 |
| 取消合成任务 | A 已取消 | A、B 均通过 API 取消，预留全额释放 |

其他用户请求本项目报价返回 404；credit-charge 回读绑定第 4 版和最新 quote。六次报价不产生积分预留。

两个 PR 的 billing.ts 代码重叠。集成时保留本 PR 的 INSERT RETURNING、准确版本查询、防重约束与实际恢复测试，不能把同输入新版应成功的回归退回恒定 409。

## 固定版本与最终验证

- 最终测试代码：`0cbb632a14890fe622662fefe8d2de6c2a051cc9`，基于 develop `5d7c3e5f2212cd504562bb75eaed17ec57a65de6`，已包含刚合入的审计 PDF 清晰度检查。之后仅更新本报告。
- Node 22.23.2、PostgreSQL 16.15、本任务独立 Docker 网络和数据库。Git 归档覆盖容器 API / packages / db，9 个修复及上游相关源码的 LF 标准化 SHA-256 与候选一致。
- 真实 Fastify HTTP 注入、上传/保存/报价/执行/取消处理器和 PostgreSQL；材料、账号、积分均为 synthetic。上传字节为合成 DOCX 参考稿和文本审计材料，私有 Blob 使用内存夹具。
- API、contracts、domain、rule-pack-registry、rule-applicability-context 构建通过；对齐最终 develop 后，变动的 contracts 和 API 重新编译通过。
- 最终固定候选的 9 个 PostgreSQL 文件：**28/28 通过，0 失败、0 跳过**。包括 6 个本次新增回归，以及现有支付余额、失败重试、取消释放、复核、范围报价和大整数账务测试。
- 公共契约 **72/72**，另加上游相关 PDF 契约 **2/2**；均 0 失败、0 跳过。179 个公共 + 12 个内部合成样例、4 个生命周期样例通过。
- 原代码 + 原索引对照已稳定复现 HTTP 500。早期新增 HTTP 用例曾因合成账号名超长而未进入业务流程；仅缩短夹具账号名后复跑通过。原日志保留，最终 28 项完整运行全部通过。

可复验命令（BB_TEST_DATABASE_URL 指向本任务独立、已迁移的模板库；各测试自行创建并删除数据库副本）：

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
node db/migrate.mjs
node --test --test-concurrency=1 apps/api/dist/authoring-quote-recovery.pg.test.js apps/api/dist/automatic-billing.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/api/dist/billing.pg.test.js apps/api/dist/review-billing.pg.test.js apps/api/dist/scope-quotations.pg.test.js apps/api/dist/billing-int64.pg.test.js apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/scope-standard-pricing.pg.test.js
npm run check:examples -w @bondbuddy/contracts
node --test packages/contracts/dist/pdf-quality.test.js
```

本地证据保存在本任务工作区：`work/issue1583-develop-validation/`（最终候选、归档哈希、源码哈希、构建、28 项数据库测试及契约日志）；`work/issue1583-http-recovery/`（对齐前完整 HTTP 验证及夹具修正记录）；`work/pr1594-validation/`（#1594 独立失败对照）。Windows 检出中的历史 SQL 在测试副本统一为 Git/Linux LF 后执行，避免旧迁移的换行文本匹配问题；未修改已部署迁移。

## 发布与最终统一验收待办

本次完成开发与自动化自测，不等于本地集成版或用户已验收。未启动模型或生成 worker，未验证真实支付、浏览器全流程或最终 Word 质量，也未执行生产迁移或服务切换。

发布需要 API 与迁移 `0192_authoring_scope_quote_input_revision.sql` 同批交付。数据库新增范围预留约束保护新旧代码交叠期间；旧 API + 旧索引仍保留原故障。旧 API 在新 schema 下可按新版输入读回报价，但缺失结构化异常保护，不能作为修复验收版本。

回滚应用时保留新 schema 和历史不可变数据。已有多输入版本报价后不得恢复旧唯一索引、删除旧报价或修改历史账本以强行回滚。

最终统一验收待办：集成版真实页面继续更新；真实 worker、模型生成及可下载 Word；用户实际验收。指定发布 chat 获本批授权并发布后，再核验原项目可取得当前版本报价并开始任务。
