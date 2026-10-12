# Notion 式项目助手侧栏

2026-10-12 用户提供 Notion 工作区 / Agent 截图，明确要求点击右下角小图标展开右侧栏，右上角双箭头收起，工作区不被助手遮挡。关联 #623、#361。用户本次要求为交互调整确认；保留 BondBuddy 品牌及现有业务功能。

源码与原型 commit：`ab2b4028421dea9be63149f5d7f2d28feebc6ff1`，基于 `develop 71635b9f`。原型：`product-prototype/public/project-assistant-refined.html`；实现：`apps/web/src/project-assistant.ts`、`project-assistant.css`、`assistant-icons.ts`。影响所有已登录页面的全站助手。

## 同尺寸截图

| 场景 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 展开 | [原型](prototype-open-desktop.png) | [实现](implementation-open-desktop.png) |
| 1440×960 收起 | [原型](prototype-collapsed-desktop.png) | [实现](implementation-collapsed-desktop.png) |
| 1024×768 展开 | [原型](prototype-open-small-desktop.png) | [实现](implementation-open-small-desktop.png) |
| 1024×768 收起 | [原型](prototype-collapsed-small-desktop.png) | [实现](implementation-collapsed-small-desktop.png) |
| 390×844 展开 | [原型](prototype-open-mobile.png) | [实现](implementation-open-mobile.png) |
| 390×844 收起 | [原型](prototype-collapsed-mobile.png) | [实现](implementation-collapsed-mobile.png) |

业务页补验：[1280px 更新](implementation-update-1280.png)、[1280px 复核](implementation-review-1280.png)、[1024px 账号](implementation-account-1024.png)。

逐屏核对：桌面右下角仅保留 52px 圆形图标，位于 80px 预留区内；展开隐藏图标，侧栏与工作区并排。右上角双箭头 / Escape 收起并恢复入口焦点，侧栏有细分隔线。1024px 同样并排，账号与积分卡片按剩余宽度重排。手机采用全屏助手、48px 入口和背景焦点隔离。原型使用简化业务背景，实现保留真实导航和内容；桌面实现的原生滚动条保留 15px 槽位。对照未发现额外助手交互偏离。

## 验证

- Windows / Node 24.19.0 / Edge / Playwright；独立 Vite 端口 54322。
- 全仓各 workspace 的 `build` 实际命令按依赖顺序执行：contracts、domain、rule-pack-registry、rule-applicability-context、api、worker 的 `tsc -p tsconfig.json`，web 的 `tsc --noEmit` 及 `vite build`。全部通过。新工作区第一次 web 类型检查缺少 API 等上游构建产物，补齐完整构建后通过。
- contracts 的 `check-examples.js`、`check-data-lifecycle.js`、`ocr-v2.test.js`、`generation-issuer-binding.test.js` 全部通过：171 + 12 + 4 个示例及 40 项测试。
- `BB_E2E_BASE_URL=http://127.0.0.1:54322 BB_E2E_BROWSER_CHANNEL=msedge playwright test project-assistant.spec.ts`：**15 passed / 1 skipped**。跳过的是旧的可选截图测试，本次以上六组同尺寸对照实际执行并保存。
- 矩阵：工作台、全部项目、更新、复核、材料生成、账号六页，在 1440 / 1280 / 1120 / 1024 / 961px、普通 / 加宽两种侧栏宽度下无页面或正文横向溢出。账号页加载四档合成充值卡片后再检查。
- 1440 / 1024 / 390 / 320 / 720px 验证入口尺寸、展开 / 收起、滚动、页面按钮可点击、Escape 与焦点恢复。桌面正文边界在侧栏左侧，收起图标在正文右侧；打开后主页面仍可操作。手机末尾按钮可滚到入口上方。
- 未发送文字在立即收起、导航、刷新、历史切换后保留；附件上传队列、确认卡、任务与下载回归通过。开合不会增加消息发送或文书执行。
- 原型输入后发送按钮可用，捕获到的浏览器脚本错误为空。

全部 API、材料和账号均为 synthetic，未调用真实模型或扣费。无 API、数据库、公共契约或后台 worker 修改。构建保留现有大 chunk 提示。

本记录证明源码与本地合成交互验证，不代表线上发布。生产部署及原用户实际流程验收独立记录；#623 的线上验收项不在此关闭。
