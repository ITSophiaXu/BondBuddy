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

截至 2026-11-05 交付，备案最后已知为管局审核中；正式应用已提交审核，但最近一次状态
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

## 2026-11-10 正式支付开发交付

用户本次报告腾讯云备案已通过，并明确要求真实用户收款、使用正式版接入工具。
备案域名和官方状态尚未核对；备案通过也不能替代支付宝应用审核与商家签约。
此前的沙箱付款记录保留为历史证据，不作为本轮正式付款、通知或退款证据。
本机正式版接入 Skill 的 Windows 开通入口要求转到
[支付宝 AI 付官网](https://aipay.alipay.com/)完成产品开通，因此本轮没有重新查询或
提交商家签约、正式应用审核。用户应在官网核对已有应用，选择 AI 网页应用收款，
按实际页面完成缺少的材料与签约，不因已有沙箱测试而新建重复应用。

本轮修复部署模板遗漏的 `BB_ALIPAY_ENVIRONMENT` 和
`BB_ALIPAY_APP_PRIVATE_KEY_TYPE` 透传，同时保留空密钥类型下的 PEM 兼容。
单机与分离主节点配置均覆盖。真实下单、验签通知、查单补偿、订阅及积分入账
继续使用既有持久化支付链路；本轮不改价格、套餐或账务事务，不新增依赖或迁移。

### 发布配置与只读检查

由发布环境配置以下值。应用 ID、商家 PID、密钥文件必须来自同一已开通的正式应用；
私钥由用户或发布环境保管，不发到对话、提交到 Git 或写入日志。

| 配置 | 正式收款要求 |
| --- | --- |
| `BB_ALIPAY_PAY_ENABLED` | `1` |
| `BB_ALIPAY_ENVIRONMENT` | `production` |
| `BB_ALIPAY_WEB_PRODUCT` | `page`，覆盖 PC/H5；旧 WAP 签约不替代本产品 |
| `BB_SUBSCRIPTION_BILLING_ENABLED` | `1`，各账务服务保持一致 |
| `BB_ALIPAY_APP_ID` / `BB_ALIPAY_SELLER_ID` | 已审核应用和已签约商家的正式标识 |
| `BB_PAYMENT_SECRETS_DIR` | 主机受保护目录，只读挂载到 `/run/bondbuddy-payments` |
| `BB_ALIPAY_APP_PRIVATE_KEY_FILE` / `BB_ALIPAY_PUBLIC_KEY_FILE` | 挂载目录内的绝对路径；POSIX 文件权限须符合支付工厂的 0600 与所有者检查 |
| `BB_ALIPAY_APP_PRIVATE_KEY_TYPE` | 原始 Base64 使用实际的 `PKCS1` 或 `PKCS8`；已有 PEM 可留空，不改写密钥内容 |
| `BB_PUBLIC_ORIGIN` | `https://bondbuddy.gululai.com`（须与最终备案、签约域名核对）；Compose 映射为 API 的 `BB_ALLOWED_ORIGIN` |
| `BB_ALIPAY_NOTIFY_URL` | `https://bondbuddy.gululai.com/api/v1/payments/alipay/callback` |
| `BB_ALIPAY_RETURN_URL` | `https://bondbuddy.gululai.com/payment/alipay/return.html` |
| `BB_EGRESS_ALLOW` | 保留既有业务域名并加入精确主机 `openapi.alipay.com` |
| `BB_ALIPAY_REFUND_ENABLED` | 核验商家返回真实买家实付及本次退款现金证据后才启用 |

已构建的 API 目录提供只读配置检查。在已注入目标环境配置的进程中，从仓库根执行：

```sh
node apps/api/dist/alipay-production-check.js
```

在部署后的 API 容器 `/app` 工作目录中也可运行同一命令。该命令使用支付工厂读取
目标配置和密钥，只输出布尔结果及外部待验项目，不输出原始配置、不请求网关、
不连接数据库、不创建订单。退出码 0 和 `configuration_valid=true` 仅证明本地配置
可加载；不能证明应用审核、商家签约、密钥与平台登记的一致性或交易成功。
沙箱及未知环境会失败，且不会读取其凭据。

原有 `scripts/check-payment-deployment.mjs` 继续检查解析后的 Compose 出口、
收费开关及生产环境约束；检查时将配置直接送入检查器，禁止将含凭据的完整解析结果
存入交付文件或日志。配置检查也不能代替公网通知联调。

### 本轮测试与统一验收待办

- `npm run build`：全仓构建通过，仅现有 bundle 大小提示。
- `npm run check:contracts`：通过（32、29、11 项测试；179 个合成样例、12 个内部样例及 4 个数据生命周期样例）。
- 支付适配器、支付工厂、正式配置检查、部署检查与 Compose 配置回归共 38 个不同用例分别通过。
  首轮 37 通过、1 失败；修正合成测试环境的 `NO_PROXY` 后，受影响的 2 个 Compose 用例通过。
  全部使用合成密钥和配置，不是正式支付宝交易。
- Docker Desktop 在启动等待 40 秒后超时，引擎管道不可用；本轮 PostgreSQL 支付集成测试未执行。
- 只读访问正式站回跳页成功，页面要求回到账号核对原订单；此项是已有线上页面检查，
  不代表本轮代码已部署或付款成功。

发布前仍须核对正式应用审核、商家产品签约及正式凭据，并在独立集成测试环境复验
支付数据库链路。生产发布与真实付款验收由获授权的发布 chat 和用户完成：

1. 用户从账号页选择真实充值或套餐，核对当时显示的金额后自行付款；由服务端
   核对原订单、商家、应用、金额及交易号，确认订阅/积分只到账一次。
2. 验证公网通知验签及 `success` 回写、重复通知幂等、关闭浏览器仍到账、原订单查询补偿、
   他人账号不能读取该订单。确认超时订单先查后关，不创建重复收款。
3. 经用户明确确认后验证退款：金额不超过可退实付，同一次重试复用退款编号；
   缺少买家实付或退款现金证据时保持待核对，不能用订单总额补值。
4. 记录脱敏订单证据、到账与退款结果、最终版本和用户验收结论。自动续费/自动代扣
   不属于本次网页支付开通能力。

本开发 chat 不执行生产部署、迁移或服务重启。状态为：代码与定向自测完成，
本轮本地集成版尚未启动、用户尚未验收、代码尚未部署，待统一集成与发布。
