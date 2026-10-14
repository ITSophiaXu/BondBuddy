# 募集书模型进度摘要 · 2026-10-14

用户要求修复“已完成一次：处理文档”反复刷屏，让模型实际返回的工作摘要保持可见。关联 #361、#684。

- 基线：develop `d71bf682`。
- 产品、原型与测试版本：`30b2b1f3`（完整提交以本分支 Git 历史为准）。
- 原型：`product-prototype/public/authoring-live-progress.html`，新增“尚无摘要”“暂无新摘要”。
- 实现：`apps/web/src/authoring-progress.ts`、`project-execution.ts`。
- 所有截图、HTTP 响应、摘要、金额和文书均为 synthetic 测试夹具；没有真实模型调用、用户材料或真实账务操作。

## 行为与验证

1. 具体摘要不随普通工具记录滚出当前状态；连续 40 条工具开始/结束记录后，摘要与最后一条普通操作仍可见。
2. 按原接口每页 10 条读取、刷新后恢复同一摘要；没有重建任务或重复执行。
3. 普通操作合并为最新一条，文案“处理步骤已返回”不表示文稿完成。摘要、失败和生命周期历史保留独立空间。
4. 尚无摘要明确提示；最新工具事件不能刷新两分钟前的摘要。旧阶段、恢复前、其他任务及超出服务端游标的摘要不能作为当前进度。
5. 暂停、积分用完、恢复、连接异常、失败和终态维持优先级；摘要中的 HTML 只显示为文本。
6. 手机无横向溢出、页面脚本错误为 0。材料生成共用的状态文案回归通过，其历史列表不在本次重构范围。

通过结果：

- 前端单元测试 **102/102**，其中本次进度回归 **6/6**。
- 浏览器 **11 个用例最终通过**：募集书 7 个（新增摘要桌面/手机 2 个、动态进度 2 个、动态余额 2 个、迟到暂停快照 1 个）；材料生成共用组件 4 个。
- contracts/domain/registry/applicability/API 编译、web 完整 TypeScript 检查和 Vite 构建通过。构建保留现有大 bundle 提示。
- 契约 **171 + 12** 合成示例、**4** 生命周期示例、**40/40** 契约测试通过。公共契约未改动。

执行方式（仓库独立工作区，Node 为本机 bundled runtime，Edge）：

```text
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
# 依次编译 packages/domain、packages/rule-pack-registry、packages/rule-applicability-context、apps/api
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
# 以下命令在 apps/web 中执行
node --test dist-test/*.test.js
node ../../node_modules/vite/bin/vite.js build
# 独立 Vite 127.0.0.1:5194；BB_E2E_BASE_URL 指向该地址，BB_E2E_BROWSER_CHANNEL=msedge
node ../../node_modules/@playwright/test/cli.js test tests/project-execution.spec.ts --grep "model progress summaries|live authoring|dynamic balance|manual task refresh|late paused|repeated pause"
node ../../node_modules/@playwright/test/cli.js test tests/m4-workspace.spec.ts --grep "dynamic material progress|generation pins direct|material progress and results"
```

首轮情况如实保留：独立工作区最初未编译 API/domain 导致 web 类型检查缺少依赖输出，依次编译后通过；第一次从仓库根运行 web 单元测试导致两个依赖工作目录的旧测试失败，改在 apps/web 执行后 102/102 通过。新增手机用例首次预期 3 条记录但只见 2 条，因为测试尚未等初始记录加载便替换事件夹具；增加初始事件已加载的同步断言，桌面/手机原有后续断言复跑 2/2 通过。没有为测试删减产品行为。

## 同尺寸原型/实现对照

同一轮测试分别使用 **1440×960** 和 **390×844** 视口，截图裁剪到进度区域。两边均为 `30b2b1f3`。用户本次“请你修改”为进度行为变更依据；未声称用户已验收截图。

| 场景 | 原型 | 实现 |
| --- | --- | --- |
| 桌面，有模型摘要 | [原型](summary-prototype-running-1440.png) | [实现](summary-implementation-running-1440.png) |
| 桌面，暂无新摘要 | [原型](summary-prototype-stale-1440.png) | [实现](summary-implementation-stale-1440.png) |
| 手机，有模型摘要 | [原型](summary-prototype-running-390.png) | [实现](summary-implementation-running-390.png) |
| 手机，暂无新摘要 | [原型](summary-prototype-stale-390.png) | [实现](summary-implementation-stale-390.png) |

逐项核对：摘要和缺少新摘要提示一致；普通处理不刷屏；积分区与暂停/结束/材料操作保留。原型仍沿用独立面板，真实页面沿用项目工作区容器、带时间的记录、全站助手和原有页脚按钮。此为已存在的页面外壳差别，本次没有布局/CSS 变更或新增面板。

## 交接

只需集成 web 源码与构建，无迁移、API、worker 或新增依赖。沿用现有服务端公开摘要事件；若模型本身没有汇报摘要，会如实提示缺少进度说明，不凭工具命令编造业务进度。本次验证不代表真实模型内容质量验收。

**开发和自测完成；尚未纳入统一本地集成版；用户未验收；代码完成，尚未部署，待统一发布。** 临时 5194 仅用于模拟 HTTP 浏览器回归，不作为用户的真实后端验收入口。
