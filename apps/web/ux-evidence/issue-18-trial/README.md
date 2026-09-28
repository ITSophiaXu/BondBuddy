# #18 试用限制暂停提示（2026-09-28）

Refs #18，按该单 [runtime 接口交接](https://github.com/ITSophiaXu/BondBuddy/issues/18#issuecomment-5862033051) 处理。

原型：#85 `46764161565027f332bdf28f8b335620bd035018` 的 `product-prototype/design-previews/update-workspace.fragment.html`，`runningCard()` 的同页暂停区；主工作区布局同时沿用 develop `94e38fb` 的 `public/project-workspace.js/CSS` 与 #370。实现基线 `94e38fb`，最终实现 SHA 见关联 PR。

范围：不新增页面、输入区、卡片或步骤。当前 run 为 `paused / trial_limit` 时，在已有进度提示位置显示额度耗尽或服务停用原因，以及限制解除后自动继续；不展示会返回 429 的手动继续按钮。事件不可读或原因未知时使用中性的试用限制提示，不猜测余额、恢复时间或完成进度。其他暂停仍按原有流程手动继续。运营拒绝显示失败与权限停用，不承诺自动恢复。

原型示例是用户主动停止，仍显示手动继续。本次额度限制是 #364 新增的服务端自动恢复状态，原型没有演示此具体原因；只按 #18 的真实状态区分文案和操作，不改变原型的页面布局与流程。右侧协作、材料回查、此前成果、单页状态与 #370 的材料页脚主操作保持。#361 既有视觉/真实对话缺口不因本修复被认定完成。

## 同尺寸证据

两边均为真实 Chromium 渲染；原型使用其示例，实现使用明确 synthetic HTTP/文件元数据。没有客户材料、真实模型调用或生产下载。截图不是部署验证或专业验收。

| 视口 | 原型用户停止 | 实现额度暂停 |
| --- | --- | --- |
| 1440×960 | [原型](reference-desktop.png) | [实现](trial-desktop.png) |
| 390×844 | [原型](reference-mobile.png) | [实现](trial-mobile.png) |

[连续走查](workflow.webm)：单次提交→额度暂停→刷新恢复同一 run→后台报告额度恢复→同页排队状态，无 resume/再次 execute 请求。

## 复现

```sh
npm ci --include=dev
npm run build
npm run test:unit -w @bondbuddy/web
npm run dev -w @bondbuddy/web -- --port 5184 --strictPort
# 另一个终端
BB_E2E_BASE_URL=http://127.0.0.1:5184 npm test -w @bondbuddy/web -- --workers=1
BB_E2E_BASE_URL=http://127.0.0.1:5184 BB_TRIAL_UX_DIR="$PWD/apps/web/ux-evidence/issue-18-trial" npx playwright test -c apps/web/playwright.trial.config.ts
node apps/web/scripts/capture-trial-reference.mjs
```

测试涵盖额度、kill switch、刷新恢复、事件读取失败、延迟旧阶段事件、自动恢复不创建任务、普通暂停继续及运营拒绝。当前 run 的 state/stage 决定操作，事件不能使不同阶段显示过期的额度原因。无 DTO、迁移、配额政策或 worker 行为变化；#35 真实环境验证与 #18 多轮消息、#384 替代业务确认路径仍需接续。
