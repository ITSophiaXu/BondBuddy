# 本地计费功能测试

独立本机测试台，真实产品 Web/API、真实登录与独立 PostgreSQL 账本。支付渠道和全面复核成果是明确标注的 synthetic 适配器/文件，不扣真钱、不调用模型，也不代表微信/支付宝商户联调或实际复核质量通过。

## 启动与停止

先完成当前 API/contracts/Web 构建，并确保已获授权的本机测试 PostgreSQL `127.0.0.1:55432` 可用。在仓库根运行：

```powershell
node scripts/billing-functional/start.mjs
node scripts/billing-functional/stop.mjs
```

启动时检查 `5189/3089` 端口，不覆盖已有服务；首次新建专用空数据库并执行仓库全部迁移，不复制或清空原模板的用户。后续停启仅在专用数据库名和实例 marker 均匹配后补跑尚未应用的迁移，保留原账号与账本，诊断追加到 `.runtime/migrations.log`。一个隐藏 Node 子进程承载 Vite 与 API。启动器清除继承的数据库、云资源、支付及模型配置；没有生产 provider，也没有模型 worker。退出只通过本实例随机控制令牌请求有序停止，不按 PID 杀其他进程，不停止 PostgreSQL。

- 测试台：`http://localhost:5189/__billing-test`
- 真实产品账户：`http://localhost:5189/#/account`
- 默认账号：`billing_tester` / `Local-Test-2026!`，首次注册 **0 积分**。

数据库名称/实例标记、启动记录、日志和合成文件在本目录 `.runtime/`，已加入本目录 `.gitignore`。停止和重启保留账号、余额、订单、任务及合成成果，不会重复赠分或重新初始化数据。此目录与旧 `scripts/local-integration` 实例无关。不要删除 `.runtime/config.json` 来尝试重置余额；手动清理应核对该文件记录的专用数据库，不能清理模板或其他实例。

## 手动路径

1. 在真实产品页登录，再打开测试台；新账号首次可用/任务预留均为零，已有测试记录的账号以当前账本为起点，不重置余额。
2. 在产品账户页开通月付/年付订阅或按需充值。页面会显示合成支付二维码，**无需扫码**；点击产品原有的“刷新支付状态”会经 synthetic provider 查询模拟成功，再由产品 `refreshRecharge → applyVerifiedPayment` 真正写入订阅周期/充值批次。年付价格为12个月月价的9折；仅首月额度立即到账，其余按月发放。
3. 回到测试台刷新账本，准备合成全面复核。准备只保存材料和锁定报价；“开始任务”调用真实报价绑定请求，自动预留额度，无金额确认弹窗。零余额会显示产品原始 402 错误且无预留。
4. “模拟成功交付并结算”复用真实 `claim → syntheticReviewPair → finish`，生成明确标注的合成 Word 并真实结算。模拟失败调用真实 `finish(...,'failed')` 释放预留，不直接改余额。
5. “重放同一执行键”再次提交保存的原请求，应得到同一个任务，余额不重复减少。再准备新的任务测试失败路径。

测试台只处理本人的测试任务。所有测试 API 都是带 JSON/Origin/真实登录/CSRF 的 POST；服务仅监听 loopback 且检查 Host。完成动作串行执行，只有候选队列任务的 owner/run 都匹配时才交付；队列变化时释放误领租约并报错，不完成其他任务。普通产品页面可以浏览，但没有完整模型执行栈；不要在这个环境上传客户材料或把其他生成入口当成已配置。

本地服务开启 `enableSyntheticQueue`，使产品实际的排队任务取消接口可用；这个选项不启动模型worker。排队中的测试任务可以通过产品取消并释放预留，已经成功交付的任务仍按实际结算规则处理。

## 自动续费与逐月发额

在产品账户页进入“管理订阅”，开启自动续费，再点“刷新续费授权状态”模拟渠道签约完成；取消也在管理页，完成一次确认后沿用真实取消 API，模拟渠道持久记录取消结果。模拟授权返回保留域的 HTTPS 链接，以保留生产 HTTPS 校验；仅本地注入的 `authorization.js` 将它变为本地账户链接，点击会调用产品已有的刷新授权按钮，不访问外网。本地 provider 支持月付、年付签约、取消、同订单幂等续扣；授权和支付结果分别保存在专用 `bb_local_billing_mandates`、`bb_local_billing_charges` 表，重启不会重新签约或重复扣款。

测试台的 **“模拟下期续费/额度发放”** 无需等待一个月：只推进当前登录账号的订阅测试时钟，并调用按账号限定的生产调度器。月付到期模拟扣下期月费；年付先模拟下一次月额度发放，合同周年才会续扣年费；关闭续费后不再扣下期费用，已付合同内的额度仍按月发放。同一操作 ID 重试不推进第二次，也不重复发额。

这个时钟仅适用于订阅：钱包90天过期、会话有效期及其他业务仍按真实时间判断，不可用它验收90天余额过期。没有改系统时间、已锁定合同日期、发额日期或余额；真实产品 API、生产迁移和环境没有时间模拟入口。启动仅在数据库名与实例 marker 均符合本地专用实例后替换 `bb_subscription_clock(text)`，生产定义及未设置模拟时钟的账号仍返回毫秒精度的真实当前时间。

服务统一构建、迁移并重启后运行 `node scripts/billing-functional/subscription-renewal-verify.mjs`。它新增随机账号，验证月续扣一次、同操作重放、取消后不扣、年付次月只发积分、未知/失败续扣不发积分及持久化渠道结果。未知/失败只写对应账号的本地模拟渠道表，再由真实支付处理决定是否发额；不直接写钱包。结果位于 `.runtime/subscription-renewal-verification.json`。

2026-10-30本链路首次真实HTTP执行通过12/12项，使用4个新随机账号，未运行模型任务或真实支付。[结果与修复记录](../../evidence/subscription-billing-20261029/completion/SUBSCRIPTION-RENEWAL-HTTP-20261030.md)保留了此前一次真实启动失败，以及静态发现的模拟授权URL问题；未重跑旧的整套扣费/页面恢复验证。

真实浏览器补充命令为 `node scripts/billing-functional/subscription-annual-browser-verify.mjs`：只用一个新年度轻量账号，点击真实产品支付、续费开关、本地化授权链接、取消开关及测试台发额按钮。2026-10-30首次执行6/6通过，外部请求0、浏览器异常0；[报告与4张截图](../../evidence/subscription-billing-20261029/completion/subscription-annual-browser-20261030/billing_annual_ui_2f35173a/result.json)记录年费只支付一次、首月21,000和次月42,000积分。

自动验证使用另外的随机注册账号，不消费 `billing_tester` 的演示余额。测试账号密码只用于本地隔离环境。

测试台遇到明确的登录过期401时，自动刷新现有会话一次，再用完全相同的任务ID和正文重放一次；刷新失败、403、500和网络错误不自动重放业务操作。页面刷新会加载最新测试台脚本，不需要重启服务。专项验证命令为 `node --test scripts/billing-functional/panel-session.test.mjs`，同样使用随机账号，真实过期场景只调整该账号的测试会话。

在仓库根可运行 `node scripts/billing-functional/verify.mjs` 验证真实HTTP链，运行 `node scripts/billing-functional/browser-verify.mjs` 用本机Edge验证实际页面点击；不要同时运行两者，避免测试队列相互等待。[手动测试步骤](MANUAL-QA.md)列出每一步预期余额。自动验证会新增独立测试账号及合成流水，保留用户测试账号的当前余额。

`node scripts/billing-functional/product-recovery-verify.mjs` 验证真实复核页面的“余额不足→按差额充值→到账自动返回原任务”。仅准备材料使用合成测试接口，开始、充值和恢复均经过产品页面，最终通过真实取消接口释放该随机账号的预留；不改浏览器响应或注入恢复记录。该脚本无需领取全局队列，不会完成其他账号的任务。

## 自动验收

在服务就绪后运行 `node scripts/billing-functional/verify.mjs`。避免与手动测试同时把不同账号的复核留在队列中；该脚本不会完成别人的任务。结果保存到 `.runtime/last-verification.json`。

2026-10-30，首轮真实 HTTP + PostgreSQL 的17项断言、真实浏览器点击的10项检查通过。该次验证时默认演示账号为零；后续用户测试形成的余额、订单和订阅始终保留，自动验证使用其他账号。整个验收没有模型调用或真实支付。[完整验收记录](../../evidence/subscription-billing-20261029/FUNCTIONAL-TEST-20261030.md)包含桌面和手机截图；随后即时升档和月付转年付另有[专项验收](../../evidence/subscription-billing-20261030/SUBSCRIPTION-CHANGES.md)。
