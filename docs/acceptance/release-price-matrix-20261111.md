# 任务类型与价格版本的模拟模型测试覆盖盘点

日期：2026-11-11。审计提交：`0c533ffc17cbca6b2fb6cf064339b0e115b4558d`。状态：**仅静态检查现有测试源码，没有执行这些测试、模型或数据库迁移。**

本盘点配套[老账号升级验收方案](release-upgrade-plan-20261111.md)，回答哪些任务类型已有类似诚信核查、项目问答的价格兼容测试，以及另一个测试 PR 应补什么。现有源码的测试意图不能表述为本候选已经通过；条件跳过的 suite 也不能算已验证。本文不修改产品代码、公共契约、迁移或价格政策。

## 判定口径

“完整链路源码”指测试经实际 API 接受报价、创建任务和冻结，进入该任务的真实 worker 输入门禁，再用合成模型或站点响应完成交付/失败和账务断言。“部分”指只有报价、接受、冻结或结算函数层面的断言，缺该价格版本对应的 worker 路径。“未见”表示本次定向源码检查没有找到等价测试，不代表产品必然不支持。

下面的“完整”仅描述源码覆盖范围，不表示执行通过，不表示真实模型输出质量通过，也不表示跨应用版本迁移已经验证。测试用 synthetic 输出属于模型替身，API、PostgreSQL 和 worker 门禁仍应走真实实现。

版本常量在 `packages/contracts/src/automatic-pricing.ts:2–4`：

- v2：`bb-task-price-170-20261029-v2`。
- v3：`bb-task-price-170-20261029-v3`。
- 当前 v4：`bb-task-price-scope-20261111-v4`。

旧固定价、人工审核报价、管理员发布的商业价和合同/标准范围价是不同来源，不能因为积分数相同就互相代替。历史 M4 用量计费也不能称为“旧固定价”覆盖。

## 覆盖矩阵

| 任务类型 | 旧固定价 | v2 | v3 | 当前 v4 | 人工审核报价 | 管理员发布价 | 合同/标准范围价 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 诚信核查 | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 | 完整 |
| 项目问答 | 完整 | 未见 | 未见 | 完整 | 完整 | 未见 | 完整 |
| 募集书更新 | 部分 | 未见 | 未见 | 部分 | 部分 | 未见 | 部分 |
| 复核 | 部分 | 部分，仅范围报价 | 未见 | 有正常 worker 链路，未显式断言版本 | 部分 | 部分，仅新旧报价 | 未见 |
| 底稿生成 | 有旧链路源码，fixture 与新默认不一致，待核实 | 未见 | 未见 | 部分，API 接受/不足/续跑 | 未见独立案例 | 部分，仅锁价包跨新价发布 | 未见 |
| 普通文件检查 | 部分 | 未见 | 未见 | 完整 | 未见独立案例 | 未见 | 未见独立合同价案例 |
| 助手付费回答 | 历史用量链路不能等同固定价覆盖 | 未见 | 未见 | 部分，报价/冻结/取消 | 部分，仅报价函数 | 未见 | 未见 |

## 源码证据和缺口

### 诚信核查

`apps/worker/src/integrity-pricing.pg.test.ts:92` 的 `integrity ${mode}: accepted quote reaches actual Word delivery, settles once, and exports free` 明确参数化 `legacy/reviewed/automatic/automatic-v2/automatic-v3/managed/coverage`。其中 `automatic` 使用当前 v4，管理员价格经真实发布函数建立，站点结果是合成响应。

第 97 行调用真实 `integrityInputGate`；第 103–110 行覆盖暂停、报价过期、新价发布后的恢复；第 112–120 行覆盖终态、冻结释放、准确实扣和结算幂等。第 133 行起还有失败/取消、已释放冻结、金额及 scope 绑定篡改的拒绝场景。第 235 行起专门验证旧 v3 draft-only 报价在当前 v4 下继续执行。这些是其他任务可复用的覆盖标准。

### 项目问答

`apps/worker/src/project-qa-pricing.pg.test.ts:91` 的 `QA ${mode}: accepted price passes worker, delivers Word and settles once` 仅参数化 `legacy/reviewed/automatic/coverage`，没有 v2、v3 或 managed。

第 96–107 行覆盖真实输入门禁和金额、版本、归属篡改拒绝；第 109–121 行覆盖交付、准确余额、一次结算及免费续答；第 127 行起覆盖自动价失败、取消和重新接受报价后重试。优先在此现有 harness 补有效历史 v2/v3 和管理员价，验证新价发布后已接受任务继续按原额完成。

### 募集书更新

- `apps/api/src/billing.pg.test.ts:18`：`paid API: insufficient funds, recharge, concurrent execution, settlement, failed/cancelled release and price changes`。
- `apps/api/src/automatic-billing.pg.test.ts:36/47/60/72/100`：自动报价、竞争接受、HTTP 元数据、报价替换后读取和失败重试。
- `apps/api/src/outcome-billing.pg.test.ts:64`、`apps/api/src/scope-standard-pricing.pg.test.ts:102`：审核价和标准范围价。

这些通过 `reserveCredits`、`claim`、`finish` 或直接改变 run 状态验证账务，没有把各个价格版本的正式接受结果送进更新 worker 门禁。`apps/worker/src/file-authoring.pg.test.ts:124` 和 `unified-authoring.pg.test.ts` 有 worker 流程，但请求没有 `quote_id`，不能作为价格矩阵的等价证据。需要将真实接受报价、输入门禁、synthetic 生成、成果和结算连成一条测试。

### 复核

`apps/api/src/review-billing.pg.test.ts:15` 覆盖旧固定价 API/结算；`apps/api/src/automatic-review-billing.pg.test.ts:14` 覆盖 27,195 积分自动报价、结算和失败释放。两者都直接 `claim/finish`，不能证明 worker 接受该价格版本。

`apps/worker/src/review-project-e2e.pg.test.ts:23` 的 `project review: real dual Word delivery, explicit promotion, manual export, idempotency and owner isolation` 在第 44–54 行包含真实报价、提交、`inputLockStage`、交付和 `credit-charge`，第 80–91 行包含失败释放。但没有显式断言价格版本，也没有历史版本参数化。

`apps/api/src/automatic-price-versions.pg.test.ts:92` 名称虽称 v2 quote remains executable，实际只到 `requestScope/assertScopeQuote`，没有创建和执行任务。`apps/api/src/billing-price-admin.pg.test.ts:32` 只证明管理员新价影响未来报价、原报价保持，没有执行 worker。应扩展完整复核 harness，而不是以这些 API 测试代替执行兼容验证。

### 底稿生成

`apps/worker/src/workpaper-paid-checks.pg.test.ts:38`、`workpapers.pg.test.ts:19`、`workpaper-shared-stage.pg.test.ts:29` 有旧价的实际 worker/结算测试意图；但存在需先核实的 fixture 差异。

例如 `workpaper-paid-checks.pg.test.ts:44–45` 用 `server(false)` 期望旧业务，未指定新增的 `historicalBillingFixture: true`，仍使用旧 assessment 和 `WORKPAPER_PRICE`。`apps/api/src/server.ts:166–170` 明确只有该 fixture 标记才允许测试历史价格；普通 `enableSubscriptionBilling: false` 不能再切回旧价。尚未执行，不能据静态差异宣称实际失败，也不能把旧测试设计当成当前代码已覆盖。

`apps/api/src/automatic-file-billing.pg.test.ts:255/269/350` 有新价余额不足、异步续跑、已锁定底稿包跨管理员新价发布后的接受，仍缺完整 worker → ZIP → 文件数 → 账务的版本参数化验证。后续测试 PR 应先修正/确认历史 fixture，再补当前价和有效历史已接受任务的完整路径，不能为适应旧测试修改生产价格开关。

### 普通文件检查

`apps/worker/src/ordinary-file-check-batches.pg.test.ts:20` 的 `ordinary file batches settle independent outputs, retain original price on failed-only retries and isolate requests` 在第 44 行执行实际 pipeline，第 76–103 行验证部分成功、失败释放、原价重试和精确余额，第 105–133 行验证零价复用、混合批次和不可用旧成果拒绝。`apps/worker/src/project-file-paid-coverage.pg.test.ts:89–119` 补充完整覆盖才能结算。

上述完整 harness 按当前自动价运行，未显式循环历史 v2/v3/managed。`apps/api/src/automatic-file-billing.pg.test.ts:122` 虽有旧 990 点和新价两分支，第 72 行明确属于 API-only synthetic host coverage，不能代替 worker 门禁。后续应将完整 harness 参数化，尤其保留失败重试按原价、不重复扣成功文件的断言。

### 助手付费回答

`apps/api/src/automatic-m4-boundaries.pg.test.ts:12` 的 `HTTP selected-document answers charge the response SKU; preparation and unclear inputs cannot buy or bypass an answer` 覆盖 1,218 积分报价、余额不足、冻结、幂等及取消释放，没有执行回答 worker。

`apps/worker/src/m4-pipeline.pg.test.ts:36` 有历史 M4 文档/问答 durable pipeline，第 156–173 行覆盖历史用量计费、未知用量恢复和结算。该 suite 的 server 未启用 `historicalBillingFixture`，仍保留 4,500 旧文档价和历史计量断言；需要先核实 fixture，不能据此认定当前 v4 助手回答链通过。

`apps/api/src/outcome-billing.pg.test.ts:111` 对 `m4_Q01` 只断言审核后报价 1,831，实际 reserve/结算执行的是文档任务，不是 QA。需补 selected-document 回答的真实接受、worker 门禁、synthetic 回答、交付和精确结算，文档任务的成功不能替代回答任务。

## 单独测试 PR 的建议范围

本方案 PR 不补测试。后续另开以 `develop` 为 base 的测试 PR，只修改测试、夹具和对应文档，按以下顺序补齐：

1. 在项目问答现有完整 harness 增加 v2/v3/managed。
2. 将更新和复核的 API 接受报价连到真实 worker gate，以 synthetic 模型完成及结算；为复核显式断言当前和历史版本。
3. 核实并修正底稿和助手的历史测试 fixture；分别补旧已接受合同和当前新任务的完整路径。旧计量价格必须保留其真实语义，不能机械改成“固定价”。
4. 将普通文件当前完整 harness 参数化到有效历史 v2/v3/managed，验证部分失败及失败重试保持原报价。

每种被产品支持的历史合同至少断言：正式接受记录及输入锁定一致；报价过期或新价发布后仍按接受时金额执行；worker gate 在模型调用前通过；交付后准确结算一次；刷新/下载/幂等重放不重复扣款；失败或取消正确释放。价格、归属、scope、输入 hash 被篡改或冻结已释放，应在模型调用前拒绝并且不扣款。

不能为凑齐矩阵虚构历史上不存在的 SKU/价格组合。遇到无法由历史正常接口或可信 test-only helper 建立的组合，登记具体限制并保留缺口，不改公共契约或绕过门禁。如果执行时确认属于产品问题，按 `docs/BUG-REPORTING.md` 单独提报，不能在测试 PR 中修产品或放宽断言。

实施前依旧遵守本机环境检查及与 PR #1013 的串行测试要求。这些模拟测试不消耗真实模型额度，但需要独立的数据库/存储和相关依赖；运行报告应列出命令、固定提交、实际用例数/跳过数、耗时及结果，不能把未具备依赖而全部 skip 写成通过。
