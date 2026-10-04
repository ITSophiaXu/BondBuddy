# 补充说明与开始编制：原型／实现对照

2026-10-04，#361。原型和实现的源码 commit 均为 `5b8de087984438b9729adb710b79cdc534d915ce`；基线 `develop dc06648`。图片仅含合成项目和合成 HTTP 数据。

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440×960 | [桌面](prototype-empty-desktop.png) | [桌面](implementation-ready-desktop.png) |
| 390×844 | [手机](prototype-empty-mobile.png) | [手机](implementation-ready-mobile.png) |

变化依据为用户在当前会话要求重新设计此区域：三行选填说明框、小号描边保存按钮、单一标题；底部“开始编制”为主要操作。准备阶段操作栏吸附，短屏／已开始任务／完整报价展示时不吸附。原型文件为 `project-workspace.js`、`project-conversation.js` 及共享 `project-workspace.css`；实现为 `project-conversation.ts`、`main.ts`、`project-execution.ts`。

本次修改的说明框和底部按钮层级一致。既有材料分区、上传限制文案、页边距以及原型没有真实 API 保存状态的差别仍存在；实现保留服务器版本、断网恢复、原稿信息提示和真实积分报价，不声称这些既有差别已经人工逐屏验收。需求确认人：产品负责人（当前用户）；当前修改按其重设计指令落实，用户上线体验待验。

验证：

- Web TypeScript 与 Vite 生产构建通过；本地新工作区先生成 API 类型后完成检查。
- `project-conversation.spec.ts` + `project-execution.spec.ts`：59 passed。覆盖说明保存不执行、修改与版本回查、丢失响应同键重试、保存后读取失败恢复、输入不可变、必填原稿信息、运行中隐藏编辑区、报价/余额及任务恢复。
- 调整手机操作栏为同排网格后：原型/实现截图、M2 不足充值确认、手机材料工作流三项定向复跑 3 passed；最后补充已启用按钮的截图 1 passed。
- 原型说明回归 3 passed；公共契约 166 + 12 示例、生命周期 4 示例通过。
- 测试均为本机 Chromium / 合成 HTTP。最初沙箱内浏览器启动失败，停止后经批准启动 Chromium 执行上述通过的回归；不是产品失败或真实模型测试。本次不运行客户生成任务。

命令：在 `apps/web`，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5186`、`BB_UX_EVIDENCE_DIR=test-evidence/compact-notes` 后执行 `playwright test tests/project-conversation.spec.ts tests/project-execution.spec.ts`。生产预览使用 `vite preview`。上线版本和目标环境验证另在 #361 记录，本文件不表示已部署。
