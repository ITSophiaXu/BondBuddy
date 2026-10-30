# 支付恢复、检查交付与精确成本增量验证

2026-10-29，承接d0cc10b。全部支付、用户、模型结果和usage均为synthetic；没有实际商户收款/退款、DeepSeek支出或生产部署。本记录仅说明本轮开发和验证，完整剩余要求见[审核清单](REQUIREMENT-AUDIT.md)。

## 实现与交叉审查

- 支付宝PC/WAP显式配置，固定官方SDK 4.14.0；对原始响应内容验签、form通知、原订单查单/关单/退款。现金证据独立验证，未知保持原请求及冻结。复核修复了退款标识与账本字符集兼容、响应流取消问题。商户必须实际具备买家退款字段返回能力才能启用，详见[支付宝证据](ALIPAY-WEB-EVIDENCE.md)。
- 订阅/续期/充值意图按账号持久化，跨标签串行；未知响应不会改请求号。交叉审查修复历史价格快照被当前套餐拒绝、旧标签收到paid事件后误开新单两个问题。任务返回上下文随原付款保存。账户区分任务冻结与退款冻结，详见[付款恢复证据](CHECKOUT-INTENT-AND-HOLDS.md)。
- 普通关联文件与底稿采用相同的完整提取/覆盖门：正文、页眉、附注等读取不足，或明确未检查的占位结果，不可结算。通用凭据不可修改、绑定原输入及源目标hash；数据库交付门不能仅凭结构正确的报告通过。
- 覆盖凭据在adapter保存模型完成记录前持久化，已完成模型结果可以重放而不丢失结算依据。普通Word实测用实际CodexDurableJournal保存合成模型结果，模拟完成记录后中断，恢复后复用原模型结果，最终只扣一次。
- 经营报告exact-v2使用精确十进制与BigInt有理数，消费和冲正保留原A*p/Q；旧审核hash不能批准新算法。供应商账单实付和公司净利润保持null，详见[精确成本证据](ECONOMICS-EXACT-V2.md)。

独立全面复核仍按规划成本7.5454800512元经两次向上取整为27,195积分（标价271.95元）；原11项价表、订阅价格及已认可预算未改变。该规划成本不是本轮DeepSeek实测。

## 根工作区验证

Node v26.13.0；本地PostgreSQL空模板此前完整迁移至0143，本轮增量执行0144，各文件克隆隔离库；Word使用既有Python运行时。全工作区构建通过，随后对最后变更的API、Worker和Web完成对应重建。现有Web bundle体积提示仍存在。

|验证范围|结果|口径|
|---|---:|---|
|contracts|65通过；171公共/12内部示例及生命周期检查通过|25+29+11，0失败/跳过|
|Web单元|924通过|0失败/跳过；含7项新持久购买意图测试|
|订阅账户浏览器|19通过|Edge、Vite 5187、合成HTTP响应，0失败/跳过|
|订阅PG|10次测试执行通过|9个业务子测试+1个父测试，0失败/跳过|
|支付宝、微信、原支付与后台恢复|35通过|共享最终API构建；合成验签和隔离PG，不是真实渠道|
|文件自动扣费/旧范围报价/历史底稿混合|15通过|普通报告缺覆盖证据时无法结算，旧付费修订权益保持|
|Worker检查与覆盖|16次测试执行通过|6个证据单元、2个业务PG、8个导入的catalog辅助测试；不把辅助项称为新增业务场景|
|部署配置检查|11通过|源码/配置检查；本机无Docker，未声称容器或发布镜像验收|
|精确成本|19通过|子任务使用同一共享构建、Node v24.22.1；18单元+1隔离PG，见独立日志|

根验证命令：

```text
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
node --test apps/api/dist/alipay-pay.test.js apps/api/dist/payment-provider-config.test.js apps/api/dist/alipay-pay.pg.test.js apps/api/dist/wechat-pay.test.js apps/api/dist/wechat-pay.pg.test.js apps/api/dist/payments.pg.test.js apps/api/dist/payment-reconciliation.pg.test.js
node --test apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/api/dist/project-scope-quotation.pg.test.js apps/api/dist/workpaper-legacy-checks.pg.test.js
node --test apps/worker/dist/project-file-evidence.test.js apps/worker/dist/project-file-paid-coverage.pg.test.js apps/worker/dist/workpaper-paid-checks.pg.test.js
node --test scripts/check-payment-deployment.test.mjs
```

PG命令均设置BB_TEST_DATABASE_URL指向本地synthetic模板；Worker另设置BONDBUDDY_TEST_PYTHON。子任务的订阅PG/浏览器最终组和原始日志在[付款恢复证据](CHECKOUT-INTENT-AND-HOLDS.md)，重跑不与本表重复累计。

已人工查看本轮[桌面冻结分项](completion/checkout-screenshots/subscription-separated-holds-1440.png)和[390px手机冻结分项](completion/checkout-screenshots/subscription-separated-holds-390.png)：任务预留200分与原路退款冻结21,000分分别展示，订阅与充值入口保持原布局，没有逐任务金额确认。截图使用合成余额和订单；首次新增PG用例因测试fixture未绑定reservation到run失败，修正fixture后完整通过，初次日志亦保留。

## 发布及未完成事项

0144保留原覆盖数据、将旧表名变为只读兼容用途的view。旧worker的INSERT ON CONFLICT不能对该view运行，部署须停止旧worker并启动同一新版本，不能滚动混跑；详见部署runbook。旧有效报价、原钱包和已付维护权益不因迁移重写。

普通多文件仍是一个run/合并报告，尚未实现逐项部分成功结算；原稿要求的全量int64字符串API、价格草稿/审核发布权限、客户质量退款审批、资金不变量破坏后隔离恢复等仍未全部完成。当前已获授权的商户配置位置尚未提供；真实代扣适配、支付验收和专业成果质量仍待验证。

商业结论保持原记录：基准24个月税后经营净利-24.82万元，历史回收后-70.44万元，尚未达到60%净利目标。开发测试通过不会改变愿付、留存或利润假设。
