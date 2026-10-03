# M2 固定积分原型与实现对照

> 以下是原稿必填决定前的首轮证据。原稿信息不足时的免费分支已被[最新决定](../../../../docs/product-decisions/2026-10-03-source-information-required.md)替代；原记录保留，当前原稿校验见 [追加证据](../m2-source-required/README.md)。

核对日期：2026-10-03。所有截图与浏览器数据均为 synthetic；没有真实支付、客户材料或用户账号。

原型基线：`d5314d2f2e4537fcf3aab9a54e9e086782c75830` 中的 `product-prototype/public/`，`#billing` 页面和 `credits.css`。这次不修改原型。实现：`d11198100bf4c788af6ce71e27612c10c6230ba7` 的 `apps/web/src/billing-page.ts`、`project-execution.ts` 及样式。截图由真实 Chromium 和合成 HTTP fixture 生成。

| 屏幕 | 原型 | 实现 | 对照结论 |
|---|---|---|---|
| 桌面 1440×960 | [原型](prototype-billing-desktop.png) | [实现](m2-billing-desktop.png) | 保留侧栏位置、标题、余额卡、四档充值卡；补充原任务差额及返回入口。 |
| 手机 390×844 | [原型](prototype-billing-mobile.png) | [实现](m2-billing-mobile.png) | 沿用原型响应式布局，窄屏无横向溢出。 |
| 项目报价 1440×960 | 当前 M1 材料页开始区域 | [实现](m2-quote-desktop.png) | 在原开始操作旁展示固定价、可用余额、差额与充值入口，不新增项目步骤。 |

与旧原型的范围差异来自用户 2026-10-02/03 的直接确认，详见 [产品决定](../../../../docs/product-decisions/2026-10-03-m2-fixed-credits.md)：

- 取消消费明细、现金退款和新营销活动 UI；余额卡仅展示可用及任务冻结。
- 把按用量结算文案改为已确认套餐固定价；上传、保存、已有成果下载不收费，M3 复核免费。
- 充值不足时保留项目输入，到账后明确返回确认，不自动运行；价格变化必须重新确认。
- 原稿信息不足时显示免费原因及“按 M1 免费编制”，不伪造套餐、不补扣。
- 生产支付渠道未配置时显示“充值渠道暂未开放”，不显示演示付款按钮。支付链接 UI 仅在已配置的渠道下可用；真实商户渠道与二维码交互仍归 #40 验收。

未取得新的人工逐屏签认；本文记录用户已确认的产品范围及实际比对结果，不冒充产品验收。

验证：`BB_E2E_BASE_URL=http://127.0.0.1:5178`，在 `apps/web` 执行 `playwright test tests/project-execution.spec.ts tests/project-conversation.spec.ts tests/artifact-page.spec.ts tests/review-workspace.spec.ts`：100 passed。报价卡可读性调整后，对最终 Vite production preview 复跑 `project-execution.spec.ts --grep 'M2 '`：3 passed。覆盖 M2 三个新场景，并回归 M1 材料/要求/下载与 M3 复核流程。测试使用模拟 HTTP，不代表真实支付已通过。
