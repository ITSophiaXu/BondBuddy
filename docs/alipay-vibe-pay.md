# BondBuddy 支付宝 AI 网页应用收款

本次接入复用现有订单、订阅、积分及退款账务。Vibe Pay 网页产品使用
`BB_ALIPAY_WEB_PRODUCT=page`，PC 和 H5 均为 `alipay.trade.page.pay`。
现有显式 WAP 配置仅为旧产品兼容保留，不能替代 Vibe Pay 的网页签约。

## 本地沙箱

先由官方 alipay-aipay Skill 在本工作区创建并验证根目录
`.alipay-sandbox.json`。该文件必须保持 Git 忽略，禁止复制进源码、环境示例或日志。
Node.js 从 `appIds[0]` 原样读取 `appId`、`appPrivatePkcsKey`、
`alipayPublicKey`，并核对 `pid` 与沙箱商家一致。私钥以 PKCS1 原值交给 SDK。
文件路径由服务端模块位置确定，不依赖启动目录；POSIX 文件权限要求 0600。

构建 API 及其依赖后运行：

```sh
npm run build --workspace @bondbuddy/contracts --workspace @bondbuddy/domain --workspace @bondbuddy/rule-pack-registry --workspace @bondbuddy/rule-applicability-context --workspace @bondbuddy/api
node scripts/alipay-sandbox.mjs
```

启动输出给出实际分配的本机地址和回跳地址；使用该地址打开浏览器。
服务仅监听 `127.0.0.1`。点击进入收银台后使用沙箱买家付款，再查询结果。
测试金额固定 0.01 元，使用真实支付宝沙箱和同一支付适配器；通知签名、金额、
交易归属等规则与正式适配器一致，不存在跳过验签或固定成功分支。
付款入口用官方 SDK 的 POST 表单并由浏览器提交；已有正式订单接口继续使用
同一 SDK 明确支持的 GET 付款 URL，不把 HTML 表单当 URL 跳转。
每笔测试订单有效期为 30 分钟，页面显示北京时间截止时间；重新进入收银台不会续期。
到期后先查询原订单，只有服务端确认已关闭或过期，才显示“创建新测试订单并进入收银台”。
点击该按钮会再次查询旧订单并保留旧结果；网络错误、状态未知或已付款均不换单。
同一会话的操作串行处理，重复点击不会创建多个新订单。二维码无法使用时，可在
支付宝收银台选择“使用电脑支付”，输入沙箱买家账号和支付密码。
网关可能把 JSON 响应标为 `text/html`；适配器兼容这两种响应类型，但仍严格
限制响应大小、解析原始 JSON 并验证 RSA2 签名，不接受实际 HTML 或未签名响应。

测试页的会话和订单只在本机进程内保留，重启即失效。未知付款沿用原订单查询，
退款重试沿用原退款编号。本页不连接业务数据库，不向正式账户发放积分，不能证明
订阅入账全链路或公网通知联调完成。停止方式为运行终端内 Ctrl+C。

本地订单生命周期回归：`node --test scripts/alipay-sandbox-order.test.mjs`，覆盖到期、
状态不明、付款竞态、重复换单及旧订单证据保留。

2026-11-05 实际联调记录：用户已完成 0.01 元沙箱订单付款并回跳本地页面。
共享适配器查询真实沙箱网关，RSA2 验签和订单、金额核对通过，取得
`TRADE_SUCCESS`。这证明本笔订单的付款、回跳及查询链路已验证。
同一查询返回 `buyer_pay_amount=0.00`、`receipt_amount=0.00`，与订单总额
`total_amount=0.01` 不同，尚不能确认原因。退款前实付校验已阻止退款提交；
不得用订单总额替换买家实付金额，也不能称退款验证完成。
公网通知和退款仍待联调。后续独立产品订单的订阅与积分验证见下文。

完整 API 的隔离测试环境也可使用 `NODE_ENV=test`、
`BB_ALIPAY_PAY_ENABLED=1`、`BB_ALIPAY_ENVIRONMENT=sandbox` 和实际
`BB_ALIPAY_RETURN_URL`。只能连接独立测试数据库；不能同时设置生产应用/密钥字段，
不能启用沙箱对账单或 WAP。配置无效时支付渠道关闭，不回退生产网关。

## 正式环境交接

完整产品页面的本地沙箱入口见
[支付专项验收](../scripts/alipay-integration/README.md)。该入口使用当前分支的实际
Web/API、独立 PostgreSQL 和零初始余额测试账号，支持从套餐选择进入支付宝
沙箱收银台；付款后通过原订单查询核对套餐与积分，不使用模拟付款成功。
这与前述无数据库的 0.01 元接口演示分开记录。

2026-11-05 12:06（北京时间），用户完成实际产品内的 199 元轻量月付沙箱付款后，
原产品 API 与独立 PostgreSQL 核验通过：订单已支付、订阅有效、21,000 积分到账，
只有一个关联积分批次及一个有效订阅周期，重复查询不再次发额。结果保存在
`.local/alipay-integration/payment-verification.json`（Git 忽略）。本笔买家实付
仍返回 0 分，保留原始值，未据此绕过退款控制。此结果不代表公网通知、退款或
生产收款已验证，也不将用户完成付款自动等同于整批功能验收。

截至本次交付，备案最后已知为管局审核中；正式应用已提交审核，但最近一次状态
查询因授权过期未取得新结论；商家最后已知尚未签约，仍需实际主页、产品页和
付款前页面材料。上线前须分别核对最新状态，不能用沙箱付款替代这些结果。

本开发分支不执行部署。发布 chat 在用户验收后统一发布，并核对：

- ICP、个人主体资格、支付宝签约及应用审核的实际状态。
- `BB_ALIPAY_ENVIRONMENT=production`（兼容现有未设置时的生产默认值）、
  `BB_ALIPAY_WEB_PRODUCT=page` 及同一正式应用的应用 ID、商家 PID 和密钥配置。
  私钥由用户或发布环境安全配置，不在对话中提供。
  使用官方 Skill 的原始 PKCS1 密钥时显式设置
  `BB_ALIPAY_APP_PRIVATE_KEY_TYPE=PKCS1`，应用私钥和支付宝公钥直接使用原始 Base64；
  不设置该选项时保留既有 PEM 配置兼容方式。
- `BB_ALIPAY_NOTIFY_URL` 为公网 HTTPS
  `/api/v1/payments/alipay/callback`，生产不能省略。支付宝通知验签通过后，
  再核对本地订单、金额、商家、应用；付款状态中的退款事件标记会被拒绝。
  账务提交成功返回纯文本 `success`；失败返回 `fail`，保留非成功 HTTP 状态以重试。
- `BB_ALIPAY_RETURN_URL` 指向实际部署的
  `/payment/alipay/return.html`。页面不信任回跳参数；返回账户后，现有登录会话
  恢复原付款意图并通过受保护订单查询确认状态。
- 公网通知、重复通知不重复入账、查询补偿、订单归属、付款后订阅/积分、退款、
  关闭订单和生产代理策略的集成验收。同步回跳本身不能证明付款。

本次无需新增数据库迁移或 npm 依赖。`check-payment-deployment.mjs` 会拒绝
任一账务服务携带沙箱或未知支付宝环境；生产业务账务不得使用沙箱凭据。
