# BondBuddy 内的支付宝沙箱验收

本入口运行当前分支的实际 `apps/web` 与 `apps/api`，使用独立 PostgreSQL、真实
产品账号和原支付宝适配器。套餐价格与积分规则不改写。支付请求只访问支付宝
沙箱，付款必须由沙箱买家完成；刷新订单通过服务端 RSA2 验签查询确认结果。
没有合成支付成功接口、直接赠分、生产连接或模型 worker。

## 启动

在仓库根执行（Node >=22；本次使用 Node 24.22.2，已有 Docker Desktop）：

```powershell
npm run build --workspace @bondbuddy/contracts --workspace @bondbuddy/domain --workspace @bondbuddy/rule-pack-registry --workspace @bondbuddy/rule-applicability-context --workspace @bondbuddy/api --workspace @bondbuddy/web
docker compose -p bondbuddy-alipay-acceptance -f scripts/alipay-integration/compose.yaml up -d --wait
node scripts/alipay-integration/start.mjs
```

需要本工作区已经由官方 Skill 创建并校验的 `.alipay-sandbox.json`。启动只通过
原配置模块读取它，不复制密钥到源码或其他配置文件。沙箱配置缺失或校验失败时
启动失败，不切换正式网关。运行前移除继承的生产数据库、支付、模型、云端配置
及 Node preload 配置。

- 页面：<http://localhost:5199/#/account>
- 本地账号：`alipay_tester`，密码：`Local-Alipay-Test-2026!`
- API：`127.0.0.1:3099`；数据库：`127.0.0.1:55449`
- 状态：<http://localhost:5199/__alipay-test/status>

API、Web 和数据库只监听本机。首次启动使用空数据库，建立与工作区及实例 UUID
匹配的所有权记录后执行仓库迁移；后续只补执行未应用的迁移。身份不匹配或已有
其他表的数据库不会被接管。不会复制其他用户、修改既有账本或重置已有测试账号。
完整 API 首次编译路由约需一分钟，启动器等待最多约两分钟；启动超时时先查状态
及日志，仍在加载的进程不会被另一个启动器覆盖。

## 用户验收

1. 登录上述专用账号。首次余额为 0；重复启动保留已有订单、订阅和积分。
2. 在“我的账号”选择支付宝，开通“轻量 · 月付”：199 元、21,000 积分。
   点击“前往支付宝”，在沙箱收银台选择“使用电脑支付”，使用官方沙箱买家
   账号及支付密码完成付款。这里的 199 元使用沙箱资金，不是实际人民币扣款。
3. 支付回跳后点击“返回账户查看支付状态”。产品通过原订单查询确认付款，
   预期当前套餐变为轻量月付、可用订阅积分为 21,000。
4. 再次刷新、重新登录后仍只保留一笔订单和一次发额。不要把回跳页面参数或
   收银台提示单独当成账本已到账的证据。
5. 可另测按需充值：0.01 元对应 1 个永久积分，使用独立订单。不要把先前接口
   演示的订单直接迁入本测试账号；它没有相应的产品账务意图。

订单有效期为30分钟。尚未付款的原订单应继续原付款；过期时由原查询／关闭
流程确认，不能为了重新显示二维码直接改写原订单或伪造付款。

```powershell
# 真实 HTTP + PostgreSQL 边界验证；新增独立 QA 账号，不消费用户测试账号
node scripts/alipay-integration/verify.mjs
# 用户付款后，通过原产品查询并读账本核对，重复查询不再次发额
node scripts/alipay-integration/verify-payment.mjs
```

2026-11-05：Web、API 及依赖构建通过，15 项真实 HTTP／数据库检查通过。
用户通过产品页面创建轻量月付订单，并在真实支付宝沙箱完成 199 元付款。
北京时间 12:06:18，`verify-payment.mjs` 通过原产品 API 查询与独立 PostgreSQL
核对：订单已支付、订阅已激活、21,000 积分到账，且仅有一个关联积分批次和一个
有效订阅周期；重复查询没有再次发额。核验记录位于 Git 忽略的
`.local/alipay-integration/payment-verification.json`。这笔产品订单与此前独立
0.01 元接口演示分别核验，不复用旧付款凭证。

本笔沙箱查询的买家实付仍为 0 分，记录保持原值。199 元订单认证总额用于普通
订阅入账，不能替代退款所需的实付凭证。公网通知与退款尚未完成联调。

当前脚本的 `verify-payment.mjs` 对月付开通或按需充值做精确发额核对；年付、
套餐转换和真实任务扣费不在本轮自动验收范围。

## 边界及停止

- 首次独立 0.01 元付款已取得 `TRADE_SUCCESS`，但沙箱查询返回实付金额为0。
  本环境保持原实付／退款校验，不把订单总额补作实付。若再次出现相同返回，
  普通订阅付款可按认证总额入账，但自动退款和需等额现金凭证的套餐转换仍受限制。
- 没有公网 HTTPS 通知地址，当前验收依赖原订单查询和产品补偿查询。正式上线前
  还需验证真实通知验签、幂等、`success` 回写，以及正式签约、应用和备案状态。
- 模型、文稿生成和真实任务消费未启动。页面保留产品导航，页底固定提示本次范围。
- `.local/alipay-integration/` 保存本地实例、控制令牌、日志及测试记录，全部 Git 忽略。
  数据保留于本 Compose 项目的独立 `alipay_acceptance_data` 卷。

```powershell
# 仅停止本实例 Web/API，保留数据库、账号和订单
node scripts/alipay-integration/stop.mjs
# 如需停止专用数据库（保留卷），先停止 Web/API
docker compose -p bondbuddy-alipay-acceptance -f scripts/alipay-integration/compose.yaml stop postgres
# 下次使用启动步骤恢复，不能删除卷或 instance.json 来重置余额
```

启动和停止均核对本实例状态；停止使用随机控制令牌，不按 PID 强杀进程。
代码属于 PR #872 的支付专项测试交付；本地可测试不代表用户已验收或已发布。
**尚未部署，待用户验收后由指定发布 chat 统一发布。**
