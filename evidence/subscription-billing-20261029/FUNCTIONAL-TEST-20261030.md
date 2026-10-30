# 计费、扣费与充值：可操作的本地验收版本

2026-10-30。按用户最新要求优先完成可测试的计费系统。真实商户、自动续费签约和模型质量验收分别跟踪，本轮没有真实支付或模型调用。

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
|最终API TypeScript构建及公共契约检查|通过|[API构建](completion/alipay-normalized-api-build-final.log)、[契约检查](completion/billing-functional-contracts-20261030.log)|

真实浏览器路径：0积分 → 轻量订阅21,000 → 100元测试充值后31,000 → 全面复核冻结27,195，可用3,805 → 成功结算后可用仍3,805、冻结归零 → 原请求重放不再扣费 → 300元充值后33,805 → 新任务失败释放后恢复33,805。刷新和重新读取账户保持同一账本。

首轮测试台页面检查发现本地辅助查询误读 `bb_runs.error_code`，导致登录后账本读取500；已移除该不存在字段并重启测试进程，真实HTTP及浏览器全链复验通过。首轮日志保留，不将该次失败算为通过。产品数据库/鉴权没有为测试被关闭或改写。

截图：[冻结状态](completion/functional-manual-20261030/reserved-desktop.png)、[成功和失败流水](completion/functional-manual-20261030/ledger-desktop.png)、[手机账户](completion/functional-manual-20261030/account-mobile.png)。这是独立开发测试台，不是新增产品导航或正式客户界面。

另已收尾支付宝CSV配置子集与日期补证：当前API构建通过，解析器最新15项通过，新增8项PG及旧4项经过夹具修复均有通过证据；空库/升级共159个迁移。见[对账说明](ALIPAY-NORMALIZED-RECONCILIATION.md)及[解析边界](ALIPAY-CSV-NORMALIZATION-20261030.md)。本地功能测试没有因此依赖真实支付宝凭据。

当前运行环境为Windows、Node v26.13.0、Edge及本机PostgreSQL。先前Node22发布镜像验证有独立历史版本记录，不代表本次新增源码已经在生产镜像或真实商户环境验收。

会话续期修复只涉及本地测试台，没有修改生产鉴权；专项测试使用独立随机账号并通过真实失败结算释放其预留，没有调整演示账号余额。无需重启当前服务，刷新测试台即可使用。手动测试第9步已更正：测试其他订阅档位使用新的账号，原账号当期结束后才能手动续期；本期额外用量用充值补充。
