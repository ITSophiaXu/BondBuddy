# 订阅与自动扣费验证

本页记录前一轮v2实现的验证。独立全面复核v3、历史价格保护及0134复核关联修复的最新验证见 [FULL-REVIEW-V3-VALIDATION.md](FULL-REVIEW-V3-VALIDATION.md)。前后测试有重叠，不累加为不同用例。

2026-10-29。Windows、Node 24.22.1、PostgreSQL 16.14、Edge headless。基于最新 `origin/develop` 的 `c7d0c42`，保留原商业计费提交，再实现订阅与自动扣费。未改变原工作区的未提交内容。

所有支付、续费、模型成果及账务样例均为 synthetic。数据库测试从空库迁移到0132的本机模板逐文件克隆，测试结束删除各自克隆；没有连接生产数据库、调用真实模型或支付商户。

## 已验证结果

|验证|结果|覆盖|
|---|---|---|
|全工作区 `npm run build`|通过|contracts、domain、registry、context、API、worker、Web；Vite保留原有大包体提示|
|`npm run check:contracts`|通过|65个测试、171个公开合成例、12个内部参考库例及4个生命周期例|
|`npm run test:unit -w @bondbuddy/web`|912通过、0失败、0跳过|含自动收费识别、请求恢复、未知响应、并发恢复、精确补差与旧行为|
|新计费、支付及经济台账专项|47通过、0失败、0跳过|见下方完整命令|
|最后对账修正定向复验|10通过、0失败、0跳过|重新编译contracts/API后，订阅及旧计费PG通过；待付款、付款后、取消后均账目守恒；此行与上面用例存在重叠，不作累加|
|历史计费PostgreSQL回归|24个不同用例验证通过|首组22通过；两处旧夹具补齐最新当前募集书前置后，所在文件3项复验通过，其中1项与首组重叠|
|浏览器|24通过、0失败、0跳过|19个账户/自动任务/旧账户用例，加5个真实页面业务操作用例；见UI-VALIDATION.md|
|空库迁移|通过|完整迁移链到0132；新的价格、订阅、退款和历史兼容约束均实际执行|
|`git diff --check`|通过|无空白差异错误|

新计费专项在设定 `BB_TEST_DATABASE_URL` 为隔离模板后执行：

```powershell
node --test --test-concurrency=2 apps/api/dist/automatic-billing.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/automatic-pricing.test.js apps/api/dist/subscriptions.pg.test.js apps/api/dist/payment-refunds.pg.test.js apps/api/dist/payments.pg.test.js apps/api/dist/commerce-economics.test.js apps/api/dist/commerce-economics.pg.test.js apps/api/dist/wechat-pay.test.js apps/api/dist/m4-fixed-billing.pg.test.js
```

历史回归文件为 `billing.pg`、`review-billing.pg`、`m4-fixed-billing.pg`、`outcome-billing.pg`、`commerce-coverage.pg`、`scope-standard-pricing.pg`、`scope-quotations.pg`、`project-scope-quotation.pg`、`integrity-scope.pg`。旧夹具修正仅增加当前募集书的采用与证据选择，保留原断言及生产前置要求。

## 关键行为证据

- 两个竞争执行只形成一个冻结，失败且释放后可以重新执行，过期范围也能产生新版本；原记录不可改写。
- 199元付款只发一次21,000积分，期限90天；退款冻结21,000积分、退199元现金，未知退款保留冻结。
- 已消费周期不走普通整期退款；取消保留已购积分；过期补偿继承原现金对价。
- 支付创建前失败仍保持未知，仅经渠道认证的过期/不存在回执解除原订单；签名缺失、网络错误不能解除。
- 旧周期迟到退款不关闭新周期或新授权；自动续费未知响应查询原订单，不再下单代扣。
- 旧加赠套餐不能新购，原订单重试保留权益；新充值统一1元100积分。
- 新检查完成后修订为0新增积分；修订交付V2重新检查仍为0；另行上传形成新范围；旧990积分检查升级只补1000积分。
- 文件包逐项价格版本保持一致；底稿少1积分返回402，不创建执行或冻结；新版M4报价沿原范围有效期保留，避免补款被旧5分钟期限截断。
- 原请求仅在同一账号、本机有效命名入口恢复，正文和幂等键保持不变；20341积分任务、19782可用积分准确预填5.59元补差。
- 所有业务入口的新模式均无需确认金额；未配置商户时显示不可购买，不产生模拟到账。

## 发布边界

`BB_SUBSCRIPTION_BILLING_ENABLED` 默认关闭。部署时API和worker必须使用同一代码版本并先执行迁移；既有批次按存储价格运行，关闭开关不删除订阅、付款、积分或历史流水。

现有微信Native只能单次收款。代码提供真实代扣能力接口及续费协调，只有配置具备签约、查询、解约和代扣能力的适配器才开放自动续费；现有渠道提供单期订阅及手动续期。

浏览器恢复依赖本机页面，并非支付回调后无页面参与的后台任务启动。真实商户支付/退款、专业成果质量、订阅留存与支付意愿需在上线验收中验证。单任务现金对价与成本字段不等于法定收入或公司税后净利润；本次没有用充值到账或积分面额伪造60%盈利结论。
