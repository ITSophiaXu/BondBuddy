# 支付确认与返回体验（#975）

## 范围与状态

用户于 2026-11-11 要求优化付款页面的可信度，以及付款成功返回 BondBuddy 后的显示。基线为 `develop@f95a8f2d83d7b1794eb92060a1fedeeeb916e1a9`。

本批为开发交付，尚未部署；新版原型及真实渠道体验等待用户验收。不沿用 11 月 10 日已完成发布的权限或生成质量门禁例外。#974 的真实异步通知验收、#973 的其他设备支付宝资源加载故障分别继续跟踪，本批不关闭它们。

## 原型与实现对照

原有账户原型：`product-prototype/public/account-credits.html?subscription=1`，使用 `subscription-account-prototype.js`。保留账户布局、订阅与充值入口、原订单、任务恢复、积分和退款规则。

新增付款状态原型：`product-prototype/public/payment-experience.html`（本 PR 提交），与真实前端共用 `payment-experience.css`。原型只有合成状态切换，不调用 API。前端来源为 `apps/web/src/subscription-billing-page.ts`、`apps/web/payment/alipay/return.html` 和对应入口模块。

| 部分 | 原有行为 | 本批行为 | 确认状态 |
| --- | --- | --- | --- |
| 付款前 | 简单金额、链接与按钮堆叠 | 品牌/渠道、订单金额、积分权益、官方跳转说明、原订单及截止时间 | 用户已提出改版方向，具体视觉待确认 |
| 支付中 | 主要依赖手动刷新 | 原订单有界自动核对；每轮最多 6 次，间隔至少 5 秒；30 秒后回到前台可开始新一轮；仍保留手动核对 | 待本地验收 |
| 成功 | 普通付款收起后提示 5 秒 | 付款操作收起，保留到账结果卡及订单详情入口；返回页不直接展开退款表单 | 对原型的本次请求内增量，待确认 |
| 支付返回 | 静态“返回账户”链接 | 自动回到账户并核对指定原订单，登录失效时保留该订单；只通过账户 API 确认成功 | 待本地/真实渠道验收 |
| 异常 | 通用状态 | 待确认、过期、未完成、查单不可用分别处理；缺少/重复订单参数留在恢复页 | 待本地验收 |

同尺寸对照截图见 `evidence/payment-experience-20261111/`。桌面视口 1440×960，手机 390×844；全页截图与支付卡片截图分开，卡片裁图保留完整金额/状态/订单区域。原型使用示例日期，实际页面使用 API 日期；原型只展示支付区域，实施保留完整账户页面。这些差异不冒充用户已批准。

## 支付及账务边界

- 返回 URL 的 `out_trade_no` 只作为候选订单 ID；只接受一个合法 ID，其他参数（包括状态、金额、签名、任意返回地址）不传入账户。URL 不作为到账凭据。
- API 继续校验账号归属、渠道原文签名、应用、商户、原订单、金额及账务幂等。前端不发积分、不接受 URL 金额、不新建付款。
- 自动核对调用既有 `/commerce/topups/{id}/refresh`。它可能按现有规则将已经真实付款的原订单入账，并非纯读取；不会向渠道发起扣款。停止轮询不代表失败，错误不代表未付款。
- 只有服务端确认的原订单才能恢复该账号、该订单已保存的原任务。换账号、跳出页面或取消等待后不从迟到响应启动其他任务。
- 金额继续用精确整数分；订单金额不冒充买家现金扣款或商户结算额。年付显示全年权益与每月额度，不将全年积分误写成一次到账。
- 商户名称不从浏览器返回参数构造，也不硬编码个人姓名或宣称认证背书。页面明确服务为 BondBuddy，收款主体以官方收银台展示为准。正式渠道的应用显示名曾出现 GuluAI；其与收款法律主体及 BondBuddy 的公开名称说明仍需上线验收时核对，不臆造关系。

## 官方收银台调整依据

官方 Node SDK `alipay-sdk@4.14.0` 的 README `pageExecute` GET/POST 示例使用 `FAST_INSTANT_TRADE_PAY`，未设置 `qr_pay_mode`。官方 Java SDK `AlipayTradePagePayModel` 对该字段说明：`2` 是支付宝域名上的“订单码-跳转模式”，`0/1/3/4` 为商户页 iframe 前置模式。

- [官方 Node SDK 示例](https://github.com/alipay/alipay-sdk-nodejs-all/blob/master/README.md#pageexecute-示例代码)
- [官方 Java SDK 参数说明](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePagePayModel.java)
- [电脑网站支付接口](https://opendocs.alipay.com/open/028r8t?scene=22)

本批去掉强制 `qr_pay_mode=2`，沿用官方 SDK 默认展示，并将订单标题改为“BondBuddy 券商助手 · 积分服务”。不嵌入仿支付宝页面、不改变支付产品或开通状态。真实默认收银台最终外观由支付宝决定，尚未用新的正式订单验收；旧订单已签发的 URL 继续有效，不重建或替换原单。

## 本地验收

先构建 API 和 Web，启动 `node scripts/payment-experience/preview.mjs`，访问：

`http://127.0.0.1:5182/__preview`

此入口实际运行本分支构建的 Web。API、账号、付款及积分为本机内存中的合成数据；不连接生产数据库、密钥、支付宝或模型。测试账号自动为 `payment_preview`，无真实登录凭证。模拟返回页与前端账户查单使用实际前端代码，不能证明正式签名/通知/真实发分链路。

1. 在入口打开新版账户，检查 ¥50.00、5,000 积分、永久有效、订单号和官方跳转说明。
2. 打开“模拟付款与返回”，选择模拟付款成功，核对返回后到账状态、时间和可用积分。
3. 分别选择待确认、过期、未完成、查单暂不可用，确保未显示虚假成功或再次扣款提示。
4. 缩窄窗口检查手机布局；点击订单详情才展开原订单退款记录。
5. 入口的原型链接提供相同状态对照。原型中的付款按钮只切换示例状态。

停止：运行终端 `Ctrl+C`。重新运行同一命令会重置合成订单为待付款。只监听 `127.0.0.1:5182`，拒绝不匹配 Host/跨源写入；端口占用则退出，不停止他人的服务。

## 发布说明

无数据库迁移、无新依赖或生产配置变更。将 API 与 Web 作为本批协调发布；Web 构建新增 `payment/alipay/return.html` 入口，路径与原生产返回地址一致，部署须包含新 HTML 及其哈希资源。已付旧订单仍按原价格、原权益、原账务执行。

发布前需要用户视觉验收、统一发布授权，以及新的官方收银台/返回原订单真实验收。回滚时使用上一批 API/Web 镜像组合；本批不改变账务数据结构。首次真实通知验证仍属于 #974。

## 自动化与人工检查记录

环境：Windows、仓库已安装的 TypeScript/Vite/Playwright、系统 Edge（`BB_E2E_BROWSER_CHANNEL=msedge`）。以下均为本地检查；未调用正式支付宝或生产数据库。

| 检查 | 结果 |
| --- | --- |
| Web `tsc --noEmit`、Vite production build | 通过；包含新的返回页及同源模块/CSS，既有大包体提示保留 |
| API TypeScript build；`alipay-pay.test.js` | 13 pass / 0 fail / 0 skip；合成 RSA2、原订单、金额、回调、退款及默认收银台参数 |
| `payment-return-route.test.js` | 2 pass / 0 fail / 0 skip；候选订单、重复参数、伪造结果、跳转目标过滤 |
| `subscription-account.spec.ts` | 60 pass / 0 fail / 0 skip；其中新增返回、登录、所有权、原任务、有界核对、异常及原型场景 |
| 最后手机定位/原型隐藏项修正后的定向复验 | 2 pass / 0 fail / 0 skip，并更新截图 |
| `account.spec.ts` 与 `billing-navigation.spec.ts` | 29 pass / 0 fail / 1 skip；跳过的是需单独环境变量启用的旧历史截图用例 |
| contracts 原 `check:examples` 内的 6 组测试 | 72 pass / 0 fail / 0 skip；179 个合成示例 + 12 个内部示例，以及 4 个生命周期示例校验通过 |
| 真实构建 Web 的本机模拟入口 | HTML、返回页、CSS、API 均 HTTP 200；模拟付款 303 返回原单，订单 paid、5,000 分与账户余额一致 |

扩大文件匹配时还运行到旧 `commerce-account.spec.ts`，其中 2 项失败；已用独立解包的未修改基线 f95a8f2d 重现相同 2 项失败，登记 #976，本批不改写旧断言或放宽金额协议。不能把扩大运行称为全通过。

自动截图已人工查看并修正手机定位、原型隐藏截止时间等问题。桌面浏览器接管因无法可靠确认当前 URL 而停止，没有继续通过其他工具接管用户浏览器；可直接手动打开本机验收地址。代码测试使用独立自动化浏览器，不等同用户已验收。
