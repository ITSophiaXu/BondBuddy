# 计费 int64 接口迁移审计（2026-10-29）

状态：**已实施新接口协议与账本精度迁移，尚未部署。** 初次只读审计基线为 `d0cc10b`；下文“原基线”说明发现问题时的行为，不能当作当前实现状态。当前分支以 `int64-decimal-v1` 为默认线上格式，保留受限的 `number-v1` 历史读取与原请求重放。

## 已实施的迁移

- `billing-integers.ts` 定义非负 int64、范围检查与格式化；`billing-wire.ts` 用显式 DTO 路径转换，`billing-wire-routes.ts` 统一 API/客户端路由与 OpenAPI。金额、积分、计费累计量为规范十进制字符串，不扫描任意文档 JSON 字段名。
- API 在解析新金额请求时拒绝 JSON number、指数、小数、负数与溢出；响应序列化仍执行原 schema 过滤。OpenAPI 生成独立现代组件，不改变历史 manifest/输入快照及 hash。
- 账本余额、逐 lot 分配、累计发行及冲正使用 BigInt；允许合法 int64，发行时检查累计范围。渠道有界单笔字段经 `safeBillingNumber` 明确窄化，不先舍入再转字符串。
- 前端金额/积分加减与格式化使用精确数。新持久化意图为 v2；旧 v1 保留原请求体、请求号、金额与 digest，用原协议核实或重放，不能变成新购买。
- `number-v1` 不是新交易入口：仅允许可精确表示的旧读取及已持久化、同 owner/资源/request 的原请求重放；原业务 handler 继续验证 hash。新默认请求无需客户端猜测数值大小。
- 试用运营累计 token、日志累计用量也纳入显式 DTO；固定配置、分页、普通版本号和渠道业务上限维持原语义。

测试覆盖高于 `MAX_SAFE_INTEGER` 的精确读写、累计溢出原子回滚、旧意图与跨版本重放、响应字段过滤以及各任务页面。具体执行结果见本分支 `evidence/subscription-billing-20261029/completion/` 与要求审核。兼容协议仍保留用于原意图恢复，不宣称旧客户端已全部退场。

## 依据与边界

用户提供的《BondBuddy 付费系统开发 Spec｜1.7 倍｜v1》原附件第 163 行要求积分/现金分采用 int64 并检查溢出，成本用 Decimal；第 186 行要求在线 API 中积分、现金分及累计数采用十进制整数字符串，前端用 BigInt/精确库。仅配置文件及验收观察值中的小整数可保留 JSON number。第 83 行没有本版业务累计充值上限；渠道及法定限制仍由适配层落实。第 235 行要求消耗/冲正按原 lot 的 A×p/Q 精确归属。

原附件路径：`C:\Users\lezhai\.codex\attachments\458610f2-676b-45b8-b43e-b4523d448d12\Pasted text.txt`。行号仅用于此次原稿审计。

原基线多数合同为 `Type.Integer`/`number`。当时的安全整数检查能避免部分静默舍入，但不满足指定 wire 格式，也未提供完整 int64 范围的账本读写支持。以下记录保留该审计依据。

## 必须覆盖的字段族

所有源码路径相对仓库根目录。以下包含嵌套响应，不能只改钱包和退款顶层。

|合同文件|迁移范围|
|---|---|
|`packages/contracts/src/billing.ts`|CreditBalance `available/frozen`；FixedQuote `points`、响应 `shortage`；订单/目录 `amount_fen/points`；消费历史 `reserved_points/charged_points/released_points/corrected_points`；充值历史金额/积分|
|`commerce.ts`、`outcome-pricing.ts`|`amount_fen/unit_amount_fen/unit_price_fen/price_fen/price_points`；account 的现金/积分类余额；topup 金额；ScopeLine/ScopeQuotation；`base_amount_fen/owned_coverage_fen/due_fen` 及嵌套 pricing items|
|`subscriptions.ts`|目录金额和额度；账户及分类余额；每期 `amount_fen/points/available_points/held_points`；checkout 内嵌订单|
|`payment-refunds.ts`|两种退款请求、预期金额；退款 DTO；原实付、原发行、累计已退、冻结退款、剩余可退现金/积分|
|`authoring-progress.ts`、`m4-workspace.ts`|`accrued_points/charged_points/released_points/available_points`；M4 quote、balance、shortage|
|`integrity.ts`、`project-qa.ts`|expected points；报价、workspace price；run 预留/扣减；响应 manifest 内积分和 CommerceMetadata|
|`project-file-workspace.ts`|批量创建、检查、更新请求中的 expected points；批量和各文件报价；检查结果、文件 update points、workspace 内嵌金额|
|`workpapers.ts`、`workpaper-library.ts`|expected/total/charged points；余额不足恢复的 required/available/shortage；检查批次与 item 金额|
|`admin-logs.ts`|若按原 Spec 的全部在线累计数验收，consumption/metrics 的累计次数和 token 也需迁移；其实现 `log-ops.ts:1027–1033` 当前使用 Number 累加|

计费数量 `ScopeLine.quantity`、`CommerceMetadata.units` 建议一并规范化；其他普通页数、版本、分页 limit、时长和非累计业务计数应按语义区分，禁止通过字段名正则对任意业务 JSON 盲目转换。倍率与成本小数、A×p/Q 分数使用各自的 Decimal/有理数格式，不转成整数。

`QaInputSchema`、Integrity manifest、scope lines 同时用于持久化快照与 API。需要分开内部/历史 schema 和线上 DTO，不能直接修改同一 schema 使既有历史快照失效。

## 原基线的精度行为与限制

1. `apps/api/src/billing.ts:15–21` 把 SQL 聚合转 Number，再检查 `Number.isSafeInteger`；超过安全范围返回 503。这里主要是合法 int64 余额无法读取/消费，不是已经证明普通支付会静默多扣钱。单次 `grantCredits` 有 10 亿积分上限，账户累计未设置相同上限。
2. `apps/web/src/credit-wallet.ts:32` 相加可用和冻结积分。两数 `9007199254740991` 与 `2` 分别安全，JS 合计却为 `9007199254740992`，正确值为 `9007199254740993`。
3. `billing.ts:116` 逐 lot 使用 `Number(remaining)-Number(frozen)`。历史/full-int64 lot 若 remaining=`9007199254740993`、frozen=`9007199254740991`，SQL 可用 2、冻结数也能通过安全整数检查，但 JS 差值为 1；预留会分配不足并回滚。普通当前发行入口的单 lot 上限使这一例不等于公开可利用的资金盗用。
4. `credit-history.ts:55–58、68`、subscriptions 的各期 DTO、其他任务 DTO 仍把 bigint 文本转 Number。现有单任务/单订单上限通常使普通数据保持精确，但 wire 仍不符合合同。
5. 退款公式已经用 BigInt，公开请求/响应和 UI 输入仍是 Number；正常单笔 100 万分、115 万积分的边界不能被误报为当前日常退款已发生大整数错误。
6. `commerce-economics.ts` 基线版本在成本、对价和合计上转 Number。它当前仅可信 CLI，没有在线报表 route。这是经营计算精度问题，单独修复，不混称钱包漏洞，也不替代本接口迁移。

数据库 lot/事件/订单主体已用 bigint；PostgreSQL `sum(bigint)` 返回 numeric，因此聚合仍需要显式范围检查，不能以列类型推定合计不会溢出。

## 原审计提出的实施路线

### 阶段 1：精确基础类型和领域边界

- 非负 int64 十进制字符串使用规范形式 `^(0|[1-9][0-9]*)$`，语义检查 `<=9223372036854775807`；正数/单笔业务上限使用派生校验。新 wire 拒绝 number、小数、负数、指数写法及溢出。
- 账本聚合、分类余额、逐 lot 差值、分配和累计量使用 BigInt/SQL 精确整数；发行/聚合检查表示范围。
- 原有受限配置及渠道要求的数字可在适配层检查后窄化。产品 DTO 不复用渠道 PaymentOrder 数字格式；不得先丢失精度再转成字符串。

### 阶段 2：全部计费线上合同

- 一次明确版本的 wire 合同覆盖上表全部请求、响应、嵌套历史及 workspace。可使用独立 v2 路径或统一版本协商；不能按数值大小随意混用 string/number。
- 通过显式字段/DTO 编码规则覆盖全部金额，补齐目前只有 TS interface 的嵌套响应 schema。
- 保留现有输入、价格、manifest、scope 的不可变快照及 hash。新 wire 在边界精确规范化后进入现有领域语义，不重写 JSONB 历史记录。

### 阶段 3：前端和已有请求兼容

- `apps/web/src/api.ts` 是公共入口，`m4-api.ts` 也使用它；统一协商版本及解码。
- 同步更新 `commerce-price`、wallet/history、subscription page、refund input、所有相关任务 workspace、workpaper 和恢复模块。加减比较使用 BigInt；分/元格式化用整数商/余数，不经 Number。
- `billing-task-recovery`、`commerce-refunds`、QA/integrity 的持久化恢复记录带 wire/storage 版本。旧请求保留原请求号、金额和 digest，按原版本重放或查询，不重新生成付款/执行意图。
- v1 兼容期只能返回可精确表示的 number；超范围明确要求升级。该兼容期本身不能被描述为全部线上 API 已达标。

### 阶段 4：验收和退场

- 覆盖 MAX_SAFE、MAX_SAFE+1、INT64_MAX、超限/负数/小数拒绝，以及所有字段族的 JSON 类型断言。
- 检验钱包合计、上述逐 lot 差值、聚合范围、混合 lot、退款原单比例、同幂等键 v1/v2 重放、旧浏览器恢复和历史 manifest。
- 渠道单笔上限不变，数据库/账本/支付对账守恒不变。
- 仅当 wire、精确账本读写、前端消费者、历史兼容和旧版本退场全部闭合时，才可宣布 int64 接口迁移完成。

初次审计仅执行只读搜索与算术示例；其后的代码实施范围见本文开头。所有支付验证为本地合成数据，不能代替真实商户验收。
