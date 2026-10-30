# 计费、扣费与充值：可操作的本地验收版本

2026-10-30。按用户最新要求优先完成可测试的计费系统。真实商户、自动续费签约和模型质量验收分别跟踪，本轮没有真实支付或模型调用。

后续账户体验增量已加入年付9折按月发额、月／年自动续费和取消、实时充值积分预览、支付卡自动收起及主流产品页面参考。当前运行服务已升级至0159，保留原测试数据。最新专项、原型对照和真实浏览器链路见[账户体验验收](../subscription-billing-20261030/ACCOUNT-EXPERIENCE.md)；下文原29／35／17／10项记录仍为对应旧增量的实际结果，未冒称全部重新运行。

## 本地入口

- 测试台：<http://localhost:5189/__billing-test>
- 产品账户：<http://localhost:5189/#/account>
- 专用账号 `billing_tester` / `Local-Test-2026!`；首次注册0积分，自动验证使用其他随机账号，不消耗该账号。
- [启动说明](../../scripts/billing-functional/README.md)与[手动测试步骤](../../scripts/billing-functional/MANUAL-QA.md)。停止保留数据库、余额、订单和合成成果。

这个入口运行当前产品 Web、API、真实登录和 PostgreSQL 钱包。测试渠道查询提供合成付款回执，随后仍通过产品原有入账函数处理；独立全面复核的合成Word通过真实任务交付结算，失败走真实释放。测试台不直接改余额，不向正式商户发送请求。它没有部署到生产，也未配置完整模型生成栈。

## 本轮验证

|范围|结果|证据|
|---|---|---|
|核心订阅、充值、自动计费数据库回归|29项通过，0失败、0跳过；每套使用隔离数据库|[日志](completion/billing-functional-core-20261030.log)|
|产品账户和自动任务页面回归|35项通过；这组采用既有页面测试夹具，不冒充真实后端联调|[日志](completion/billing-functional-browser-20261030.log)|
|本地测试台的真实HTTP与数据库|17项通过，含认证边界、0余额、订阅/充值、幂等及交付/失败|[报告](completion/billing-functional-http-20261030.json)|
|浏览器点击真实Web/API/数据库|10项通过，另用随机账号，未拦截或替换浏览器API响应；桌面1440与手机390检查通过，0页面未处理异常|[报告](completion/functional-manual-20261030/browser-result.json)、[日志](completion/billing-functional-live-browser-v2.log)|
|测试台会话续期与禁止不明结果重放|1项专项测试、7个场景通过；真实过期会话成功续期后沿用同一正文，仅产生1个任务及1笔预留；403/500/断网/刷新失败通过明确的浏览器故障注入验证不重放|[报告](completion/panel-session-verification-20261030.json)、[测试](../../scripts/billing-functional/panel-session.test.mjs)|
|真实复核页面补款后自动恢复|9项检查通过；产品实际开始、差额充值、到账回跳和同请求自动重放，无浏览器响应或恢复记录注入；真实HTTP取消后完整释放|[报告](completion/product-recovery-20261030/result.json)、[脚本](../../scripts/billing-functional/product-recovery-verify.mjs)|
|最终API TypeScript构建及公共契约检查|通过|[API构建](completion/alipay-normalized-api-build-final.log)、[契约检查](completion/billing-functional-contracts-20261030.log)|

真实浏览器路径：0积分 → 轻量订阅21,000 → 100元测试充值后31,000 → 全面复核冻结27,195，可用3,805 → 成功结算后可用仍3,805、冻结归零 → 原请求重放不再扣费 → 300元充值后33,805 → 新任务失败释放后恢复33,805。刷新和重新读取账户保持同一账本。

首轮测试台页面检查发现本地辅助查询误读 `bb_runs.error_code`，导致登录后账本读取500；已移除该不存在字段并重启测试进程，真实HTTP及浏览器全链复验通过。首轮日志保留，不将该次失败算为通过。产品数据库/鉴权没有为测试被关闭或改写。

截图：[冻结状态](completion/functional-manual-20261030/reserved-desktop.png)、[成功和失败流水](completion/functional-manual-20261030/ledger-desktop.png)、[手机账户](completion/functional-manual-20261030/account-mobile.png)。这是独立开发测试台，不是新增产品导航或正式客户界面。

另已收尾支付宝CSV配置子集与日期补证：当前API构建通过，解析器最新15项通过，新增8项PG及旧4项经过夹具修复均有通过证据；空库/升级共159个迁移。见[对账说明](ALIPAY-NORMALIZED-RECONCILIATION.md)及[解析边界](ALIPAY-CSV-NORMALIZATION-20261030.md)。本地功能测试没有因此依赖真实支付宝凭据。

当前运行环境为Windows、Node v26.13.0、Edge及本机PostgreSQL。先前Node22发布镜像验证有独立历史版本记录，不代表本次新增源码已经在生产镜像或真实商户环境验收。

会话续期修复只涉及本地测试台，没有修改生产鉴权；专项测试使用独立随机账号并通过真实失败结算释放其预留，没有调整演示账号余额。无需重启当前服务，刷新测试台即可使用。手动测试第9步已更正：测试其他订阅档位使用新的账号，原账号当期结束后才能手动续期；本期额外用量用充值补充。

随后修正自动验证器的演示账号假设：`verify.mjs` 不再读取演示账号或要求其余额为零，避免用户正常充值后误报失败。新增检查只按本次随机账号及订单／任务ID核验付款、预留、积分来源和成果归属；对已有成功测试账号进行只读核验4/4通过，语法检查通过，没有重跑整套HTTP测试、创建新账号／任务或修改账本。上表17项HTTP结果仍是此前版本的实际运行记录。见[只读验证](completion/functional-verifier-ownership-readonly.json)。

## 产品补款恢复与本地取消接口补齐

使用独立随机账号，材料准备后打开产品真实复核页面：一次开始请求返回402，未创建任务和预留；账户预填差额271.95元，模拟付款到账后自动返回原页面，第二次执行请求的正文hash和执行键与第一次一致，成功响应为200。最终数据库只有一笔已付订单、一个排队任务和一笔27,195积分预留；刷新不重复提交；真实HTTP取消后预留归零、已扣积分为0、可用恢复27,195。实际浏览器未处理异常0、模型调用0，付款仍为合成回执。

验收发现本地服务原未设置 `enableSyntheticQueue`，使产品取消端点报 `CAPABILITY_NOT_READY`；已在本地启动配置开启该选项，仅开放实际队列控制，不启动模型worker。为加载此项，使用本实例停止令牌有序停止，核对旧进程结束后重启同一实例；原数据库、账号和账本保留。随后完整链9/9通过，两次创建的随机测试任务均通过真实HTTP取消并释放，演示账号未被调整。

首轮脚本误从5189读取未代理的状态端点得到HTML，在创建账号前结束；已改为3089。第二轮脚本误将复核成功响应等待为202（实际200），并发现上述取消接口配置缺口。失败证据与重启后的原任务清理分别保留：[首轮](completion/product-recovery-20261030/first-attempt-failure.json)、[第二轮](completion/product-recovery-20261030/second-attempt-failure.json)、[原任务清理](completion/product-recovery-20261030/second-attempt-cleanup.json)。这些失败不计入通过数。

产品截图：[余额不足](completion/product-recovery-20261030/01-product-insufficient.png)、[差额充值](completion/product-recovery-20261030/02-product-shortage-account.png)、[自动回到原任务](completion/product-recovery-20261030/03-product-automatically-resumed.png)、[取消后](completion/product-recovery-20261030/04-product-cancelled.png)。这组取消操作由真实HTTP驱动，未声称浏览器点击取消按钮经过独立验收；付款/任务恢复来自真实产品页面。
