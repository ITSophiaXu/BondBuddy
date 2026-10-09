# 项目助手 UI 与图标细化（#612 / #361）

用户于 2026-10-09 对已上线截图明确要求 refine UI 和 icon。本次只调整悬浮助手展示、项目选择器开合和输入区，业务流程沿用全站助手决定。

原型与实现源码 commit 均为 `3a51081cc5c28b3a8b58cb07bde1d0e50ae3f38e`；原型是 `product-prototype/public/project-assistant-refined.html`，实现是 `apps/web/src/project-assistant.ts`、`project-assistant.css`、`assistant-icons.ts`。

| 对照 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 桌面 | prototype-1440.png | implementation-1440.png |
| 同为 480×736 的助手面板 | prototype-panel.png | implementation-panel.png |
| 390×960 窄屏 | prototype-390.png | implementation-390.png |

另留存实现 1024、320 宽度和已确认任务进度截图。旧版对照仍保存在 ../project-assistant，不覆盖历史证据。

- 同尺寸逐屏检查：头部、项目入口、SVG 图标、欢迎任务入口、统一输入区及悬浮入口显隐一致，无业务流程偏离。实际页面背景为工作台；原型背景只用于标明视觉基准。
- 窄屏保留边距且不产生横向溢出；宽屏展开、收起、历史对话和跨页恢复通过。截图全部使用 synthetic API fixtures。
- `npm run build`、`npm run check:contracts` 通过；样式最终调整后 web build 再通过。
- Edge 浏览器：`playwright test tests/project-assistant.spec.ts tests/dashboard-status.spec.ts`（ASSISTANT_EVIDENCE=1）最终 **9 passed**。含会话草稿恢复、实际报价确认流程、任务卡、附件排队、旧卡失效、任务恢复及下载；API 为合成响应，无真实客户任务或扣费。

用户是本次细化方向的确认人；上线后的原账号最终视觉验收待用户试用。本切片未改变模型、收费配置、后端契约、迁移或私有成果权限。
