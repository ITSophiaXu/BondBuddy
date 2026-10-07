# M4 API、DB 与账务边界审计（2026-10-06）

## 范围与环境

工作区基线为 `3725dd53b1504d7fd8e45b37c3b55252490d3b89`，本地 API／contracts／迁移提交为 `c85b724`。审计 `apps/api/src/m4-workspace.ts`、`m4-billing.ts`、`data.ts`、`review-workspace.ts`、`queue.ts`、`provider-results.ts`、公共 M4 contracts 及新增迁移 0091～0096。旧 `/runs/execute` 的准确任务类型与 canonical 检查由主 agent 接入；本文件的 handoff 集成已实测旧更新及复核入口。没有部署、远端写入或客户材料操作。

本地实测环境为 Windows PowerShell、Node **v24.14.0**、独立 PostgreSQL synthetic 模板数据库及每次测试自动克隆。API 集成使用私有内存 Blob 与真实生成的 synthetic DOCX，不访问生产 Blob，不需要 Azurite。本地 Node 版本与 Node 22 部署基线不同，此记录不声称已经验证生产运行环境。

## 关键边界结论

| 边界 | 核对内容与证据 |
| --- | --- |
| 项目互斥与 QA 并行 | 执行前先检查本话题已有非 QA 任务，再锁定授权源／底稿派生的 canonical scope，并查同 scope 非终态业务任务。DB `bb_m3_project_run_mutex` 对任何入口维持同 scope 非 QA 互斥。API 已有活动业务任务返回 `PROJECT_RUN_ACTIVE`，保存／版本／NOWAIT 重叠仍为 `INPUT_REVISION_CONFLICT`，页面不透传后端原消息。测试覆盖同源跨话题、创建后另选同源不能绕过、不同源独立、运行中保存后继输入不改当前快照；免费 QA 在文书运行期间完成。 |
| 显式跨业务采用 | 用户核对新建更新／复核目标后，`handoffs/bind` 重新验证 owner 话题、原 user 消息 ID／version、来源 project／material ID／version／hash及目标 owner／kind；服务端派生 canonical，不接受客户端 scope。无固定来源不能绑定，只能在页面采用意图。绑定只改目标 scope／draft 并写同事务 outbox，无文件复制、任务或积分预留；同 scope 重复只读幂等。测试覆盖外账号、不存在资源、assistant 冒用、缺来源、旧 pin／伪 hash、已删除材料／项目、目标历史业务任务和其他 canonical 重绑定负例。 |
| Lineage 与并发 | 已被其他业务用作 canonical 的目标不得重新绑定；已被采用为 canonical 的 M4 话题换源须另建话题，防止形成多跳 scope 或拆散已有分组。文书执行锁定并重新读取准确源项目 scope，防并发绑定后使用旧 scope。NOWAIT 避免旧 target→canonical 与新增项目锁交叉等待；测试实际占用 target 锁，得到冲突后释放并成功再次采用。真实 M4 generation 运行时，目标更新和复核的数据库 INSERT 及实际 API 均拒绝创建业务任务，QA run 可同时创建；原任务取消后更新可开始，复核仍与该更新互斥。 |
| 模板与引用授权 | API 和 worker 重新校验 owner、源项目、准确 ID／version／hash。模板文种／市场和准确材料 pin 匹配；任务要求来自同话题准确助手消息。模板、消息、执行快照和成果不可变。私有下载重新核对长度和 hash。测试包含跨账号资源隐藏、准确材料 v1／v2、伪 hash 拒绝、准确 artifact 下载。 |
| 自然语言幂等 | 明确自然动作固定免费意图 run 和文书报价 proposal；宿主核对当前版本、实际要求／字段、报价、余额和互斥后才创建文书任务。相同 submission key 返回同 QA run；文书请求和 quote 只绑定一次。完整已保存字段／要求（包括 ISO 日期别名）不增加版本，可一次执行；真实新字段／要求或新 pending 要求增加版本，只保存且不使用旧报价启动。 |
| 已完成结果与未知用量 | 正文／说明或 QA 文本先凭真实交付证据可见。用量缺失／冲突不当作零成本，不写成功扣费；预留保持 held，已知结果可以预览、准确下载和引用。恢复须实际 metering 齐备，复用已固定结果；一份供应商 attempt 只采用一份权威用量。测试覆盖 usage pending 文本、0 settle、准确下载／hash、引用讨论、伪 hash 拒绝、晚 usage 后原调用恢复并仅一次结算。 |
| 费用与能力说明 | M4 共享真实钱包，采用原按量 A／B 封顶规则，与 M2 fixed credits 分开。未发布真实成本率／预算时无默认价。未选文种的任务准备、未开放文种／局部／实时公开法规检索等返回免费能力反馈，不建用户预留；基础定义、材料解读、计算仍用实际 QA 类别。明确两期比较优先于指标计算关键字，比较两期资产负债率为 Q04／K=4，本期资产负债率计算为 Q03／K=3，测试同时核对分类与实际报价。 |

审计发现并交给 worker 修复的两处 API／worker 不一致：`artifactReference` 曾限定原 run 必须 succeeded，导致已交付但待结算结果无法用于讨论；模板 gate 曾对摘要模板也要求非空券商。修复与 worker 定向测试证据由 worker 验收记录负责，不以 API 测试冒充 worker 已通过。

## 可复现命令

先以运行环境的安全配置设置 **`BB_TEST_DATABASE_URL`**，指向专用 synthetic PostgreSQL 模板数据库。不得指向生产数据库，也不要把连接凭据写入仓库或测试输出。测试自动克隆并清理临时数据库。

```powershell
npm run build -w @bondbuddy/api
node --test apps/api/dist/m4-workspace.pg.test.js
```

最后一次定向结果：**3 passed / 0 failed / 0 skipped**，约 **9.2 秒**。包含分类单元测试、扩展 M4 PostgreSQL 集成测试，以及独立数据库克隆中的完整 handoff／canonical lineage 集成。源 generation 经真实队列 claim 进入 `running` 后验证采用草稿仍可进行、目标更新／复核不得并行执行。`@bondbuddy/contracts` 与 `@bondbuddy/api` build 均通过。

适合最终统一执行的既有 API 相关回归：

```powershell
node --test apps/api/dist/m4-workspace.pg.test.js apps/api/dist/billing.pg.test.js apps/api/dist/review-billing.pg.test.js apps/api/dist/provider-result-validation.test.js
```

最终统一回归计数以 `docs/acceptance/m4-implementation-2026-10-06.md` 为准；还包括主 agent 的 `authoring-task-kind.pg.test.ts` 及相关复核回归。若另运行 `queue.test.js` 的 Blob suite，需设置安全配置 **`BB_TEST_AZURITE_CONNECTION_STRING`**；这不是本 API 集成测试的前置。不得将 missing connection 导致的 skip 记为通过。

付费更新／复核的旧报价随 binding 增加目标 draft_revision 而失效。既有 run 及旧免费输入快照仍按原输入保留，不能声称所有旧输入均已废弃；它们仍受当前 canonical mutex。复核原有的本项目活动 QA 限制没有在本轮扩展，新增同 canonical 检查明确排除 QA。

## 最终统一验收待办

真实 Codex CLI／供应商调用及用量、获授权业务样本、Word／WPS、专业内容、生产成本配置和发布环境分别验收。这里的模型输出、计量及业务数据均为 synthetic；没有声称真实 CLI、客户样本、行业签认或生产发布已经通过。
