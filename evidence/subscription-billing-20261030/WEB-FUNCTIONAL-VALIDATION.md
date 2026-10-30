# 订阅账户功能与界面验证

2026-10-30。本记录是 Web 定向功能与本地界面证据，不是正式商户付款、真实自动续费或生产发布验收。

## 本轮行为

- 月付／年付切换：月价 199／499／999 元，年付整年实付 2149.20／5389.20／10789.20 元。每月积分不变，各批到账后 90 天有效；年付页面明确一次付款、分 12 个月到账。
- 当前订阅提供自动续费开关。下次扣款时间、金额读取服务端字段；首次单次付款不会自动签约。授权待确认和解约待确认保持独立状态。取消年付续费保留本期截止和剩余月发额度。
- 账户移除任务价表入口及整块展示，历史任务范围与消费记录继续保留。服务端价表、任务范围及历史收费不修改。
- 自由充值每次输入即精确显示到账积分，1 元＝100 积分；非法值提供就地校验，不创建付款请求。
- 新付款路线以 `checkout=1` 标识；服务端确认 paid 后默认回账户总览并用简短提示代替中央支付卡。显式历史 `order` 详情继续展示支付及退款。未知付款意图不清理，已认证终态保留，旧标签不能据本地状态自动新建付款。原业务任务自动恢复先于成功收起处理。

## 验证

- `npm run build -w @bondbuddy/web`：通过（TypeScript 与 Vite）；有既有大 chunk 提示。
- `npx tsc -p apps/web/tsconfig.test.json` 后运行 `node --test apps/web/dist-test/checkout-intent.test.js`：11/11 通过。覆盖年／月周期切换、未知原单重放、旧月付请求正文、历史订单原值与 int64 精度。
- 使用现有 `http://localhost:5189`，`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `subscription-account.spec.ts`，排除尚待同步的 prototype 一项：首轮 29/30 通过。唯一失败为新增测试未先切换充值记录标签就查找“查看订单”；修正测试交互后该项 1/1 通过。
- 另对“授权→取消→再次授权→再次取消”单项 1/1 通过，验证每次新操作使用新幂等键，未确认操作仍保留原请求。
- 原任务恢复、取消等待、异账号隔离、跨标签未知付款、原订单退款详情缺失、超最近 50 期原订单与旧价格历史等既有账户测试均在上述定向套件通过。
- `git diff --check -- apps/web`：无空白错误；仅工作区 LF/CRLF 提示。

## 界限

浏览器请求使用合成 API fixture，不发起真实支付、签约、模型任务或现金退款。沿用主代理管理的 Vite，本代理未重启现有服务。`ui/` 图片是早期功能中间态，最终界面图片另存 `ui-final/`。

## 最后界面与成功提示

- 依据主代理整理的公开产品参考，在既有账户结构内把当前订阅放到购买区上方；三档用途、整年主价、折合月价及省10%、月积分和按钮对齐。年费主价不会被折合月价替代。
- 单次充值独立分区，金额输入框下堆叠精确到账积分与兑换关系；历史记录与完整规则在下层。当前套餐 badge 与按钮同时核对 plan 和 billing_cycle，其他不可购买档位显示“到期后可选”。
- 成功提示仅用于刚核实的付款或原付款流程回跳，约5秒自动消失；重新打开普通账户不会重现旧成功提示。成功计时器不会清除其他提示或错误，原 terminal intent 继续保留作幂等屏障。
- 年付支付详情区分全年承诺积分和每月到账积分；不把 `credits_expires_at` 的首批到期显示为全年统一到期。当前卡保留全年合同截止和剩余月发权益。
- 最终约定5项功能/视觉用例全部通过，23秒，见 [web-final-five.log](web-final-five.log)。其中成功付款用例明确断言5.1秒后提示消失、重载不复现、原订单和退款仍可从历史打开。
- 最后按 plan＋cycle 修正当前订阅 badge／按钮后，仅复验年度当前状态与原型两项，2/2 通过，见 [web-final-labels-and-visual.log](web-final-labels-and-visual.log)。同时断言切换到未购买的周期不再标当前订阅。
- 真实接口集成复查发现的旧“待授权”提示已修复：渠道刷新确认自动续费后同步显示“自动续费已开通。”。既有授权测试追加该断言并单项1/1通过，见 [web-mandate-message-final.log](web-mandate-message-final.log)。
- 全部视觉、成功提示、套餐标识和授权文案修复后的最终 Web TypeScript＋Vite build 通过，见 [web-build-final.log](web-build-final.log)；仅有既有大 chunk 提示。
- `ui-final/` 同时保存1440×960及390×844视口的实现/原型截图。独立原型仅内存合成，测试断言没有任何 `/api/` 请求；实际 Web 状态仍从 API 读取。
- 本地运行环境的固定黄色合成说明可能覆盖整页截图的一条区域，因此另存套餐与充值组件截图，以原始 UI 截图展示可见区域，没有隐藏或擦除该说明。原型与实现的数据和历史条目不同，套餐及充值组件的结构、金额、单位和视觉规则相同。

已逐图查看套餐/充值的桌面与390px实现、对应原型：套餐和CTA对齐，完整年费与月发积分可读；金额12.18元实时显示1,218积分，窄屏无横向溢出。便于查看的区域截图：

- [桌面年付套餐](ui-final/subscription-final-annual-plans-detail-1440.png)
- [桌面充值](ui-final/subscription-final-topup-detail-1440.png)
- [390px年付卡片](ui-final/subscription-final-annual-card-detail-390.png)
- [390px充值](ui-final/subscription-final-topup-detail-390.png)
- [原型桌面年付套餐](ui-final/subscription-final-prototype-annual-plans-detail-1440.png)
- [原型390px充值](ui-final/subscription-final-prototype-topup-detail-390.png)
