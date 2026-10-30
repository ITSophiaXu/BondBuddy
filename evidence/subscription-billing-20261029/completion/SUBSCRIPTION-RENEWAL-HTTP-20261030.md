# 月续费与年付月发额：本地真实HTTP验收

2026-10-30，合成支付渠道、真实产品API、真实隔离PostgreSQL。没有外部支付调用、模型调用或模型任务。本记录不代表真实商户联调。

命令：`node scripts/billing-functional/subscription-renewal-verify.mjs`。

首次执行于02:29:34Z至02:29:36Z完成，**12通过、0失败**。使用4个新注册的 `billing_renew_*` 账号；每个账号仅推进自己的订阅测试时钟，不查询或修改默认演示账号。账号、订单、实例及launch身份见[原始JSON](subscription-renewal-http-20261030.json)。

- 月付轻量到期续扣199元并新增21,000积分，同一推进请求重放不重复扣款/发额；另一个随机账号的订单、余额及clock快照不变。
- 取消自动续费后再到期，不新增扣款或月额度；新建模拟provider对象仍读到原持久化取消结果。
- 年付轻量只支付2,149.20元，首月21,000积分；即使取消明年续费，下一月仍发21,000积分，原年度合同结束日和总支付笔数不变；同一请求重放不重复发额。
- 未知续扣结果保留一个pending订单，重复调度/重新创建provider后查询仍pending，不发额度；明确失败不发额度并停止自动续费。
- 匿名及缺CSRF的时间模拟请求被拒绝；真实catalog提供年付9折及自动续费能力。

本地clock只影响订阅合同和发额，钱包90天过期、会话、其他业务仍按真实时间。故本次验收不覆盖钱包过期行为。价格、扣款确认、合同与积分记账均走生产API逻辑；测试脚本只替换本地渠道收据和专用账号clock。

## 发现与修正记录

1. **静态发现，未执行HTTP失败**：最初模拟授权URL为 `http://localhost`，与生产只接受HTTPS的约束不符。改为保留域 `https://billing-functional.invalid/mandates/...`；本地Vite注入的授权脚本把这类链接改为本地账户链接，并将点击转交产品已有的刷新授权按钮。生产HTTPS约束未减弱。本次真实HTTP已成功调用创建授权和刷新授权。
2. **真实启动失败**：统一应用0159后首次启动本地provider覆写clock时，省略现有输入参数名触发PostgreSQL `42P13: cannot change name of input parameter "p_owner"`。仅将`CREATE OR REPLACE`签名修为`bb_subscription_clock(p_owner text)`，没有DROP函数、重建库或重置账本。错误原文保留在[启动失败摘录](subscription-renewal-startup-42P13.log)，随后由主代理重新启动同一实例，本次HTTP验收通过。
3. API开发期间发现真实clock的微秒精度与JS Date毫秒精度可能冲突。API agent修正默认clock为毫秒精度真实时间，并另测无模拟clock覆盖的首发；本地fallback与之保持一致。本记录不把该独立API测试计入12项HTTP结果。

新版默认支付流程已关闭支付卡并在账户显示成功notice，旧`browser-verify.mjs`的paid helper已同步该预期；本轮未重跑旧完整浏览器任务链，原`product-recovery-verify.mjs`保持不变。

## 单年度方案的真实浏览器补充

新增独立脚本 `scripts/billing-functional/subscription-annual-browser-verify.mjs`，2026-10-30 02:33:26Z至02:33:31Z首次执行 **6通过、0失败**。使用一个新账号 `billing_annual_ui_2f35173a`，独立Microsoft Edge/Playwright context，实际页面点击年付轻量购买、模拟付款刷新、自动续费开关、本地化授权链接、取消开关及测试台下月发额。未重新执行旧整套任务链。

已核对真实API回执与该账号数据库：仅一笔2,149.20元年费，首发21,000积分，取消未来续费后次月累计42,000积分，合同结束日不变，已发2个月，模型run为0。点击本地化授权链接确实触发 `/auto-renew/refresh` 并确认active，未打开新tab；捕获到的保留域请求及其他外网请求均为0，浏览器异常0。未拦截或替换产品API响应；外网拦截保护若触发仍计为测试失败。

[原始浏览器报告](subscription-annual-browser-20261030/billing_annual_ui_2f35173a/result.json)及已查看截图：

- [支付卡收起，首月21,000积分](subscription-annual-browser-20261030/billing_annual_ui_2f35173a/01-annual-paid-first-month.png)
- [授权链接已本地化](subscription-annual-browser-20261030/billing_annual_ui_2f35173a/02-localized-authorization.png)
- [真实授权刷新后开关开启](subscription-annual-browser-20261030/billing_annual_ui_2f35173a/03-renewal-enabled.png)
- [取消后次月发额，42,000积分且仅一笔年费](subscription-annual-browser-20261030/billing_annual_ui_2f35173a/04-second-month-issued.png)

查看第三张截图时发现状态提示尚保留旧的“请在支付渠道完成授权后刷新状态”，尽管开关和下次扣款已正确更新。此为新发现的展示提示问题，已单独交给UI负责代理处理；原截图保留，不把它误记为支付或授权失败。
