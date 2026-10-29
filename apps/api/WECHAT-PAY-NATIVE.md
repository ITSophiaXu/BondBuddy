# 微信支付 API V3 Native 渠道

本模块接入直连商户 Native 支付，不包含服务商代收、小程序、H5跳转、模拟付款或管理员赠余额接口。新增适配器使用Node内置crypto/fetch，没有新增依赖。合成测试不能代替正式商户开通、真实微信协议验收或实际支付验收。

## 接线与默认关闭

`apps/api/src/wechat-pay.ts`导出`createWechatPayProvider(options, dependencies?)`，实现现有`PaymentProvider`；`payment-provider-config.ts`导出`paymentProvidersFromEnv(env = process.env, dependencies?)`，返回`{providers, status}`。status只有`disabled/ready/invalid`，不含密钥、文件内容或原始异常。

API启动接线建议（由server集成负责）：

```ts
const configuredPayments = paymentProvidersFromEnv(process.env);
const providers = settings.paymentProviders ?? configuredPayments.providers;
installPayments(app, pool, owner, paidAuthoring && !commercial, providers);
installCommerce(app, pool, owner, commercial, providers);
```

`Settings.paymentProviders`保留供测试/显式宿主注入；不要把默认空数组写在`??`前而使env工厂失效。配置不完整或非法时providers为空，现有`recharge-config`不会列出可支付渠道，创建订单返回原有503。不得用假checkout URL、sandbox-pay、管理员grant或未签名回执补成“可支付”。

渠道可用性和“开放新销售”是两个开关。关闭新销售时仍保留已配置provider和回调/查单，处理此前已付订单；不要因暂停销售就删除所有商户配置，使待入账通知无法核验。

Compose已传递 `BB_OUTCOME_PRICING_ENABLED` 及微信配置，均默认关闭。API只读挂载 `BB_PAYMENT_SECRETS_DIR` 到 `/run/bondbuddy-payments`；`*_FILE` 必须填写容器内绝对路径，不能填写主机路径。私钥、V3 key及平台pin留在该受保护目录，不提交仓库。新成果模式停止旧赠额套餐新售，旧订单回调/查单仍沿原渠道处理。

## 配置

默认不开启；仅`BB_WECHAT_PAY_ENABLED=1`尝试装载。非0/1错误值、缺项、错误密钥、未知pin或无效URL均关闭渠道，不输出原始配置错误。

| 环境变量 | 用途 |
|---|---|
| `BB_WECHAT_PAY_ENABLED` | `1`装载；未设/`0`关闭 |
| `BB_WECHAT_PAY_MERCHANT_ID` | 已开通Native的直连商户号 |
| `BB_WECHAT_PAY_APP_ID` | 与该商户关联的微信AppID |
| `BB_WECHAT_PAY_MERCHANT_CERT_SERIAL` | 商户API证书序列号，须对应签名私钥 |
| `BB_WECHAT_PAY_PRIVATE_KEY_FILE` | 商户RSA2048私钥PEM绝对路径 |
| `BB_WECHAT_PAY_API_V3_KEY_FILE` | 32位API V3对称密钥绝对路径，不是商户私钥 |
| `BB_WECHAT_PAY_NOTIFY_URL` | 正式HTTPS回调地址，当前路由`/api/v1/payments/wechat/callback`；不带凭据、query或fragment |
| `BB_WECHAT_PAY_PLATFORM_SERIAL` | 可信微信支付平台证书序列号或公钥ID（`PUB_KEY_ID_...`） |
| `BB_WECHAT_PAY_PLATFORM_PUBLIC_KEY_FILE` | 与上述ID匹配、带外核验的微信支付公钥PEM |
| `BB_WECHAT_PAY_PLATFORM_CERT_FILE` | 可用平台证书PEM替代公钥文件，两者只能选一个；证书序列号与有效期均校验 |
| `BB_WECHAT_PAY_PLATFORM_KEYS_FILE` | 轮换时可改用下述pin数组文件，与单pin变量互斥 |
| `BB_WECHAT_PAY_TIMEOUT_MS` | 完整请求及读响应超时，默认10000ms，允许10–30000ms；正式环境建议保留默认 |

私钥、API V3 key、平台公钥/证书也可分别通过不带`_FILE`的同名环境变量提供实际多行值；同一项同时设值和文件会被拒绝。推荐文件挂载，不在命令行、repo、镜像、浏览器、日志或工单中贴密钥。不要把字面`\n`当PEM换行。

POSIX文件必须是root或当前服务uid拥有的普通文件，权限只允许owner访问（例如0400/0600），无symlink，最多64KiB；读取使用文件描述符并在支持的平台禁止跟随symlink。所在目录也必须由受信部署账户控制。容器内给实际服务uid读取权限；root0400而服务不是root时会因无法读取而关闭渠道。Windows上需用ACL等价限制为管理员/服务账户；Node模块不会把POSIX mode冒充Windows ACL验收。

多pin轮换文件内容为JSON数组，最多8项。只保存从微信商户可信渠道取得并独立核对的公钥或证书，不能相信回调中给出的下载地址：

```json
[
  {"serial":"PUB_KEY_ID_<verified-id>","publicKeyPem":"<actual PEM with newlines>"},
  {"serial":"<verified-old-certificate-serial>","certificatePem":"<actual PEM with newlines>"}
]
```

这只是结构说明，尖括号占位值不能通过配置校验。每项只能有一个公钥或证书；重复serial被拒绝。证书PEM的真实serial必须一致，证书当前有效；公钥ID依赖带外pin核验。配置后重启/滚动替换API装载，保留仍可能签署在途交易通知的旧pin。陌生serial不会动态下载或自动信任。NTP需正常，签名timestamp与本机相差超过5分钟会拒绝。

## 协议和账本边界

- 仅请求固定`https://api.mch.weixin.qq.com`，不从env接受任意API origin，不跟随HTTP重定向。测试可注入fetch将请求转到本地mock。
- Native创建请求包含锁定订单号、商户/AppID、分币总金额、CNY、有效期及正式回调。RSA-SHA256签署`method + path/query + timestamp + nonce + exact body`；GET使用空body。超时覆盖获取响应和读body，响应上限64KiB，只有200/JSON且固定平台pin验签成功才接受。
- API响应与回调均校验Wechatpay-Signature/Timestamp/Nonce/Serial。回调按原始body验签，之后才解析resource，并用API V3 key执行AES-256-GCM认证解密；不接受其他算法、资源类型或退款事件伪装成支付成功。
- 解密/查单数据必须匹配配置中的商户/AppID、NATIVE交易类型、合法订单号、正整数分币金额和CNY。使用`amount.total`而非可能被优惠改变的`payer_total`。
- `query(order)`还直接匹配传入订单、商户、金额和币种；无结果/未验签/异常状态不产生成功回执。`SUCCESS`映射paid；NOTPAY/USERPAYING映射pending，CLOSED映射expired，REVOKED/PAYERROR映射failed。REFUND需独立退款流程，本接口拒绝把它当新paid或自行改积分。
- 回调没有数据库权限，返回已验证`VerifiedPayment`。最终与本地锁定订单金额、币种、商户、provider、交易号匹配及入账由`applyVerifiedPayment`完成。同一已签回调重复到达返回相同订单号/交易号，沿用`recharge:<order_id>`账本幂等键；不能把通知事件ID或每次HTTP请求改成新充值键。
- 验签或解密失败返回原回调401；正确签名但金额与本地订单不符由账本拒绝，绝不因“微信签过名”就跳过锁定金额校验。只有入账事务完成后才返回成功ack；DB故障保留通知重试/同订单查单修复路径。
- 创建订单超时可能已经在微信生效。保留原本地订单和out_trade_no，查询/重复恢复同一订单，不能因为客户端没收到结果就另建付款意图。未知状态不得直接赠余额。

退款能力未冒充已实现。建议后续独立`PaymentRefundProvider`处理`out_refund_no`、原订单/transaction_id、original total/refund amount/CNY，签名请求、退款查询和REFUND.SUCCESS回调；与持久退款单和已锁定可退余额事务接线。缺退款账本/冻结/原路退款确认时，不能把内部扣减积分或写一个refunded状态当已原路退款。

## 验证与上线核对

单元测试仅在内存生成synthetic RSA密钥、API V3 key及自签测试证书。HTTP验证只指向127.0.0.1 mock，覆盖真实签名字符串、响应验签、AEAD解密、伪签名/过期/未来时间/未知serial、商户/AppID/订单/金额/币种错误、异常状态、超时/大body、无效配置和证书轮换。配置文件测试使用临时合成文件并清理。

构建API后运行：

```sh
node --test apps/api/dist/wechat-pay.test.js apps/api/dist/payment-provider-config.test.js
node --test apps/api/dist/wechat-pay.pg.test.js apps/api/dist/payments.pg.test.js
```

PG测试通过`BB_TEST_DATABASE_URL`复制已迁移测试模板库，重复/并发真实RSA/AES合成回调只入原账本一次，伪回调及本地锁定金额差异保持余额不变。无测试数据库时测试明确skip，不称已验收幂等数据库闭环。所有测试均未调用真实微信商户接口或发起真钱。

2026-10-28本地验证：API完整TypeScript build通过；上述两组命令合并运行，共12 passed、0 failed、0 skipped。微信适配器PG用两笔980/1990分的`/commerce/topups`订单验证签名/解密、金额拒绝、并发回调与余额隔离，充值未自动产生任务。测试环境为Windows和隔离PostgreSQL；POSIX所有者/权限拒绝分支只在POSIX运行，本次未冒称已在Linux执行。正式微信商户支付和生产部署未执行。

正式接通应由授权运维配置本商户信息和可信平台pin，在对外域名核验TLS及回调、商户Native产品和AppID绑定、时钟、固定出站、权限与日志脱敏。最后用已授权的实际商户支付/回调/查单及金额对账验收；没有正式凭据时保留关闭，不补假成功。暂停新售、数据库失败后回调重试和配置轮换也要核对。以上为部署验收内容，本切片没有执行生产变更。

## 报价、结算和采购观测接线建议

现有`db/migrations/0061_m1_model_cost_attribution.sql`的`bb_platform_cost_ledger`已经关联attempt、logical_call、job/run、精确provider/model、usage_status、pricing_status、rate_ref和cost_amount。缺usage或费率仍须unknown/rate_missing，不能记0；input包含cached子集、output包含推理子集时分别计价，不重复相加。支付适配器不决定成果报价，也不从供应商模型成本推导用户扣款。

root的报价/扣费整合建议保留：work_order/quote_id及版本、owner/project/run、输入hash、成果单位量、quoted_fen、reserved_fen、settled_fen、released_fen、refund_fen、原范围返工原因、全部attempt成本状态、预算内/预算外支持分钟。报价接受、明确开始、交付、结算、退款分别记录时间与幂等键；充值实收不能算履约收入，不能让一项成功回执同时触发新任务。

支付运行指标可仅记录provider、order_id、create/query/callback阶段、成功/拒绝的固定错误类别、时延、验签失败、金额不匹配、重复回调及最终账本结果。禁止记录私钥/API key、Authorization签名串、原始支付/解密body、全部headers和payer/openid。SDK错误仅透出稳定代码；当前模块不会把微信原始error body或crypto异常拼入错误。收款现金、钱包负债、实际任务收入与模型/支持成本继续分账对账。
