# 任务定价与扣费：API / worker 核验

2026-10-30。源码已冻结，供本地集成与后续仓库推送引用。测试使用合成材料、内存 Blob 和独立 PostgreSQL 克隆；没有调用真实模型、支付渠道或客户材料。本文不证明真实成交、专业结论质量或公司净利润。

## 范围及结论

沿用已批准的 12 SKU、1.7 倍价表及原订阅合同价格保护。用户明确业务任务后，客户端后台取范围及价格、自动提交；服务端校验对象、版本、报价和余额，预留原积分批次，合格交付后结算。用户无需逐笔确认金额。成本、价格、订阅合同和原冻结迁移 0160 未在本阶段改动。

本次主链审计确认三个实际缺口，均已安排定向修复：M4 把部分独立业务问答误判为免费任务准备；退役底稿 assessment 仍可新建免费任务；付费复核失败后的组装恢复标记与终态账本约束不匹配。第三项由账本协作者修复，新迁移 0161 的测试及说明另见其报告。

## 产品入口与计费映射

|业务 / SKU|积分 / 独立单位|现有入口|服务端权威链|
|---|---:|---|---|
|一期更新 `quarter`|8,864|主稿 credit-quote → runs|锁定源 / 目标期间 → `classifyFixedPrice` → `reserveCredits`|
|年度更新 `annual`|20,341|同上|同上|
|两年补更 `two_year`|34,570|同上|同上|
|三年补更 `three_year`|52,374|同上|超过三个新增年度在冻结前拒绝|
|模板 / 市场迁移 `migration`|51,626|同上|锁定发行人关系、源 / 目标市场品种及期间|
|新项目编制 `new`|86,799|同上|一份新主稿及其内部必要工作；不按模型步骤拆单|
|关联文件 `related`|7,965 / 份|M4 quote / execute；project-files batches|已开放文种的固定 manifest → `quoteM4` / `reserveM4`|
|独立说明性底稿 `workpaper`|3,458 / 份|workpapers batches|用户所选条目；批次锁定价版，调度逐份预留，Word 交付后逐份结算|
|官网诚信核查 `integrity`|22,738 / 轮|integrity quote / runs|固定名单、官网、截至范围；每轮 1–5 个主体、至多 20 个官网|
|独立问题回复 `response`|1,218 / 题|project-qa quote / runs；M4 quote / messages|固定问题清单逐题；单条助手输入有明确多题时导向原问题清单|
|一致性检查与维护 `check`|6,095 / 份 / 轮|project-files check-batches、workpapers check-batches、受控旧检查入口|锁定主稿与逐份目标版本 → `reserveFileCheck`，各份交付分别结算|
|独立全面复核 `full_review`|27,195 / 份 / 轮|review-executions quote / execute|明确 full_review 操作、固定材料及复核范围 → `reserveCredits`|

辅助操作保持原规则：另行委托的差异复核、复核后原文修订各 14,900 分；没有伪装为第 13 个新 SKU。新检查已包含同轮修订及重新校验，新增积分为 0；旧已付 990 分检查升级修订只补 1,000 分。成功修订生成的后继版本依原付费证据继承维护权益；用户新上传版本、新主稿来源或已退款条目不能伪造原覆盖。

生产入口的自动收费模式强制开启编制及复核收费分支。后台范围快照和价版来自服务端，不接受用户或模型传入最终单价。单个父任务中的读取、准备、内部检查、支撑内容及平台重试不新增独立账单。正常上传、保存、浏览和下载旧成果不触发收费任务。

## 本次修复

### M4 免费范围

原来“已选文种 + 未命中少量分析关键词”会直接归免费。例如“请说明本期收入增长的主要原因”不选文种为收费问答，选择立项报告后却免费。本次去掉这条按上下文免单的兜底。

新分类区分产品操作帮助、明确文件任务及原话要求、独立业务问答、含糊待澄清。选择文种本身不改变同一道业务题的收费身份；明确文件生成只按成果收一次，不额外收取一次问题回复费。

- “保存任务要求：在募集书中说明收入下降原因”“把核对现金流作为本次任务重点”只整理原始要求。
- “更新募集书，并解释收入变化”作为文稿任务要求；免费回复仅返回受限任务信息，不直接交付分析。
- “保存任务要求，并分析现金流”中的独立分析仍按问题回复处理。
- “这个呢？”等含糊输入只澄清业务，不预留积分。
- 订阅、续费取消、月付转年付、充值、退款、积分有效期和账单操作帮助免费；涉及债券赎回、募集资金退款的业务问答不会因此免单。

Worker 对免费结果的正文、引用、字段及任务要求实施约束：只给产品操作路径、原话要求或澄清；不接受模型编造的业务结论、数字和字段。恢复已保存模型结果时同样校验这一约束，不能通过 replay 返回未经计价的完整分析。已有主稿任务的局部措辞限制仍可进入正确任务卡，不受材料工作区整份任务限制误挡。

明确多题清单、多问号、清楚分开的多主题问答导向现有逐题流程。单题附带依据、引用、计算方法或比较所需差额仍只按一题处理。此为可执行范围校验，不声称任意自然语言都能被完美拆题；含糊请求只澄清。

### 底稿 assessment 历史兼容

依据 `docs/product-decisions/2026-10-27-workpaper-batch.md` 已明确的直接生成决定，自动收费模式下拒绝新建退役 assessment。已有请求键的完全相同重放、GET 及历史结果仍可读取；同键改参数仍报幂等冲突。用户继续从正常底稿批次生成，已生成文件通过逐份收费一致性检查处理。本次没有为退役能力临时发明价格。

## 定向验证

所有以下命令均退出 0，最终测试无失败、无跳过。PG 使用 `bb_review_repair_20261030_a1` 作为只读模板，每个测试文件自行创建并清理私有克隆；没有修改本地演示账号或重启服务。

|验证|结果|原始日志|
|---|---:|---|
|API TypeScript 构建|通过|[API build](../subscription-billing-20261029/completion/task-billing-api-repair-build-20261030.log)|
|Worker TypeScript 构建|通过|[Worker build](../subscription-billing-20261029/completion/task-billing-worker-build-20261030.log)|
|12 SKU、取整、范围、分类及免费结果单测|13 / 13|[unit](../subscription-billing-20261029/completion/task-billing-intent-unit-final-20261030.log)|
|API / PG：维护覆盖、旧补差、质量退款、批次不足、退役入口与 M4 实际 HTTP|9 / 9|[API PG](../subscription-billing-20261029/completion/task-billing-api-pg-20261030.log)|
|Worker：任务卡、讨论、能力限制、免费结果及 replay 定向回归|6 / 6|[Worker free](../subscription-billing-20261029/completion/task-billing-worker-free-final-20261030.log)|
|既有复核组装恢复、证据重用及禁止新增模型调用|19 / 19|[Review reassembly](../subscription-billing-20261029/completion/task-billing-review-reassembly-20261030.log)|

测试命令：

```powershell
npm run build -w @bondbuddy/api
npm run build -w @bondbuddy/worker
node --test --test-concurrency=1 apps/api/dist/m4-task-intent.test.js apps/api/dist/automatic-pricing.test.js
# PG 命令在安全本机测试环境中设置 BB_TEST_DATABASE_URL，配置不入库。
node --test --test-concurrency=1 apps/api/dist/automatic-m4-boundaries.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js
node --test --test-concurrency=1 --test-name-pattern='global assistant CLI|M4 QA receives exact execution proposal|M4 semantic guard|new opinion types|M4 unavailable requests|free assistant output' apps/worker/dist/m4-stages.test.js
node --test --test-concurrency=1 apps/worker/dist/review-reassembly.test.js
```

初轮 Worker 回归发现主稿局部要求被材料工作区限制误挡，原失败日志保留于 `completion/task-billing-worker-free-20261030.log`；修复后 13 项单测及 6 项 Worker 定向回归均通过。API / PG 的 9 项已通过，随后仅修正上述主稿任务分类并以单测和 Worker 集成验证覆盖。

## 变更归属与交接

本报告对应的源码为 `apps/api/src/m4-workspace.ts`、`automatic-pricing.ts`、`workpaper-assessments.ts` 和 `apps/worker/src/m4-qa-stage.ts`；定向测试为 `m4-task-intent.test.ts`、`automatic-m4-boundaries.pg.test.ts`、`automatic-file-billing.pg.test.ts`、`m4-stages.test.ts`。`git diff --check` 无错误。

API / worker 源码及测试已冻结。根代理负责统一升级本地服务、结合 UI 与模拟充值验收，并按用户要求推送仓库。利润测算在上述阶段完成后单独继续。
