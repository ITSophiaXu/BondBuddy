# #788 页面字体与英文标题

状态：开发和自测完成，尚未部署，待统一发布；用户验收尚未进行。

## 版本与范围

- 基线：`6725d8f74da2c9793698f1eaf8179eb76ab55b5c`（develop）。
- 实现及修订原型：`2cfc70f583d5221b44c818dee96429b982ff23f0`。
- 依据：用户在 #788 的截图、字体优化和补齐英文标题要求，随后明确要求修复。用户为本次要求提出人；本记录不代替用户视觉验收。
- 页面标题由原有 31px/30px/28px 等差异值统一为桌面 24px、窄屏 22px；英文标题统一 11px。更新页新建卡片标题由 28px 调整为 20px（窄屏 23px → 18px），卡片说明 14px，已有项目标题 16px。
- 文件生成的项目选择及各工作区标题补齐 `FILE GENERATION`；项目问答入口及工作区补齐 `PROJECT Q&A`。
- 同一 ProjectEntry 也服务诚信核查，其标题和窄屏间距同步保持一致，并纳入回归。短窗口保留英文标题，修正通用 CSS 对入口间距的覆盖，并缩小项目面板顶部空隙，保留底部操作空间。
- 无 API、worker、账务、公共契约、依赖或迁移变更。

## 原型与实现对应

| 页面 | 原型（product-prototype/public） | 实现（apps/web/src） |
| --- | --- | --- |
| 更新募集书入口 | project-entry.html?view=update、project-entry-preview.js | update-entry.ts、update-entry.css |
| 复核募集书入口 | project-entry.html?view=review | project-entry.ts、review-entry.ts |
| 文件生成入口 | project-entry.html | project-entry.ts、file-workspace.ts |
| 项目问答入口 | project-entry.html?view=qa | project-entry.ts、project-qa-workspace.ts |
| 文件生成工作区 | file-generation.html | file-workspace.ts |
| 项目问答工作区 | qa-document.html、qa-materials.html | project-qa-workspace.ts |

共享样式为 `project-entry.css`、`workspace-typography.css`，通过 main.ts 导入实际前端。原型中保留合成项目和交互预览，不执行真实业务操作。

本次按用户要求调整旧原型的字号及标题，未新增业务流程。入口页同尺寸对照未发现字体或布局偏离；原型侧栏链接仅提示预览，实际页面会正常导航。工作区对照中的合成项目状态、历史记录及资料内容不同，按标题组件样式核对。

## 同尺寸截图

全部截图来自 Windows / Microsoft Edge，浏览器测试视口分别为 1440×960、390×844、320×640。下列原型和实现均对应上面的同一提交。

| 页面 | 1440px：原型 / 实现 | 390px：原型 / 实现 | 320px：原型 / 实现 |
| --- | --- | --- | --- |
| 更新募集书 | [原型](prototype-update-1440.png) / [实现](implementation-update-1440.png) | [原型](prototype-update-390.png) / [实现](implementation-update-390.png) | [原型](prototype-update-320.png) / [实现](implementation-update-320.png) |
| 复核募集书 | [原型](prototype-review-1440.png) / [实现](implementation-review-1440.png) | [原型](prototype-review-390.png) / [实现](implementation-review-390.png) | [原型](prototype-review-320.png) / [实现](implementation-review-320.png) |
| 文件生成入口 | [原型](prototype-generate-1440.png) / [实现](implementation-generate-1440.png) | [原型](prototype-generate-390.png) / [实现](implementation-generate-390.png) | [原型](prototype-generate-320.png) / [实现](implementation-generate-320.png) |
| 项目问答入口 | [原型](prototype-qa-1440.png) / [实现](implementation-qa-1440.png) | [原型](prototype-qa-390.png) / [实现](implementation-qa-390.png) | [原型](prototype-qa-320.png) / [实现](implementation-qa-320.png) |

文件生成工作区：[桌面](generation-workspace-1440.png)、[窄屏](generation-workspace-390.png)；组件对照：[桌面原型](generation-workspace-prototype-1440.png) / [桌面实现](generation-workspace-component-1440.png)、[窄屏原型](generation-workspace-prototype-390.png) / [窄屏实现](generation-workspace-component-390.png)。

项目问答工作区：[桌面](qa-workspace-1440.png)、[窄屏](qa-workspace-390.png)；组件对照：[桌面原型](qa-workspace-prototype-1440.png) / [桌面实现](qa-workspace-component-1440.png)、[窄屏原型](qa-workspace-prototype-390.png) / [窄屏实现](qa-workspace-component-390.png)。

`rendered-metrics.json` 记录 24 张入口原型/实现截图中的实际计算字号、行高及位置；均无页面水平溢出。截图已进行视觉检查。

## 验证

- `npm run build`：全工作区构建通过。最终 CSS 调整后再次运行 `npm run build -w @bondbuddy/web`，通过；保留现有的大 bundle 提示。
- `npm run check:contracts`：通过，49 个测试及 171 个合成公开示例、12 个内部库示例、4 个生命周期示例。
- `node ../../node_modules/@playwright/test/cli.js test tests/project-entry-layout.spec.ts`：最终版本 **25/25 通过**，含 320px 小窗口、空列表/错误提示、键盘选择、长项目名、助手展开与导航。
- `file-generation-flow.spec.ts`：**15/15 通过**，含 1440/390/320px、两种生成入口、上传/版本切换及原型对照。
- `project-qa-document-ux.spec.ts`：**4/4 通过**，含英文标题所在工作区、问题清单上传、下载与待补材料展示。
- 上述浏览器回归共 **44 项通过**。首轮新增英文标题暴露小窗口间距问题，已修复并复跑全部入口测试；未将失败记录当作通过。

本地使用 `BB_E2E_BASE_URL=http://127.0.0.1:5258`、`BB_E2E_BROWSER_CHANNEL=msedge`；Vite 从本工作区 apps/web 启动：`node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5258 --strictPort`。该端口仅用于本次开发回归，不是统一本地集成验收版。

页面代码真实运行；HTTP、账号、项目、上传和下载均为既有合成测试 fixture，没有生产数据库、真实模型调用、真实账务或生产部署。最终统一验收待办：集成到统一测试版后，由用户在常用窗口及缩放比例下确认视觉效果，再按发布流程统一上线。
