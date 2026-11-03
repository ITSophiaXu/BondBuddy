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

测试页的会话和订单只在本机进程内保留，重启即失效。未知付款沿用原订单查询，
退款重试沿用原退款编号。本页不连接业务数据库，不向正式账户发放积分，不能证明
订阅入账全链路或公网通知联调完成。停止方式为运行终端内 Ctrl+C。

完整 API 的隔离测试环境也可使用 `NODE_ENV=test`、
`BB_ALIPAY_PAY_ENABLED=1`、`BB_ALIPAY_ENVIRONMENT=sandbox` 和实际
`BB_ALIPAY_RETURN_URL`。只能连接独立测试数据库；不能同时设置生产应用/密钥字段，
不能启用沙箱对账单或 WAP。配置无效时支付渠道关闭，不回退生产网关。

## 正式环境交接

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
