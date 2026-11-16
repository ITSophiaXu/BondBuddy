# #1310 按需充值 UX 修复验证

- 日期：2026-11-16（北京时间）。依据：用户本轮截图与直接修复要求、Issue #1310。
- 基线 develop：`652d4b86f14a7015a67a720326e0c38ea4d23de0`。
- 原型与实现源码 commit：`9b107385a3b8c4d1b033fa82e432892f2a77d770`；本目录为后续证据提交，不更改运行源码。
- 原型：`product-prototype/public/account-credits.html?subscription=1`、`subscription-account-prototype.js`。
- 已迁移页面：`/#/account` 的 `apps/web/src/subscription-billing-page.ts`。
- 共用样式：`product-prototype/public/subscription-topup.css`。移除此前三处重复充值布局规则，避免原型/实现漂移。

## 已修复范围

金额输入、快捷金额及限制说明在同一组；支付方式与金额输入顶部对齐。底部用分隔线关联到账预览和支付按钮，输入与主操作至少 44px 高。760px 及以下按金额、支付方式、到账信息、支付按钮排序，按钮铺满可用宽度。标题说明固定在标题下方。

快捷金额提供 `aria-pressed` 与选中样式；手动输入同额（例如 500.00）保持选中，改成其他金额清除选中；点击快捷金额就地更新，保留输入节点与焦点。范围、人民币到积分比例、渠道校验、订单幂等与恢复逻辑不变。无 API/契约/数据库迁移/新增依赖。

## 同尺寸原型 / 实现对照

每对使用相同浏览器视口（高度 960px），截图裁剪到充值卡片，金额均为 12.18 元。组件的结构、阅读顺序、间距、输入与主按钮高度及手机排布一致；原型显示合成微信渠道和“模拟充值到账”，实现显示合成 API 返回的支付宝和真实入口文案。原型/实现继承各自既有页面外壳，桌面卡片宽度有 4px 差异，无新增结构偏离。

| 视口宽度 | 原型 | 实现 |
| --- | --- | --- |
| 1440px | [截图](topup-prototype-1440.png) | [截图](topup-implementation-1440.png) |
| 1024px | [截图](topup-prototype-1024.png) | [截图](topup-implementation-1024.png) |
| 900px | [截图](topup-prototype-900.png) | [截图](topup-implementation-900.png) |
| 390px | [截图](topup-prototype-390.png) | [截图](topup-implementation-390.png) |
| 320px | [截图](topup-prototype-320.png) | [截图](topup-implementation-320.png) |

设计调整由用户本轮明确授权；实际用户验收尚未进行。原型渠道/模拟操作文案差异是已有测试边界，不代表生产支付已验证。

## 验证

环境：macOS arm64，Node v26.8.1，Playwright + 本机 Microsoft Edge；实际前端 + synthetic HTTP/账务夹具，无真实商户扣款、真实模型调用。

- 完整 `subscription-account.spec.ts`：68 pass / 2 fail / 0 skip，两个失败均为桌面主按钮被既有样式覆盖为 40px。修正作用域后，包含两失败场景的最终定向复验 **6 pass / 0 fail / 0 skip**（5 种视口和交互原型）。70 个不同场景均获得通过结果；不将全组首跑写成一次全绿。[整组记录](subscription-regression.log)、[最终布局复验](layout-final.log)。
- 现有回归覆盖精确分转积分、非法金额不请求支付、小额充值、未知订单原请求恢复、跨标签防重、付款后原任务恢复、订阅转换与退款。布局回归检查键盘顺序、快捷金额反馈、节点/焦点保持、宽度与溢出，包含 320px 窄屏及错误金额长文案。
- `tsc -p apps/web/tsconfig.test.json --types node` 后执行 `node --test apps/web/dist-test/checkout-intent.test.js apps/web/dist-test/commerce-price.test.js`：**22 pass / 0 fail / 0 skip**。[记录](checkout-unit.log)
- `npm run build -w @bondbuddy/web`：TypeScript/Vite 成功；已有 chunk 大小提示保留。[记录](web-build.log)
- `npm run check:contracts`：**32 + 29 + 11 tests 全部通过**，179 个 synthetic + 12 个内部库示例、4 个数据生命周期示例通过。[记录](contracts.log)
- `npm run build -w @bondbuddy/api -- --types node --noEmit`：通过；仅用作现有浏览器夹具所依赖代码的类型核对，无 API 源码变化。

复现浏览器命令：

```sh
npm run build -w @bondbuddy/contracts
npm run dev -w @bondbuddy/web -- --port 5189
BB_E2E_BASE_URL=http://127.0.0.1:5189 BB_E2E_BROWSER_CHANNEL=msedge npm test -w @bondbuddy/web -- subscription-account.spec.ts
BB_E2E_BASE_URL=http://127.0.0.1:5189 BB_E2E_BROWSER_CHANNEL=msedge npm test -w @bondbuddy/web -- subscription-account.spec.ts --grep 'topup groups|subscription preview shares'
```

测试模块还导入已有 API 编译输出。全新工作区准备时曾因 API 夹具未编译、Vite 在 contracts 编译完成前启动而失败；补齐输出并重启 Vite 后解决。API 常规发射构建还遇到本机祖先目录 Bun 类型污染及既有 API/worker 互引声明链，采用显式 Node 类型和 noEmit 核对；不声称完整 API 发射构建通过。验证中合并重复布局用例时的临时语法错误已修正，最终套件能完整执行。

## 发布与最终统一验收待办

代码完成，尚未部署，待统一发布。合入 develop 与部署、用户验收分别记录在 #1310；本开发任务不执行部署。最终统一验收待办：发布环境复核充值卡片和真实渠道支付返回；用户对本次 UX 的实际验收。真实商户/账户/账务链路未由 synthetic 浏览器用例替代。
