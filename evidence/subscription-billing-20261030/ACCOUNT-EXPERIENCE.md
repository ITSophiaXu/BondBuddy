# 账户订阅与充值体验：2026-10-30 增量验收

用户要求支持月续费和取消、年付优惠、移除任务价表、实时充值积分预览及付款完成返回账户，并参考 ChatGPT、Claude、WorkBuddy 改善展示。年付规则已确认为月价×12×9折、积分按月到账。本记录针对该增量；支付渠道为模拟，API、身份验证、订阅及钱包为本地真实实现。

## 页面与计费行为

顶部展示可用积分和当前订阅；套餐用月付／年付切换和三张可比较卡片展示。年付同时显示整年实付、折合月费、节省10%和每月到账积分。充值独立成区，输入金额下方立即显示积分及永久有效说明；历史和完整规则保留在下方，账户不再展示任务价表。

默认付款完成收起支付卡，成功提示约5秒后消失，重进账户不再提示旧付款。历史订单详情及现金退款入口保留，原任务补款的自动恢复优先。当前订阅标识同时匹配档位和付款周期，不把未购买的年付标成已订阅。

月付可显式授权自动续费并取消；年付一笔付款只发首月，余下11个月按合同周年日期发放，各批到账后90天有效。取消续费保留已购年期。原支付对价、整数金额、未知付款幂等及7天未消费整单退款分别验证；不把预收全年费用当作12笔收入。

## 验证证据

|范围|结果|证据|
|---|---|---|
|年付账本、退款、实际任务结算及精确金额契约|最终20/20通过、0跳过；含真正未覆写的生产默认时钟、12批发额、取消和重开授权|[最终日志](../subscription-billing-20261029/completion/annual-core-tests-final-20261030.log)|
|旧月订阅兼容|旧9个子场景通过；保留旧请求哈希与原订单读取，早期失败及修正日志分别保留|[第二轮日志](../subscription-billing-20261029/completion/annual-core-tests-second-20261030.log)|
|真实HTTP、PostgreSQL及模拟续费渠道|12/12通过；4个新账号，月续扣、取消、年付月发、未知/失败、同键重放和归属隔离|[HTTP说明](../subscription-billing-20261029/completion/SUBSCRIPTION-RENEWAL-HTTP-20261030.md)|
|真实Edge页面→真实接口→数据库|6/6通过；新账号完成年付、授权链接、取消及测试台次月发额；0外网请求、0页面异常、0模型任务|[原始结果](../subscription-billing-20261029/completion/subscription-annual-browser-20261030/billing_annual_ui_2f35173a/result.json)|
|页面专项与原型对照|30项初轮29通过，修正测试标签操作后该项通过；购买意图单元11/11；最终改动5/5，随后标签/原型2/2|[Web报告](WEB-FUNCTIONAL-VALIDATION.md)|
|最终Web编译和授权提示|最后授权提示1/1通过，当前TypeScript及Vite构建通过|[构建日志](web-build-final.log)、[提示测试](web-mandate-message-final.log)|
|公共契约检查|`npm run check:contracts`退出0；25项主测试、29项OCR契约、11项绑定测试及示例检查通过|本轮工具命令记录；不计作真实模型或支付测试|
|迁移及保留测试数据|独立空库顺序迁移通过；现有功能测试库升级到0159，共160条，重启前后演示账号订单、批次、余额及冻结一致|[空库日志](../subscription-billing-20261029/completion/annual-migrations-final-20261030.log)、[服务升级](service-upgrade.json)|

Web功能用例采用合成API夹具，真实Edge整链则没有拦截或替换产品响应；这两种证据不混称。最终视觉在1440×960和390×844视口检查，与同步的独立合成原型比较。原型和实际页的数据、历史记录不同，套餐和充值组件的结构、金额和单位一致。原型对应 `product-prototype/public/subscription-account-prototype.js` 与 `subscription-experience-prototype.css`，实现对应 `apps/web/src/subscription-billing-page.ts/.css`；同本次提交保存，前序基线为 `5279a94d`。

已查看的最终截图：[年付套餐](ui-final/subscription-final-annual-plans-detail-1440.png)、[桌面充值](ui-final/subscription-final-topup-detail-1440.png)、[手机充值](ui-final/subscription-final-topup-detail-390.png)、[原型年付](ui-final/subscription-final-prototype-annual-plans-detail-1440.png)。本机黄色合成测试说明保持可见，组件截图未擦除或伪造页面内容。

## 发现与修复

保留早期PG测试夹具、审计SQL与时钟精度失败记录。模拟器的HTTP授权URL在静态审阅时发现与生产HTTPS要求不符，修为保留域并由仅本地注入的脚本转换为本地授权操作；真实Edge证实没有请求该域或任何外部站点。生产HTTPS要求保持不变。

0159成功应用后，首轮本地启动因函数覆写遗漏既有参数名出现42P13；仅修正参数名后重启原实例，没有删除函数、重建数据库或重置余额。真实Edge还发现授权成功后的旧提示未更新，已修正为“自动续费已开通”，单项1/1通过；原截图如实保留，不冒充修复后重拍。

## 本地使用与边界

- 产品账户：<http://localhost:5189/#/account>；测试台：<http://localhost:5189/__billing-test>。
- 模拟付款无需扫码，点击“刷新支付状态”确认到账；自动续费在本地授权后可用测试台“模拟下期续费／额度发放”验证。
- 账号 `billing_tester` 的现有数据保留；验证使用另外的随机账号。测试时钟只影响订阅，不用于证明钱包90天过期或会话有效期。
- 官方参考及取舍见[产品决定](../../docs/product-decisions/2026-10-30-annual-subscription-experience.md)。只观测官方公开页，不宣称实测其登录后支付和退款流程。
- 真实商户SDK、正式签约扣款、生产部署及客户付费意愿仍按用户决定留待后续。此次未重新测算商业需求，不以模拟订单证明收入或60%净利。
