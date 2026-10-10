# 项目助手收起与恢复（2026-10-10）

用户反馈旧“×”隐藏整个入口后难以找回，要求收起且不遮挡业务内容。本次取代 #623 的隐藏方式；顶部正常导航布局保留“项目助手”，面板“－”及 Escape 收起到该入口。旧隐藏偏好不再影响入口显示，侧栏仍可打开助手。用户是本次交互变更确认人。

原型与实现源码 commit：`cfeec225`。原型为 `product-prototype/public/project-assistant-refined.html`，实现为 `apps/web/src/project-assistant.ts` / `project-assistant.css`。无 API、迁移、定价或执行语义变化。

| 同尺寸对照 | 原型 | 实现 |
| --- | --- | --- |
| 桌面 1440×960 收起 | prototype-collapsed-desktop.png | implementation-collapsed-desktop.png |
| 桌面 1440×960 展开 | prototype-open-desktop.png | implementation-open-desktop.png |
| 手机 390×844 收起 | prototype-collapsed-mobile.png | implementation-collapsed-mobile.png |
| 手机 390×844 展开 | prototype-open-mobile.png | implementation-open-mobile.png |

逐屏核对：顶部入口、面板收起按钮、面板头部及输入区一致。原型背景只示意工作台；实现包含实际工作台及余额。手机顶部因保留现有积分入口换成两行，均占正常布局空间；收起截图包含滚动后的顶部固定入口。另通过 320×740 窄屏与 720×480 等效 CSS 视口，无横向溢出。等效视口不冒充实际浏览器缩放测试。

验证环境 Windows、Node 22.14、Edge；API 全部使用 synthetic fixtures，没有真实任务或扣费。

- `npm run build` 通过；仅有既有前端打包体积提示。
- `npm run check:contracts` 通过。
- `BB_E2E_BASE_URL=http://127.0.0.1:5199 BB_E2E_BROWSER_CHANNEL=msedge BB_COLLAPSE_ASSISTANT_EVIDENCE_DIR=<本目录> npm test -w @bondbuddy/web -- tests/project-assistant.spec.ts tests/dashboard-status.spec.ts`：**14 passed / 1 skipped**。跳过的是旧可选截图场景；本次四组对照由新收起场景生成。
- 覆盖旧版隐藏状态升级、立即收起再展开、自动保存后刷新、跨页恢复、Escape 焦点返回、滚动后入口仍可点击、原悬浮位置按钮点击、附件队列、执行中收起后恢复和成果下载。任务执行次数保持一次。

最终统一验收待办：原账号会话与实际浏览器缩放试用。合成工程测试不冒充真实用户验收。

同步 develop 的财务上传提示（271169be）后，web build 和相同 14 项浏览器回归再次通过。GitHub 四个托管检查均因账户付款/额度问题未启动，未计为通过。

同步已合并 #645 的材料标签后（17b707cd），contracts/web build 和相同浏览器测试再次 14 passed / 1 skipped；助手及原型的代码差异为空。
