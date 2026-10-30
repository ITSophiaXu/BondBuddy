# 订阅管理与即时转换 Web 验收

2026-10-30。合成 HTTP 及浏览器用例，不代表真实商户付款或付费意愿验证。修改基于共享工作区 HEAD `4ec6b285`；提交由 root 统一完成。产品依据为 `docs/product-decisions/2026-10-30-subscription-changes.md`。

## 已实现

- 账户概览突出当前档位、付款周期、每月额度、本期有效期和升级／管理入口。自动续费开关、原渠道授权链接、下次扣款金额／日期移入管理订阅，支持 `#/account?view=subscription` 和返回概览。
- 停止自动续费只使用一次确认；明确保留当期有效积分、已付年期的剩余月发额度，不自动发起退款。原渠道解约结果未明确时保持核对状态，不宣称已解约。
- 当前月付可即时升更高月付，或转同档／更高档年付。已付年期中途改档及降档仍不可选。转换摘要显示新套餐总价、按原实付对价计算的抵扣、本次实付、新周期与月发额度；金额只接受服务端快照。
- 支付确认之前保持旧套餐及转换积分预留；确认后显示新周期和月发计划，新续费未授权时不会显示已开启。
- 历史原期标记“已转换至新套餐”，原在途任务预留单列。转换订单分别显示“方案原价／原额度抵扣／本次实付”，避免把补款误当成套餐价格；转换退款提示原积分恢复不会重启原订阅周期或续费。
- `subscription_change` 付款意图保存原 quote、周期、provider 和 request ID，未知付款跨刷新重放同一请求。`SUBSCRIPTION_CHANGE_MANDATE_PENDING` 保持原意图；只有服务端持久终结的 `SUBSCRIPTION_CHANGE_QUOTE_STALE` 能保存终态拒绝并允许观察者使用新 key。拒绝记录保留，不删除幂等屏障。跨页面读到未亲自核实的拒绝，需先核对原付款摘要。
- 原型保持纯内存合成模式，可通过 `?subscription=1&scenario=professional-monthly` 或 `scenario=professional-partial` 展示全额／部分未用情景。没有连接账户或支付 API。

## 官网参考

2026-10-30 经 CUA 只读访问；没有登录、购买或读取他人的付费账户。

1. <https://claude.com/pricing> 的 **Managing your plan** FAQ：管理入口在 Settings > Billing > Manage subscription；升级立即生效，月转年可抵扣旧期价值，降档期末生效；取消保留当前有效期。借鉴信息层次和直接可达的取消路径。Claude 使用剩余时间抵扣，BondBuddy 严格使用已确认的未用积分原实付对价，未照搬其计算规则。
2. <https://www.workbuddy.cn/pricing/>：付款周期切换置于套餐卡上方，用量、使用场景和单次补量入口分开呈现。未据其登录后的页面推断取消或退款规则。

本增量没有重新访问 ChatGPT 付费内部页，也未把此前比较中的未核实状态当成新证据。

## 自动化结果

使用 root 已运行的 `http://localhost:5189`，Edge，单 worker。未启动／重启服务，未修改默认 demo 账户。

| 检查 | 结果 | 证据 |
|---|---:|---|
| checkout-intent 单元测试 | 13/13 | `node --test apps/web/dist-test/checkout-intent.test.js` 工具结果 |
| 全账户浏览器回归 | 37/37 | `web-account-change-full.log` |
| 新增转换定向测试 | 6/6 | `web-change-flow.log` |
| 最终移动／桌面截图与溢出检查 | 2/2 | `web-change-responsive.log` |
| Web TypeScript + Vite production build | 通过 | `web-change-build.log`，531 modules；仅现有 bundle 大小警告 |
| 原型 `node --check`、相关 `git diff --check` | 通过 | 工具结果；仅行尾提醒 |

六条新增路径覆盖：专业月付未用 55,000 积分升密集月付补 ¥500；转专业年付补 ¥4,890.20；剩 27,500 积分转年付补 ¥5,139.70；摘要变化需显示新补款再支付；未知支付和解约核对中跨刷新保持同一 key／quote。全账户回归同时覆盖原月付／年付、充值、续费、退款、旧订单、等待任务恢复和历史查询。

## 视觉证据

截图位于 `ui-changes/`。Web 与原型的卡片、管理区和弹窗共用同一组布局样式；实现按钮显示实际支付动作，原型明确写“模拟”。不同的账号、日期、历史记录和合成说明属于测试数据差异。

- `subscription-professional-monthly-to-annual-quote-detail-1440.png`：Web 桌面摘要局部，已人工目视核对金额和生效说明。
- `subscription-annual-quote-detail-390.png`：Web 390px 摘要，无横向溢出，付款与返回按钮完整。
- `subscription-management-annual-1440.png`、`subscription-management-annual-390.png`：Web 管理区，取消按钮直接可见，年度剩余月发权益及下次整年扣款明确。
- `prototype-management-desktop.jpg`：CUA 原型管理页，root 已目视确认层次。
- `prototype-cancellation-desktop.jpg`：一次取消确认。
- `prototype-annual-quote-1440.jpg`、`prototype-annual-quote-390.jpg`：CUA 原型相同断点摘要，已目视核对。

整页 Web 截图含本地固定合成环境横条；原生 dialog 在 full-page 截图中仅覆盖当前视口，可能造成拼接观感，因此交付查看以 `quote-detail` 局部和正常 CUA 视口图为准。没有隐藏或删除测试横条。原型额外的 clip 截图调用超时，未生成文件、未作为证据，浏览器 viewport 已恢复。

## 交接

本次 Web／原型实现、回归和构建完成。root 负责后端 core 冻结后的统一构建／重启，以及用独立账号进行真实本地 API／PostgreSQL 页面闭环；本报告不把合成响应测试写成真实支付渠道验证。
