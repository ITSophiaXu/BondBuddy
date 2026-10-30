# 任务经营报表 exact-v2

2026-10-29。范围：可信内部 CLI 的精确管理口径，不修改价表、预算、客户付款/积分账本或线上 wire 合同。公开计费接口迁移仍按[独立审计](../product-decisions/2026-10-29-billing-int64-migration-audit.md)跟踪，尚未完成。

## 命令和版本

构建后，在配置了目标数据库的可信环境运行：

```text
node apps/api/dist/commerce-economics.js report RUN_ID
node apps/api/dist/commerce-economics.js expense EVIDENCE_JSON_FILE
node apps/api/dist/commerce-economics.js review REVIEW_JSON_FILE
```

`report` 只读；`expense` 和 `review` 保留原来的追加证据/审核语义、所有权查询和幂等键。以上命令不发起供应商请求、用户任务或付款。不要将生产凭据写入示例命令或文档。

`report` 和 `review` 输出 `report_version="commerce-economics-exact-v2"`。这是 CLI 输出的有意版本变更；下游脚本应先检查版本，再按以下类型解析，不能继续将旧字段当 JS number。

|字段|exact-v2 类型和单位|
|---|---|
|`model_attempts/billable_attempts/unpriced_attempts`|十进制整数字符串|
|`extra_cost_fen/fixed_budget_allocation_fen`|现金分整数字符串；存在非法费用证据时为 null|
|`delivered_service_charge_points/service_compensation_points/net_service_points`|名义积分整数字符串；净值可为负时应核对异常|
|旧 `delivered_service_charge_fen/service_compensation_fen/net_service_fen`|保留同值的**废弃名义积分别名**，改为整数字符串；名称不证明它是现金收入|
|`known_model_cost_native`|按原币分别输出精确十进制字符串；不把 USD 等原币隐式转换为 CNY|
|`variable_cost_cny`|精确十进制字符串；费用资料未闭合或审核缺失/失效时 null|
|`cash_consideration_fen/cash_compensation_fen/net_consideration_fen`|精确分数 `{numerator:"整数",denominator:"正整数"}`，单位分；资料不足时 null|
|`contribution_cny`|精确分数对象，单位元，允许负数；费用/对价不完整时 null|
|`contribution_margin`|无量纲精确分数对象；净对价为 0 或未核实时 null，不以 0% 代替|
|`actual_supplier_invoice_cost/after_tax_net_profit/after_tax_net_margin`|目前始终 null；此模块没有供应商账单、公司期间总账及税额证据|

例如，分数 `{"numerator":"13","denominator":"21"}` 表示精确的 13/21 分；不能先转 Number 再累加，也不能把 denominator 忽略。它可以包含无限循环小数，因此不能用有限小数文本充当权威值。

`expense` 输入格式未改：旧 `amount_fen` 数字仍要求安全整数且位于 0—10 亿分，以保留既有证据请求 hash 和重放行为。它不是公开 API int64 迁移的替代实现。数据库加载费用和成本时直接读取文本；供应商小数成本必须是十进制文本，已成为浮点数的非整数成本不会被当作精确费用。

## 精确计算依据

- 供应商成本读自原费用台账的 numeric 文本。解析成 BigInt 分子和十进制分母，逐笔精确累加。失败、取消和正常重试已发生的 billable attempts 保留，不再乘任何计划失败系数或 5% 预算准备。
- 消费直接读取每一条已结算 allocation 的 `p` 及 lot 不可变原对价 `A/Q`。逐片段计算 `A×p/Q`，化简并相加；不在 PostgreSQL 中先除成有限小数再求和。
- 冲正逐条读取 correction 事件及其来源 lot 保留的原 `A/Q`，再从原消费对价中精确减去。平台返还继承原支付依据，不按新充值比例计算；显式零对价活动来源为零，缺失依据为未知。
- 两个方向的片段积分合计必须分别等于总扣减/总冲正积分；缺片段、缺 A/Q、分母为零、超出原扣减或原对价等异常通过 `consideration_problems` 明示，净对价及贡献不输出可认定的盈利数。
- 固定预算分摊 `fixed_budget_allocation_fen` 单列；它不再次加入增量费用。这里只计算任务管理贡献，公司费用完整核对必须在公司期间层另做。

`cost_complete=true` 只说明本模块的费用类别、计量/费率、终态和当前快照审核满足要求；不表示真实供应商发票已经取得，也不表示收入和公司利润已被会计核实。对价完整性由 `consideration_complete` 单独判断。

## 展示舍入和历史审核

所有近似展示仅位于 `display_only`，并显式标记 `authoritative=false`。没有 Number 浮点兼容金额。

- 舍入：`nearest_ties_away_from_zero`，四舍五入、恰好中点向离零方向舍入。
- 现金分和元金额：固定 6 位小数；比例：固定 8 位小数。
- 元金额可为负；小到舍入后为零的负值显示为无负号零。展示精度和舍入方式随对象输出，不能作为对账或收入确认的权威数据。

`snapshot_hash` 纳入 exact-v2 算法版本、两个方向的原始对价片段、任务状态及费用证据。旧算法的审核 hash 不能批准新精确报表。原数据库中的旧审核和费用记录保持不变；`review_history.stale_snapshot_hashes` 返回仍保留的其他审核 hash，`current_snapshot_reviewed` 只认当前版本和当前事实。

首次使用 exact-v2 对已审核任务重新读报表时，旧审核会显示失效，需要以当前 `snapshot_hash` 新增审核。仍使用旧 expected hash 的 review 请求返回输入快照冲突。新增费用或更换原对价证据同样使审核失效，不会悄悄沿用之前的已核实状态。

## 验证范围

定向测试覆盖 Decimal 0.1+0.2、长小数、超 JS 安全整数的 int64、多个不能整除的 A×p/Q 片段、按原比例冲正、完整冲正后负贡献、零对价、未知费用/原币/分配缺失、展示舍入及旧审核不复用。PostgreSQL 集成测试核对追加证据、旧审核保留、新审核、幂等和晚到费用使审核失效。

测试是 synthetic，不代表真实发债项目用量、实际供应商账单、会计认定或 60% 公司净利润已验证。具体执行证据另附。
