# #361 浏览器视觉对照（2026-09-28）

**当前界面请看 [#370 对照与录屏](issue-370/README.md)。** 下列为 #363 的历史交付记录；其中目标期间编辑器、启动卡片和上传长文已被 #370 明确否定并删除，不是当前认可的原型差异。

以下全部是 **Chromium 实际渲染、合成账号/项目/HTTP 夹具**。界面来自仓库原型或当前 Vite 应用，不是设计工具重绘。截图不证明真实模型/数据库/Blob、客户成果或 Word/WPS 验收，也不表示已部署。

| 状态 | 原型参考 | 迁移后的应用 |
| --- | --- | --- |
| 工作台 | [原型桌面](reference-dashboard.png) | [桌面](dashboard-desktop.png)、[窄屏](dashboard-mobile.png) |
| 创建项目 | [原型桌面](reference-create.png) | [桌面](create-desktop.png) |
| 材料与要求 | [原型桌面](reference-materials.png) | [桌面](materials-desktop.png) |
| 更新中 | #85 的连续工作区 fragment | [桌面](running-desktop.png) |
| 待补充 | #85 的连续工作区 fragment | [桌面](awaiting-desktop.png) |
| 暂停 | #85 的连续工作区 fragment | [桌面](paused-desktop.png) |
| 失败 | #85 的连续工作区 fragment | [桌面](failed-desktop.png)、[窄屏](workspace-mobile.png) |
| 完成、待确认与下载 | #85 的连续工作区 fragment | [桌面](completed-desktop.png)、[窄屏](completed-mobile.png) |

桌面宽 1440px、高 960px，窄屏为 390×844；全页截图高度随内容变化。阅读 [迁移差异表](../PROTOTYPE-MIGRATION.md) 区分原型体验、当前真实服务能力和剩余依赖。合成材料故意包含缺失解析状态，必须在界面提示，不能为了截图整洁冒充已解析。

原型截图复现：`node apps/web/scripts/capture-prototype.mjs`。脚本仅在环回地址临时提供原型静态文件，拦截全部旧 `/api` 请求为合成夹具，结束即关闭，不启动原型服务端或执行模型。

应用截图由 `prototype-workflow.spec.ts`、`project-execution.spec.ts` 和 `artifact-page.spec.ts` 生成到系统临时目录的 `bb361-*.png`。默认浏览器测试命令见 Web README；每次记录同时写明 Node/浏览器版本、通过/跳过项及 Git 提交。

走查录屏：在 `apps/web` 执行 `npx playwright test --config playwright.video.config.ts`，输出在系统临时目录的 `bondbuddy-prototype-videos`。它分三段记录[创建与材料](creation.webm)、[运行/待补充/暂停/失败](processing.webm)、[同页成果与下载](delivery.webm)。这些是合成 API 的界面操作，不包含真实助手多轮或真实模型生成，不能称为完整生产链路录屏。
