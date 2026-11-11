# 支付页面对照证据（合成）

本目录全部为本地模拟数据的 Playwright 截图，不是正式支付宝付款、真实用户订单或真实商户到账证据。

基线：`f95a8f2d83d7b1794eb92060a1fedeeeb916e1a9`。新版原型及实现为本 PR 的同一提交；截图生成前的源码版本与本提交一致，截图自身随后加入提交。

- `payment-pending-desktop*.png` / `payment-prototype-pending-desktop*.png`：待付款实现/原型。
- `payment-paid-desktop*.png` / `payment-prototype-paid-desktop*.png`：到账实现/原型。
- `payment-paid-mobile-viewport.png`：390×844 实现视口，结果卡在固定导航栏下方。
- `payment-paid-mobile.png` / `payment-prototype-paid-mobile.png`：390×844 同视口的全页截图。
- `*-card.png`：对应支付卡局部，裁图保留完整状态、金额、积分及订单；不是整页截图。

桌面视口 1440×960。原型只有支付区，真实实现保留原账户界面与导航；示例订单号和日期不同。具体视觉尚待用户确认。实现、测试与部署边界见 [验收记录](../../docs/acceptance/issue-975-payment-experience-2026-11-11.md)。
