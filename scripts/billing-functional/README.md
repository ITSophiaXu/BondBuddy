# 本地计费功能测试

独立本机测试台，真实产品 Web/API、真实登录与独立 PostgreSQL 账本。支付渠道和全面复核成果是明确标注的 synthetic 适配器/文件，不扣真钱、不调用模型，也不代表微信/支付宝商户联调或实际复核质量通过。

## 启动与停止

先完成当前 API/contracts/Web 构建，并确保已获授权的本机测试 PostgreSQL `127.0.0.1:55432` 可用。在仓库根运行：

```powershell
node scripts/billing-functional/start.mjs
node scripts/billing-functional/stop.mjs
```

启动时检查 `5189/3089` 端口，不覆盖已有服务；新建专用空数据库并执行仓库全部迁移，不复制或清空原模板的用户。一个隐藏 Node 子进程承载 Vite 与 API。启动器清除继承的数据库、云资源、支付及模型配置；没有生产 provider，也没有模型 worker。退出只通过本实例随机控制令牌请求有序停止，不按 PID 杀其他进程，不停止 PostgreSQL。

- 测试台：`http://localhost:5189/__billing-test`
- 真实产品账户：`http://localhost:5189/#/account`
- 默认账号：`billing_tester` / `Local-Test-2026!`，首次注册 **0 积分**。

数据库名称/实例标记、启动记录、日志和合成文件在本目录 `.runtime/`，已加入本目录 `.gitignore`。停止和重启保留账号、余额、订单、任务及合成成果，不会重复赠分或重新初始化数据。此目录与旧 `scripts/local-integration` 实例无关。不要删除 `.runtime/config.json` 来尝试重置余额；手动清理应核对该文件记录的专用数据库，不能清理模板或其他实例。

## 手动路径

1. 在真实产品页登录，再打开测试台；确认可用/任务预留均为零。
2. 在产品账户页开通月订阅或按需充值。页面会显示合成支付二维码，**无需扫码**；点击产品原有的“刷新支付状态”会经 synthetic provider 查询模拟成功，再由产品 `refreshRecharge → applyVerifiedPayment` 真正写入订阅周期/充值批次。
3. 回到测试台刷新账本，准备合成全面复核。准备只保存材料和锁定报价；“开始任务”调用真实报价绑定请求，自动预留额度，无金额确认弹窗。零余额会显示产品原始 402 错误且无预留。
4. “模拟成功交付并结算”复用真实 `claim → syntheticReviewPair → finish`，生成明确标注的合成 Word 并真实结算。模拟失败调用真实 `finish(...,'failed')` 释放预留，不直接改余额。
5. “重放同一执行键”再次提交保存的原请求，应得到同一个任务，余额不重复减少。再准备新的任务测试失败路径。

测试台只处理本人的测试任务。所有测试 API 都是带 JSON/Origin/真实登录/CSRF 的 POST；服务仅监听 loopback 且检查 Host。完成动作串行执行，只有候选队列任务的 owner/run 都匹配时才交付；队列变化时释放误领租约并报错，不完成其他任务。普通产品页面可以浏览，但没有完整模型执行栈；不要在这个环境上传客户材料或把其他生成入口当成已配置。

自动验证使用另外的随机注册账号，不消费 `billing_tester` 的演示余额。测试账号密码只用于本地隔离环境。

在仓库根可运行 `node scripts/billing-functional/verify.mjs` 验证真实HTTP链，运行 `node scripts/billing-functional/browser-verify.mjs` 用本机Edge验证实际页面点击；不要同时运行两者，避免测试队列相互等待。[手动测试步骤](MANUAL-QA.md)列出每一步预期余额。自动验证会新增独立测试账号及合成流水，保留用户测试账号的当前余额。

## 自动验收

在服务就绪后运行 `node scripts/billing-functional/verify.mjs`。避免与手动测试同时把不同账号的复核留在队列中；该脚本不会完成别人的任务。结果保存到 `.runtime/last-verification.json`。

2026-10-30，真实 HTTP + PostgreSQL 的17项断言、真实浏览器点击的10项检查通过。默认演示账号余额保持零，自动验证使用其他账号；整个验收没有模型调用或真实支付。此前已实际执行一次停止/重启，数据保留。[完整验收记录](../../evidence/subscription-billing-20261029/FUNCTIONAL-TEST-20261030.md)包含桌面和手机截图。
