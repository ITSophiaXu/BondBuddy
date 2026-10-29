# 项目问答历史只显示回答任务

用户于 2026-10-29 要求：历史记录仅保留“回答问题”，“识别问题”不作为一次回答记录。开发基线为 `5ec099a2`（develop）。实现和原型随本 PR 一并交付，最终 commit 见 PR。

## 行为与交接

- `apps/web/src/project-qa-workspace.ts` 只显示 answer 任务，按原任务顺序倒序；无回答时隐藏历史控件。识别页面、直接任务链接、采用问题、当前任务进度仍可用。
- `apps/api/src/project-qa.ts` 按本项目全部 answer 任务计算回答次数。保留最近 100 次回答，不让后续识别任务挤掉回答历史；指定旧任务和当前准备仍被包含。进行中、失败和取消的回答继续保留，不把失败改成完成。
- 公共契约增加可选 `QaRun.answer_sequence`。数据库 `sequence`、旧快照和成果不重写。新网页遇到没有此字段的旧 API 时只显示“回答问题 / 状态 / 日期”，避免将总任务序号误报为回答次数。
- 无新增依赖、迁移或 worker 变更。统一发布需协调 API 与网页；旧网页使用严格 DTO 校验，不宜单独先发新 API。先更新网页可兼容旧 API。
- **开发和自测完成；代码完成，尚未部署，待统一发布。用户尚未验收；本轮未更新共享本地集成版。**

## 验证

- contracts、domain、rule-pack-registry、rule-applicability-context、API 和 web TypeScript 编译通过；web Vite 构建通过（现有大 bundle 提示）。171 个公共样例、12 个内部样例及 4 个生命周期样例通过。
- 浏览器覆盖 63 项：本次历史测试 9 项、文档交付 4 项、任务路由 5 项，以及续答、恢复和下载 45 项。首次综合执行 60 项通过；3 项旧测试对募集书必需条件/默认参考方式的预期已过时，更新测试夹具和断言后定向复跑通过。生产行为仅修改历史显示与次数。
- 独立真实 PostgreSQL + API 测试 1/1 通过，未跳过。317 条合成任务包含 106 次回答及随后 105 次识别；验证最近 100 次回答仍可见、次数 7–106、直接打开第 1 次回答、识别链接、当前准备、跨项目和跨账号隔离、原快照不变。
- 初次数据库夹具把无成果的模拟任务设为 succeeded，触发既有交付保护；已改为合法的 queued/failed/cancelled 历史并复跑通过，没有放宽生产约束。
- 浏览器使用模拟 HTTP 和合成 Word，仅验证 UI、历史导航、固定成果下载和恢复；数据库测试使用真实 SQL/API 与合成任务。没有调用真实模型、生产数据或账务。

复跑命令（在仓库根目录执行；浏览器测试前启动独立 web 服务并设置 `BB_E2E_BASE_URL`）：

```powershell
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json
node packages/contracts/dist/check-examples.js
node packages/contracts/dist/check-data-lifecycle.js
# BB_TEST_DATABASE_URL 必须指向已迁移的独立测试模板库；测试会创建和清理专属克隆。
node --test apps/api/dist/project-qa-history.test.js
```

浏览器命令（在 `apps/web` 执行）：

```powershell
node ../../node_modules/playwright/cli.js test tests/project-qa-history.spec.ts tests/project-qa-document-ux.spec.ts tests/project-qa-task-routing.spec.ts tests/project-qa-continuation.spec.ts tests/project-qa-recovery.spec.ts tests/qa-result-next.spec.ts
```

## 原型与页面对照

原型为 `product-prototype/public/qa-document.html`，实现为 `apps/web/src/project-qa-workspace.ts`；两者均基于 `5ec099a2`，本 PR 按用户此次要求同步。关联前端范围 #361，未改变其他页面布局。截图为本 PR 源码的合成数据，同视口、同组件宽度；仅样例日期格式不同，没有布局偏离。确认依据为用户本次截图和文字要求，不能视为用户已验收实现。

| 视口 | 原型 | 实现 | 整页 |
| --- | --- | --- | --- |
| 1440 × 960 | [原型](history-prototype-1440.png) | [实现](history-implementation-1440.png) | [整页](history-page-1440.png) |
| 390 × 844 | [原型](history-prototype-390.png) | [实现](history-implementation-390.png) | [整页](history-page-390.png) |

逐项核对：历史筛选仅含回答；第 1/2 次不含识别；选择旧回答后保持正确任务；控件位置、字体、间距和窄屏换行沿用现有样式。桌面/手机无横向溢出。识别页面原有采用按钮和回答文档下载仍在原位置。
