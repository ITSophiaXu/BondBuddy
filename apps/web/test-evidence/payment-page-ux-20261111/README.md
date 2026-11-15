# 支付页面修复验证（2026-11-11）

修复 #1016、#1017、#1018、#1019、#1020；前序支付体验工作见 #975 / #977。
本次按用户五张截图反馈修复，开发基线已更新到 develop `0c533ffc`。

## 修复范围

- 支付渠道异常只说明支付与原订单核对，不再混入材料保留文案。
- “继续原付款”显示核对中，读取并展示同一订单的最新支付链接和状态，同地址也生效；成功定位付款卡，失败定位错误提示。既有订单恢复不依赖新购开关或当前渠道列表。
- 未完成付款（含下单结果未知、关闭结果未知）时隐藏套餐选择、订阅管理和充值。服务确认结束后才恢复购买入口，保留原 request_id / order_id 和跨标签页防重。
- 禁用订阅计费模式后，仅为当前账号的未决/被拒请求或精确匹配的原订单保留新版恢复入口。无这类记录的旧模式账号继续旧页面，避免改变金额/积分语义。
- 充值区桌面字段与按钮同一行、统一高度；平板两列、手机单列；说明与快捷金额单独排布。
- 移除“任务范围与历史报价”及其读取请求，保留积分消耗、订单、退款记录。订阅原型同步移除该区并应用充值样式。

## 验证环境与边界

Windows、Node.js 22+、本地 Vite、Microsoft Edge；真实浏览器配合合成账户与模拟 HTTP 响应。订单状态由测试服务响应驱动；未调用正式支付渠道、未付款、未修改生产账务、未调用模型。不代表完整真实后端支付链路或用户验收。

没有 API 契约、数据库迁移、依赖或生产配置变更。代码完成后交付统一集成与发布，不自行部署。

## 复验命令

在仓库根目录依次编译 contracts、domain、rule-pack-registry、rule-applicability-context、api，随后：

```powershell
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/api.test.js apps/web/dist-test/checkout-intent.test.js apps/web/dist-test/payment-return-route.test.js apps/web/dist-test/billing-task-recovery.test.js
```

在 `apps/web` 启动独立端口并运行浏览器回归：

```powershell
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5197 --strictPort
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test subscription-account.spec.ts billing-navigation.spec.ts task-refunds.spec.ts
node ../../node_modules/vite/bin/vite.js build
```

本地 5197 仅是本次前端测试服务，HTTP API 由 Playwright 测试拦截；不是提供给用户验收的完整集成环境。

## 视觉证据

- `payment-page-continued-original-1440.png`、`payment-page-continued-original-390.png`：继续同一原订单后的页面，套餐/充值与历史报价已隐藏。
- `payment-page-topup-aligned-1440.png`、`payment-page-topup-aligned-900.png`、`payment-page-topup-aligned-390.png`：三种尺寸的充值区对齐。
- `payment-prototype-pending-desktop-card.png` 与 `payment-pending-desktop-card.png`：既有独立付款原型与实际付款卡。用户本次要求为账户外围内容精简及交互修复，原付款卡的信息结构保持。

## 最终结果

基于 develop `0c533ffc`，功能提交 `e5e88872`：

- 相关单元测试：64 passed、0 failed、0 skipped。
- 合并浏览器回归：76 passed、0 failed、0 skipped，包含订阅/支付68项、旧计费导航5项和退款3项。
- contracts、domain、rule-pack-registry、rule-applicability-context、API 编译及 web TypeScript 检查均通过；Vite 构建通过，仅保留既有大包体积提示。
- 原型 JavaScript 语法检查、git diff --check 通过。已目视核对付款页和三种宽度的充值区截图。
- 完整浏览器输出见 `browser-final.log`，全部使用上述合成边界。

首次定向测试发现禁用订阅模式时上层入口跳回旧页面（15/17 通过），随后修复原订单恢复条件并补旧模式兼容回归；失败证据保留本地 work，不以重跑掩盖。最终76项在最新develop基线上重新执行。

最终统一验收待办：在统一集成测试版实际操作原订单继续付款、取消后改选、充值及账户记录；真实渠道付款/回跳由获授权的测试或发布流程另行核验。用户尚未验收，尚未部署。
