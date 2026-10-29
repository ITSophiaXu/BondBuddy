# 独立全面复核v3与历史价格保护验证

2026-10-29。此次增量基于 `df2a22e`。所有支付、材料与报告均为合成夹具；没有连接生产、调用DeepSeek或发生真实支付。本次仅开发、测试并更新既有草稿PR，不启用生产收费。

## 价格与行为

- 标准成本预算 `7.5454800512元` → 基准分向上取整 `15,997` → 乘1.7向上取整 `27,195积分`。成本来自历史模拟与明确新增的服务/查询假设，不是已测供应商成本。
- 新v3价表共12项；只新增全面复核的公式价格。差异复核、另行委托的原文修订各14,900积分，独立显示任务名；一致性维护不替代全面复核。
- v2已付订阅当期、有效旧报价、已接受批次保留旧版本；取消不提前终止本期锁价，90天积分期限不延长月度价格保护。
- 新增0133价表迁移，保留旧行；0134修复复核执行版本与报价草稿版本不同导致再次执行被拒的问题，以实际冻结、报价和复核执行关联核验。

## 验证结果

|项目|结果|
|---|---|
|工作区构建|`npm run build`通过；范围文案更新后API/Web重新构建通过；最后的价表常量整理另重编contracts/Web并复验价格单元测试|
|契约检查|`npm run check:contracts`通过，65测试、171公开合成例、12内部例及4生命周期例|
|Web单元测试|`npm run test:unit -w @bondbuddy/web`：912通过、0失败、0跳过|
|计费、版本兼容与历史回归|下方13文件组合：53通过、0失败、0跳过|
|浏览器|17通过；最后范围文案修改后3项重验通过，与17项重叠不累加。见[FULL-REVIEW-V3-UI.md](FULL-REVIEW-V3-UI.md)|
|数据库迁移|新空白本机测试库完整执行至0133，再执行0134成功；各PG文件从此库克隆，结束自动删除各自克隆|
|成本复算|Python标准库脚本，基准和四个成本压力断言通过，无API调用|
|差异检查|`git diff --check`通过|

复验设置 `BB_TEST_DATABASE_URL` 为已迁移本机合成测试模板，运行：

```powershell
node --test --test-concurrency=2 apps/api/dist/automatic-pricing.test.js apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/automatic-price-versions.pg.test.js apps/api/dist/automatic-billing.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/subscriptions.pg.test.js apps/api/dist/review-billing.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/api/dist/commerce-coverage.pg.test.js apps/api/dist/scope-standard-pricing.pg.test.js apps/api/dist/scope-quotations.pg.test.js apps/api/dist/project-scope-quotation.pg.test.js apps/api/dist/integrity-scope.pg.test.js
```

## 关键断言与发现

真实HTTP与本机PostgreSQL路径验证全面复核报价27,195分且不创建任务；余额不足返回402且无任务/冻结；补足后两个相同请求返回同一任务；交付合成报告及Word成果后仅结算一次。同一项目再次独立复核可执行，失败释放全部冻结；另行原文修订仍冻结14,900分，失败释放；总账重建守恒。

新增测试首次因合成用户名过长未到业务路径，修正夹具后继续。随后发现第二次复核的草稿报价版本为1、执行输入版本为2，旧范围关联函数错误要求两个计数相等。0134新增严格的付费复核关联，同时保留原分支及旧零价规则；测试验证原报价不能绑定另一个新执行。修复后上述53项通过。

版本测试通过合成历史v2待支付订单和真实入账事务，确认付款后及取消续费后仍使用v2的14,900分；未付款不获得价格保护。新非订阅与新订阅使用v3，API目录与扣费一致。有效旧报价不可改写且仍可受理；内部批次价格上下文在成功、异常退出后均清理。

标准价计算使用BigInt精确两阶段取整，价格注册表与SQL发布行一致。原11项保持不变。历史检查维护修订与平台修订后继版本仍可复用已付权益；旧9.9元检查仍只补10元。

## 限制

当前DeepSeek费率、全面复核真实usage、专业成果质量与用户支付意愿未由这些测试验证。冷缓存、扫描资料和支持增加均列入成本压力，不自动抬高已锁定任务价格。单项毛利参数不能证明公司60%税后净利润。

`BB_SUBSCRIPTION_BILLING_ENABLED`默认关闭；微信Native仍为单次收款/手动续期，只有真实签约代扣适配器具备能力时才开放自动续费。本次未部署、未创建真实订单、未进行代扣。
