# 订阅与自动扣费：支付恢复和财务整合验证

2026-10-29。本轮在`2d89ec9`之后进行，最终提交见PR #814。Windows、Node v26.13.0、本机隔离PostgreSQL、Edge headless。没有真实商户、真实客户交易、模型API支出或生产部署。

|验证|本轮结果|
|---|---|
|全工作区构建|`npm run build`通过；最后项目文件提示文案单独Web构建复验，见AUDIT-FIXES|
|公共契约|`npm run check:contracts`：65项测试、171个公开例、12个内部参考库例及4个生命周期例通过|
|前端单元|`npm run test:unit -w @bondbuddy/web`：913通过，0失败/跳过|
|支付/退款/订阅/经济台账组|44通过，0失败/跳过，完整命令下列|
|新增账户/底稿API|8通过，0跳过，见[AUDIT-FIXES.md](AUDIT-FIXES.md)|
|浏览器流程|27项通过；截图复跑与原流程重叠，不累加|
|部署配置检查|9项通过；源码8组组合检查见[部署记录](DEPLOYMENT-VALIDATION.md)，未运行Docker|
|财务模型|`calculate.mjs`的953项检查通过；`verify-contracts.mjs`的23项价表/订阅/成本快照一致性检查通过|
|迁移|原本机0134模板实际应用0135、0136及0137，测试按文件克隆该隔离模板|

支付组在已配置本机合成`BB_TEST_DATABASE_URL`后运行：

```powershell
node --test --test-concurrency=2 apps/api/dist/payment-reconciliation.pg.test.js apps/api/dist/payment-refunds.pg.test.js apps/api/dist/payments.pg.test.js apps/api/dist/subscriptions.pg.test.js apps/api/dist/wechat-pay.test.js apps/api/dist/wechat-refunds.test.js apps/api/dist/commerce-economics.test.js apps/api/dist/commerce-economics.pg.test.js
```

新增7项PostgreSQL恢复用例证明：

- 浏览器关闭或回调丢失仍可查原单入账；多实例领取及迟到回调只发一次积分；未配置商户不会被代查。
- 查询超时、原单身份不匹配不入账，保持原状态并退避；运营告警只记录服务端ID、类型、渠道和次数，不保存供应商原文或凭据。
- 已受理退款响应丢失后按原号查询；未知保持冻结，确认成功只销点一次。
- 冻结已提交但尚未首次派发的requested退款可以恢复；并发用户刷新和后台恢复只首次派发一次。
- 已记录派发但网络尚未发出的退款可以由明确支持幂等的适配器恢复同号原参数；无效或错配回执仍不释放冻结。
- 查询在途时若可信回调已结算，查询失败后读取当前终态，不作无必要重发。
- 关闭时停止启动后续已领取记录，未处理原单保留可恢复状态。

微信同号恢复依据为2026-10-29只读核实的[退款申请文档](https://pay.weixin.qq.com/doc/v3/merchant/4012791883)：“同一商户退款单号多次请求只退一笔”，重试保留原号及参数。[退款查询](https://pay.weixin.qq.com/doc/v3/merchant/4012791884)的`404 RESOURCE_NOT_EXISTS`不被当作可信失败或释放冻结的依据。恢复成功响应仍须通过既有验签和锁定身份/金额校验。

本轮发现并修复两个验证问题：旧退款fixture只允许一次网络提交，与新同号恢复语义冲突，现同时断言提交次数与唯一退款号数，并保留渠道幂等语义；新增运营告警最初被数据库旧类型约束拒绝，0137及公共契约现同步增加类型。最终44项组全部通过，前期失败及截图复跑不计入通过总数。

财务保留全部认可预算，不改变现价。原11项篮子345.14920元/计收人月；24个月保守/基准/乐观净收入163.55/237.37/311.18万元，税后经营净利-97.59/-24.82/+29.10万元，历史回收后余量-143.21/-70.44/-16.52万元。所有数字均为条件预算，不是真实留存/付费率或盈利承诺。完整计算见[报告](../../docs/finance/subscription-20261029/24个月条件估算.md)。

未完成项见[要求审核](REQUIREMENT-AUDIT.md)。尤其，底稿批检查仅关闭新版免费新执行，未完成逐份收费；真实商户、支付宝、签约代扣、关单/日账单和真实专业成果仍未验收。代码测试通过不意味着整个商业目标已完成。
