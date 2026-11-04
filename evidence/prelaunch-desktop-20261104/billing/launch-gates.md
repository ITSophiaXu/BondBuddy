# 充值、计费与扣费：正式上线硬门槛

2026-11-04，桌面端。用户明确要求这类场景链路在正式上线前完整通过。**当前结论：未通过正式收费上线验收。** 线上新测试账号余额为 0，正式渠道不可用，真实充值、付费任务恢复、实际扣费及原路退款链路均尚未完成；本地组件通过不能解除这些阻碍。

本轮前段修复源码：`ecfd757407a499026df487f2ab01486687ad860b`，起点为 `7f3c4ac77ef2128a5c9793bc31a20f2b8c84c9e5`。扩大回归又发现月度现金退款使用本地入库月份的报表缺陷，已最小修复并复验，最终提交由主 agent 统一绑定；本目录 `component-results.json` 保存对应源码/编译产物 hash。没有部署。最终发布须重新绑定最终候选 SHA/tree、各实际服务镜像、配置和迁移，不以本地 SHA 代替生产版本。

## 证据层次和放行口径

- **本轮真实组件**：实际 TypeScript 编译产物、Fastify 路由/校验/事务代码、独立 PostgreSQL 16.14。多数 HTTP 断言使用 `app.inject`，不经过公网/Nginx。测试使用真实 SQL 锁、事务、触发器和迁移；并发与故障注入发生在独立测试库。
- **明确的合成依赖**：账号/项目/材料/订单、商户密钥和签名回执、渠道服务、模型调用、文档结果及大多数 Blob 都是 fixture 或内存实现。协议测试会执行真实 RSA/AES/SDK 签名验签和有界本地 mock HTTP，不能证明正式商户已签约或实际收付款。
- **浏览器证据**：真实 Edge 与页面代码，HTTP 账务回执由 Playwright 路由构造；49 项通过只证明前端行为，详见 [账号页证据](README.md)。不与下方组件项相加来声称端到端通过。
- **生产与资金证据**：只认可准确正式商户订单、认证回调/查单、真实买家支付/退款记录、本地原订单/账本/任务及受控读回相互对应。`existing_grant`、直接调用 `grantCredits`、手改 paid、合成 provider 或只访问返回页均不能替代充值。

下面每行都是验收项；“组件通过”只通过该层。当前启用并对外承诺的功能必须同时补齐该行的真实场景证据。尚未开放的自动续费/渠道须保持入口与文案一致，明确排除在本次收费产品之外；不能填写已经通过，也不能仅打开开关后沿用排除结论。正式资金链和文件质量链都通过后才能签署整体上线结论。

## 完整场景矩阵

测试文件下文均相对 `apps/api/src/`；同名 `.test.ts` 编译后可由 `node --test apps/api/dist/<name>.test.js` 执行。证据组 C/R/P/V/S 的实际命令和计数见后文。

| ID | 必须通过的场景与判定 | 当前代码与可执行测试 | 已取得的证据 | 尚缺的真实场景/放行状态 |
| --- | --- | --- | --- | --- |
| B01 | 新用户无余额时不启动付费任务、不预留、不扣费；充值入口可完成补款，准备内容和原请求保留。 | `server.ts`、`billing.ts`、`automatic-billing.pg.test.ts`、`automatic-file-billing.pg.test.ts`、`billing-task-recovery.ts`/浏览器套件。 | C：不足返回 402、无 hold/批次；线上实际新账号开始回答被余额 0 阻止且准备保留。 | **阻断**：线上没有可用充值通路，不能恢复原任务。任务通知仍引导“完成订阅或充值”，账号页才说明不可用；准确提示不等于任务可完成。 |
| B02 | 正式商户/产品/应用身份、密钥权限、可信平台公钥、TLS/回调、时钟、固定出站代理及各服务版本/开关正确；坏配置不开放购买。 | `payment-provider-config.ts`、`wechat-pay.ts`、`alipay-pay.ts`、`scripts/check-payment-deployment.mjs`；配置/协议测试。 | P：非法配置关闭、精确域名/代理要求和输出脱敏通过。工厂有 disabled/ready/invalid；`server.ts` 只取 providers，未提供正式商户 preflight/status 接口。 | **阻断**：生产完整版本、商户安全配置、产品开通和签名网络验收未核实。现有 `/health` 与静态 Compose 检查不证明商户可用；不能仅靠空 providers 区分关闭与坏配置。 |
| B03 | 充值金额与积分精确一致；校验最小/最大、分币、负数、溢出和客户端改价；充值本身不新建业务任务。 | `commerce.ts`、`payments.ts`、contracts `commerce.ts`/`billing-wire.ts`；`commerce.pg.test.ts`、`billing-wire.test.ts`、`billing-int64.pg.test.ts`。 | C/P：真实路由及 PG 验证金额、不可变原单、同键改额冲突、到账后零新增 run；默认金额为十进制字符串。 | **未过资金层**：正式渠道按实际差额收款、一次到账及买家实付对照未做。旧 `/credits/recharge-config` 在新模式中可有意关闭，应以 `/commerce/account` 和 `/subscriptions/catalog` 判定新通路。 |
| B04 | 同 owner/key/hash 的充值/订阅/续订请求幂等；不同 owner、金额、周期或接口不能借键复用或变成第二笔。 | `payments.ts`、`subscriptions.ts`、`checkout-intent.ts`、`billing-wire.ts`；payments/commerce/int64 PG、S、UI49。 | C/P/S 与 UI：原单重放、owner 隔离、legacy v1 原请求约束；未知重载/跨标签仍保留原购买。 | **未过生产层**：正式网络超时、多个真实 API 实例、刷新/重复提交下同一实际订单与资金记录未验证。跨设备发现未绑定旧意图仍有限制。 |
| B05 | 创建请求超时/结果未知不赠分、不另换请求；已持久化且未开单的拒绝可确认结束，原 key 后续永不变成新开单。 | `checkout-intent.ts`、`subscriptions.ts`、迁移 `0164_subscription_checkout_rejections.sql`；S、UI49。 | S：真实 Fastify/PG 持久拒绝与 endpoint/hash/owner 限制；UI：刷新后确认拒绝再选充值。 | **未过真实渠道层**：实际开单超时与认证查原单恢复未做。历史无单且无持久拒绝凭据的 v1 意图仍保守阻断，不宣称全部历史意图恢复。 |
| B06 | 选错金额/渠道时先确认旧单关闭；pending/unknown 不重选；付款胜出按 paid 处理，不把付款抹成失败。 | `closeRecharge`、两渠道 `closePayment`、账号页 close/refresh；`payment-statements.pg.test.ts`、协议测试、UI49。 | R/P：持久关单意图、同原订单查验与付款竞争；UI：已结束才重选，导航回调不覆盖用户离开。 | **未过资金层**：真实未付款关单、付款/关单竞争及同原号 readback 未做。新增关单重选交互还待产品确认，见 README。 |
| B07 | 回调必须原文验签/解密，绑定商户/AppID/provider/订单/金额/币种/交易号；伪签名、重复字段和跨账号订单均不能到账。 | `wechat-pay.ts`、`alipay-pay.ts`、`applyVerifiedPayment`；wechat/alipay unit + PG、payments PG。 | C/P：真实密码协议、本地 mock HTTP、Fastify 和 PG；伪/错回执拒绝，重复和并发回调只入原账本一次，事务提交后才 ack。 | **未过正式商户层**：公网正式回调、代理/证书环境、真实商户签名与本地锁定订单对照未做。 |
| B08 | 回调丢失、数据库失败、浏览器关闭或 API 退出后查原单补账；失败不能 ack，原单不重复收费/发分/创建任务。 | `payment-reconciliation.ts`、`refreshRecharge`；`payments.pg.test.ts`、`payment-reconciliation.pg.test.ts`、alipay PG。 | C/R/P：数据库失败回滚、查单修复、并发领取、原 ID 退避及关闭时等待读取完成。 | **未过运行层**：实际容器故障/重启、商户查询及关闭浏览器后的公网恢复未做；不能用 mock query 证明生产补单调度正常。 |
| B09 | 余额/预留/消费/退款/历史记录使用精确 int64；旧 numeric 客户端不能破坏新数据；非法/超大值拒绝。 | `billing-wire.ts`、`billing.ts`、contracts int64；wire/int64 unit/PG、精确账单 PG。 | C/R/P：超过 `2^53` 的相邻值、精确跨 lot 分配、溢出事务回滚、旧 wire 与签名回调排除变换。 | **未过发布兼容层**：生产 API/所有 worker/Web 同协议版本、历史客户端与真实历史账本 readback 未核实。 |
| B10 | 充值、订阅、历史赠额区分；仅有效可用 lot 可分配，按来源和期限保留精确片段；过期/冻结不重复使用。 | `creditBalanceExact`、`reserveCreditLots`、credit allocation 与 SQL guard；billing/int64 PG、S。 | C/P/S：真实 PG 锁与 immutable allocation；不足/竞争不超用，期限及来源分别保留。单测为分配 fixture，不是现金来源验收。 | **未过真实账本层**：正式支付 lot 的来源、原对价、90 天/永久期限及生产时钟下使用顺序需读回核实。 |
| B11 | 月付/年付真实总价、每月到账、批次期限和已付周期原价保护准确；年付只收一次，月发不再收款。 | `subscriptions.ts`、`automatic-price-versions.ts`；S、`annual-payment-statements.pg.test.ts`。 | S/V：实际 PG 合同、月发、已取消续费后保留年期；账单按一笔现金对十二次额度发放核对。 | **未过资金/时间层**：正式订阅付款、生产调度、跨月到账及与渠道交易对账未做。时间推进仅合成，不冒充已经过真实月份。 |
| B12 | 升档/月转年按原未用现金对价抵扣；消费/任务预留/退款冻结不参与；未知支付保留旧权益，新现金与继承来源守恒。 | `subscription-changes.ts`、funding SQL 与审计；S、`subscription-change-audit.pg.test.ts`、annual statements。 | S/V：真实资金来源/冻结记录、连续变更、分币和退款恢复审计；缺证据不能投影修复出积分。 | **未过资金层**：实际改档付差额、旧自动续费解除、后续真实退款及渠道/账本对照未做。 |
| B13 | 报价绑定准确材料/input/hash/范围与价格版；客户端不能提交任意金额；已付周期与历史合同不被新价重算。 | `scope-quotations.ts`、`billing-price-admin.ts`、`automatic-tariff-repository.ts`；C、`billing-price-admin.pg.test.ts`、S。 | C/V/S：未来版本发布/回滚、权限、旧合同保护和真实新报价；准备/quote-only 不收费。 | **未过产品/运行层**：生产活动价表、实际 SKU 与文件质量链所用输入一致性、真实任务金额需独立核对。成本/费率合成记录不能冒充已核真实成本。 |
| B14 | 两个并发执行或重试只冻结一次；认证/归属、余额、原请求和 quota 都在提交时核验；拒绝任务无扣费。 | `reserveCredits`、server/queue、`execute-quota-billing.pg.test.ts`、automatic billing、billing/review/M4 PG。 | C/R：真实 PG 账户锁、scope 唯一约束和并发 HTTP；quota 拒绝/重试只预留一个任务。 | **未过生产并发层**：真实多服务实例和生产限额组合未测；不得用自造 run/fixture 成功代替从线上 UI 明确开始。 |
| B15 | 成果达到约定交付后结算一次；排队/进度/供应商内部重试不追加任务费用，未交付不算收入。 | `queue.ts`、outcome/automatic/review/M4 billing；`billing.pg.test.ts`、`outcome-billing.pg.test.ts`、automatic review/file PG。 | C：真实预留/结算事务、合成双 Word/报告交付和重复 finish；进度不另扣款。 | **阻断真实成果层**：本轮未生成并独立确认合格真实成果；文件质量门槛见另一矩阵，旧代码允许未做质量审查的交付不能签为完整上线通过。 |
| B16 | 失败/有效取消释放未结算预留；已结算不被取消伪造退现金；批次按每份已交付成果结算，失败部分可原价重试。 | queue、project-file/workpaper/M4；C 的 billing/outcome/automatic-file/fixed M4/review。 | C：实际 PG 释放、已完成前驱不重收、每份不同合同、失败重试和手动暂停边界。 | **未过真实 worker 层**：真实模型失败/取消/进程恢复下预留与实际成果的一致性未做。 |
| B17 | 补款后只恢复原命名任务、同 owner/原 key/原 body/范围；不能恢复其他任务或覆盖后续手动暂停/取消。 | `billing-task-recovery.ts`、`subscription-billing-page.ts`、workpaper actions；C automatic-file、UI49、Web 单元。 | C：实际底稿不足/恢复幂等；UI：可信 paid 回到准确任务，取消等待不恢复；本地存储失效拒绝不安全新意图。 | **阻断端到端层**：实际充值后恢复线上原三题/原底稿任务、真实交付与只扣一次尚未完成。UI fixture 与 API 单测分开，未拼接成真实全链路。 |
| B18 | 原范围更正/平台重试包含；新增独立业务不能凭零价或历史覆盖免费执行；来源退回后失效覆盖不能继续用。 | `commerce-coverage.ts`、scope/input 锁；outcome PG、`commerce-coverage.pg.test.ts`、automatic-file PG。 | C/V：真实父链/settlement/版本/owner，单次消费与并发，已更正覆盖撤销；合成业务判断。 | **未过真实业务层**：真实任务输入、原成果、更正与新范围边界需独立专业复核，不能由测试 label 代表判定正确。 |
| B19 | 质量返分按独立条目/原 allocation 逆转，独立权限批准、并发累计不超原扣费；保留原现金权益，不把返分变赠额。 | `task-refunds.ts`、`billing-permissions.ts`；`task-refunds.pg.test.ts`、权限 PG、automatic-file PG。 | C/R：真实审批/授权/不可变历史、各条目/cross-lot、并发返分与 int64 回滚。测试授权与用户均合成。 | **未过运营层**：正式可用的独立审批账户、真实任务售后决策、返分来源及后续退款核验未做。 |
| B20 | 现金退款只基于原已认证实付、可退来源、未用未冻结金额；赠额不可提现；订阅按整期/7 天条件，年付按全合同退款并停止余下发放。 | `payment-refunds.ts`、refund calculation、S annual PG；`payment-refunds.pg.test.ts`、alipay PG。 | R/P/S：实际 PG 可退资格/冻结/原 A/Q 累计分币、历史加赠、不同 lot 现金上限、单合同年度退款。 | **阻断资金层**：真实原支付买家实付证据、实际原路退款及买家收到款未做。支付宝本次买家退款字段可用性需按商户核实；缺证据保持冻结。 |
| B21 | 退款受理不等于到账；未知/超时保留冻结，按同退款号查询/安全恢复；明确失败才释放，回调/查询并发不多退。 | `payment-refunds.ts`、reconciliation、wechat/alipay refund adapter；R/P。 | R/P：冻后崩溃、派发前后未知、同号恢复、并发现金/消费、真实签名 mock 及错误身份拒绝。 | **阻断资金/运维层**：真实退款创建/查询/失败/未知恢复、原路到账、服务重启及报警处置未验收。 |
| B22 | 停止续费只停止下一次扣款，保留已付周期/有效积分；授权 pending/cancel_pending 不冒充开启/完成。 | recurring 公共接口、subscriptions、S/UI49。 | S：合成 recurring provider 的签约/代扣/解约与年期保留；UI 状态正确。真实微信 Native/支付宝 Web 无 recurring 适配器。 | **未实现真实续费**：正式产品若承诺自动续费则阻断；当前必须保持未开放，不能用普通 Native/Web 支付或模拟代扣通过。 |
| B23 | 账单按认证付款/退款日期、商户/AppID/原单/现金/积分核对；迟到回执重开旧账；账单差异不直接修余额。 | payment/alipay statement、refund dates、billing audit、subscription facts；R、V annual、P、F。 | R/V/F：真实 PG 账单证据/差异/并发领取与日期重核，精确大整数；修复退款管理现金流误用本地月份，按认证成功日归月，缺日期明确 unknown。CSV/下载文件与渠道回执均为合成。 | **未过正式对账层**：真实商户交易/资金账单、实际格式、手续费与跨日退款核对未做；未知配置仍需明确 unknown。不能只用账本自洽代替渠道对账。 |
| B24 | 账实异常先隔离对应钱包/商户；原单查询/取消可用；修复只修可证投影，独立权限、审计和重新核验后恢复。 | `billing-safety.ts`、billing ops/SQL guards；safety + integration PG、subscription-change audit。 | R/V：真实事务/锁、直接 SQL 写入保护、跨钱包隔离、错误资金来源拒绝修复和溢出保护。 | **未过运营层**：生产告警能被看见、操作者权限、真实事件演练与受控恢复读回未做。API logger 为 false，不把 app.log 警告当已可观测；数据库告警证据需独立核对。 |
| B25 | 原订单超过最近 50 条仍按原类型/期限/退款规则展示；丢失/错配原订阅数据不误判永久充值；记录不泄漏别人订单。 | `subscription-order-detail.ts`、history 与 refunds UI；order-detail PG/UI49。 | R/UI：第 51 条原单、十进制字符串、foreign/unknown 一致 404、丢失依据时退款关闭。 | **未过真实历史层**：真实历史样本与旧客户端兼容读回未做。 |
| B26 | 发布与运行版本、迁移、协议、备份、排空、回退、smoke 和资金读回完整；不混入模拟适配器。 | `deploy/m1`、支付部署 checker、`BILLING-UPGRADE-RUNBOOK.md` 和发布指南。 | P：合成配置反例；本地模板迁移可用，不代表部署。 | **阻断发布层**：未部署本轮候选，未核全部生产服务版本/迁移/配置与可用回退；SSH/受控发布通路缺口未解除。不能绕过正式发布流程。 |

## 本轮实际组件验证

环境：Windows，Node `v26.13.0`，PostgreSQL `16.14`，API TypeScript 编译 exit 0。仅恢复专用 `.local/prelaunch-payment-pg`、loopback `127.0.0.1:55434`；没有重新 initdb，没有连接生产或其他既有数据库。模板 `bb_prelaunch_payment_template` 有 **168 个迁移文件记录**，最新 `0164_subscription_checkout_rejections.sql`（文件数量与编号不同）。

各 PG 文件通过 `isolatedTestDatabase` 从该模板创建独立随机后缀副本，测试结束自动删除；模板不承载测试数据。连接凭据只有本机合成测试用途，不进入本证据。测试中的 `grantCredits` 仅为部分单项准备合法账户状态，不列作真实充值证据；payments/commerce/协议 PG 另走实际开单及验证回执入账代码。

| 组 | 实际结果 | 日志与边界 |
| --- | --- | --- |
| C：充值与任务计费 | **34 passed / 0 failed / 0 skipped，92.260 秒，exit 0**；28 个顶层测试加 6 个子测试。 | [component-core.tap](component-core.tap)，11 个文件；真实 Fastify/PG，模型/支付/Blob 合成。 |
| R：退款/补单/隔离/账单 | **66 passed / 0 failed / 0 skipped，187.093 秒，exit 0**；57 个顶层测试加 9 个子测试。 | [component-refund-recovery.tap](component-refund-recovery.tap)，11 个文件，前段源码 `ecfd757`。 |
| P：签名协议/精确金额/配置 | **64 passed / 0 failed / 0 skipped，32.790 秒，exit 0**。 | [component-protocol.tap](component-protocol.tap)，10 个文件；含 3 个真实 PG adapter 集成场景，其余为 mock/单元/配置。 |
| V 首轮：价格/范围/合同资金审计 | **22 passed / 3 failed / 0 skipped，66.736 秒，exit 1**；25 计数含嵌套。 | [component-price-coverage.tap](component-price-coverage.tap)，4 个文件；失败是同一报表日期缺陷的两个渠道子测试及父测试，不是 3 次实际资金丢失。原日志保留。 |
| V 修复后：同一 4 文件复验 | **25 passed / 0 failed / 0 skipped，49.641 秒，exit 0**。 | [component-price-coverage-green.tap](component-price-coverage-green.tap)；未改 annual 测试预期或退款资金逻辑。 |
| F 先红：新增报表 PG 回归 | **1 passed / 2 failed / 0 skipped，23.820 秒，exit 1**。 | [component-refund-facts-red.tap](component-refund-facts-red.tap)；旧实现两渠道已认证 1 月退款应为 2500，实际 0。 |
| F 修复后：报表及关联消费者 | **18 passed / 0 failed / 0 skipped，49.968 秒，exit 0**；12 个顶层测试加 6 个子测试。 | [component-refund-facts-green.tap](component-refund-facts-green.tap)，4 个文件；含报表 PG 3 项（两渠道生命周期）、unit 6 项、funding unit 2 项、task-refunds 7 项。task-refunds 与 C 重叠，不相加。 |
| CLI 实际进程 smoke | **exit 0**；版本、JSON 精确零值和空库结构通过。 | [component-refund-facts-cli.json](component-refund-facts-cli.json)；空的独立 PG 副本，只证明 CLI 输出可读取，退款场景在 F 中验证。 |
| S：此前订阅修复回归 | 主 agent/支付子任务报告 **36 passed / 0 failed / 0 skipped**；源码与 `ecfd757` 一致。 | billing-wire、billing-int64 PG、subscriptions、annual subscriptions、subscription changes；原记录见[总证据](../README.md)。与本轮 P/C 的 wire/int64 重叠，**不相加**。 |

实际命令（仓库根目录；运行前为当前进程设置 `BB_TEST_DATABASE_URL` 指向上述专用模板，省略合成凭据）：

```powershell
npm exec tsc -- -p apps/api/tsconfig.json
# exit 0

# C
node --test --test-concurrency=2 --test-reporter=tap apps/api/dist/payments.pg.test.js apps/api/dist/commerce.pg.test.js apps/api/dist/billing.pg.test.js apps/api/dist/outcome-billing.pg.test.js apps/api/dist/automatic-billing.pg.test.js apps/api/dist/automatic-review-billing.pg.test.js apps/api/dist/automatic-file-billing.pg.test.js apps/api/dist/m4-fixed-billing.pg.test.js apps/api/dist/review-billing.pg.test.js apps/api/dist/billing-int64.pg.test.js apps/api/dist/task-refunds.pg.test.js

# R
node --test --test-concurrency=2 --test-reporter=tap apps/api/dist/payment-refunds.pg.test.js apps/api/dist/payment-refund-dates.pg.test.js apps/api/dist/payment-reconciliation.pg.test.js apps/api/dist/billing-safety.pg.test.js apps/api/dist/billing-safety-integration.pg.test.js apps/api/dist/subscription-order-detail.pg.test.js apps/api/dist/payment-statements.pg.test.js apps/api/dist/payment-statements-exact.pg.test.js apps/api/dist/alipay-statements-normalized.pg.test.js apps/api/dist/billing-permissions.pg.test.js apps/api/dist/execute-quota-billing.pg.test.js

# P
node --test --test-concurrency=2 --test-reporter=tap apps/api/dist/payment-provider-config.test.js apps/api/dist/wechat-pay.test.js apps/api/dist/wechat-refunds.test.js apps/api/dist/wechat-pay.pg.test.js apps/api/dist/alipay-pay.test.js apps/api/dist/alipay-pay.pg.test.js apps/api/dist/payment-refund-calculation.test.js apps/api/dist/billing-int64.test.js apps/api/dist/billing-wire.test.js scripts/check-payment-deployment.test.mjs

# V
node --test --test-concurrency=2 --test-reporter=tap apps/api/dist/billing-price-admin.pg.test.js apps/api/dist/commerce-coverage.pg.test.js apps/api/dist/subscription-change-audit.pg.test.js apps/api/dist/annual-payment-statements.pg.test.js

# F 先红（仅新增PG测试，修复前编译后运行）
node --test --test-concurrency=1 --test-reporter=tap apps/api/dist/subscription-facts-report.pg.test.js

# 修复后再次 API tsc exit 0，V 原命令不变；F：
node --test --test-concurrency=1 --test-reporter=tap apps/api/dist/subscription-facts-report.test.js apps/api/dist/subscription-facts-report.pg.test.js apps/api/dist/subscription-funding-evidence.test.js apps/api/dist/task-refunds.pg.test.js

# CLI 在 helper 创建的独立空副本执行，外层脚本校验 JSON 后自动删除副本：
$env:DATABASE_URL='<isolated-test-clone>'
node apps/api/dist/subscription-facts-report.js 2026-01 2026-02
```

各 TAP node 命令实际以 `2>&1 | Tee-Object -FilePath evidence/prelaunch-desktop-20261104/billing/<对应文件>.tap` 留存完整输出，并以 `$LASTEXITCODE` 返回。Node 计数含嵌套子测试；不是业务场景数或真实资金订单数。计数之间存在重跑与交叠，不汇总为端到端通过率。

## 本轮新发现及修复：迟到退款现金流月份

原 annual 场景两渠道都明确认证：付款 `2026-10-27T04:00:00Z`，退款成功 `2026-10-27T05:00:00Z`。付款538920分，成功退款489020分，10月应剩49900分；原报表却按11月本地 `bb_payment_refund_events.created_at` 扣退款，显示10月净流入538920分。原路退款只创建一次、55000积分旧权益恢复和账务审计此前均通过，缺陷在只读管理报表，不是资金来源丢失。

`subscription-facts-report.ts` 仍以唯一 succeeded event 取退款金额，关联同 owner、原退款 ID 的认证 `provider_succeeded_at` 来归北京时间自然月；没有修改钱包、退款、SQL迁移或财务事件 writer。缺成功日期时保留 `cash_refunded_fen_known` 与 `unallocated_cash_refunds`，各月完整退款额及净现金流为 null，不能借本地时间或静默过滤为 0。输出升为 `subscription-facts-exact-v2`；仓内消费者仅为 annual/task-refunds/funding/report 测试和 CLI 文档，无 Web/HTTP DTO 消费者；历史 release manifest 不改写。

新增两渠道真实 PG 回归验证：1月付款、1月末15:59:59Z退款归1月；16:00:00Z退款归2月；11月迟到入库不再扣一次；无成功日期明确未知；同原退款号 query 补证只归月，不增减钱/积分/财务事件，重放 callback 和再次 query 也不重退。unit另覆盖 as_of 边界及超过2^53的未知金额。每次报表读前后核对完整财务 snapshot 不变。`task_flow_audit` 只读独立复核未发现阻碍性问题。

专用数据库最终核对：剩余测试副本0、其他客户端连接0，确认数据目录与端口后 `pg_ctl -m smart -w stop` exit0；最终 `pg_ctl status` exit3，`127.0.0.1:55434` 连接为 `ECONNREFUSED`。受限令牌第一次无法发送stop信号，经已批准提升后只停止该专属实例，未强制终止其他进程。见 [postgres-cleanup.json](postgres-cleanup.json)。日志与源码/编译产物 SHA256 见 [component-results.json](component-results.json)。

## 尚须完成的最小真实验收

1. 在获准发布版本与原生产 stack 上，由授权运维核对所有服务镜像、迁移、账务开关、安全商户配置、代理、回调、时钟、受控诊断与告警读回。工厂 ready 只代表本地配置结构可装载，仍不代表产品签约和收款验收。
2. 使用独立测试账号，在真实 UI 保留一项明确付费任务及准确报价，从该任务原恢复入口按实际差额创建一个正式渠道订单。真实买家完成付款，核对渠道实付/交易号/原订单与一次入账；不得手工 paid 或赠分。
3. 不另点第二个开始，验证准确原请求恢复、真实 worker 交付、独立质量复核、一次预留/结算及下载；分别验证实际失败/取消、并发/重复请求和未知结果恢复，核对原准备、成果和资金片段。
4. 用独立未消费资金场景核对真实原路退款资格、冻结、认证受理/查询、买家到账、重复回执/未知重试与最终账本。订阅另覆盖真实合同、整期退款和期限；若开放改档或自动续费，补齐相应正式产品/适配器的场景，不能只测单次充值。
5. 取得正式渠道次日/跨日交易和资金账单，核对商户/应用、原现金/积分、退款与手续费差异，完成异常告警、隔离及受控恢复演练。由发布负责人和独立复核人登记准确证据引用与结论，再与文件质量矩阵共同决定上线。

这些步骤未执行完之前保持“未通过”；没有把无法接通正式商户解释为可跳过的环境项。本轮没有部署、真实购买/退款、生产发分或客户材料调用。
