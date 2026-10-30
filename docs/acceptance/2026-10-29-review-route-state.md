# 更新任务进入复核页：状态、导航与空项目上传修复

状态：开发和自测完成；代码完成，尚未部署，待统一发布。用户尚未验收。

## 问题与原因

用户反馈：customer_test 提交更新募集书后，从任务状态页点“复核募集书”，短暂出现项目条和选择页左右挤压；尚未创建复核任务却显示“正在复核”，侧栏高亮“全部项目”。新建且无募集书的项目仍可选择不存在的项目募集书。

基线为 develop `c7d0c42a58c467c999f9c565a7355aaef37079bf`。本轮使用真实 Edge、合成 HTTP 数据及新建的本机 PostgreSQL 16 隔离数据库复现；未在 customer_test 生产账号重新提交任务。现有浏览器登录账号不同，只作只读确认，未退出或切换账号。

1. `review-workspace` 的活动任务 SQL 同时接受 `review` 和 `update`。同一项目的更新任务被返回为复核活动任务，前端套用复核进度与材料锁定提示。独立数据库中只有一条更新任务、复核执行表和历史为空时即可复现。`review-entry` 本身仅解析项目映射，不创建任务。
2. 共享项目选择页把 `main` 设为 flex，却未指定纵向排列。新增的项目上下文条成为横向 flex 子项，挤压右侧选择页；异步跳转结束后更换布局，故表象会自行恢复。
3. 复核页用 `from=projects/dashboard` 的返回路径标记决定侧栏高亮，而没有选中当前复核功能。
4. 复核材料区无条件显示两个来源入口，即使实际材料和募集书版本均为空。

## 修复

- 活动复核只读取 `task_kind=review`；跨任务执行互斥继续由原后台逻辑保证。
- 项目上下文条与选择页纵向排列，条目不被压缩；共享原型 CSS 与实际页面共用同一修改。
- 复核工作区和复核项目信息编辑页高亮“复核募集书”；原项目关联、列表返回链接和筛选参数保留。
- 无可用材料或版本时直接显示上传区，隐藏两种方式和空版本选择器；有上传稿或生成稿时仍可选择项目版本。读取失败保留明确的重试入口，不把接口失败当作项目确定为空。
- 原型 `product-prototype/public/review-materials.html?empty=1` 演示空项目。此次行为调整以用户 2026-10-29 本次反馈为确认依据，关联页面跟踪 #361、复核范围 #3。

## 验证

修复前，新增的 4 个浏览器断言均因对应缺陷失败（桌面/手机纵向几何、空项目选项、导航高亮），真实 API 断言返回了更新 run 而非 null。

修复后通过：

- 43 个不同的 Edge 浏览器场景：共享项目入口 27；复核来源/空项目/原型 7；原有复核任务、暂停、历史、要求保存、编辑和导航回归 9。定向首轮 9 项包含已计入共享入口的 2 项，按去重计数。
- 3 项真实 PostgreSQL/API 测试：`review-task-isolation`、`review-workspace`、`review-materials`。覆盖 queued/running/paused/awaiting_input 更新任务不显示为复核、入口不创建任务、真实复核活动状态仍可显示、终止状态不再活动、原执行互斥、输入不变性、归属隔离与材料排除。无跳过。
- 项目导航/复核状态单元测试 10 项；公共契约检查通过。
- contracts/domain/rule-pack-registry/rule-applicability-context/API TypeScript 编译、web TypeScript 和 Vite 构建通过；`git diff --check` 通过。

测试过程中的环境和夹具问题已区分：最初前端端口参数未生效造成连接拒绝，服务启动后才留存上述缺陷复现；新增 API 夹具的输入版本须大于零，且没有 Word 的合成 run 不能标成功，已分别改为合法版本和 cancelled 终态后通过。未绕过数据库约束。

复跑使用仓库 Playwright 配置，设置 `BB_E2E_BASE_URL` 指向独立前端、`BB_E2E_BROWSER_CHANNEL=msedge`。API 测试的 `BB_TEST_DATABASE_URL` 必须指向新建并完成仓库迁移的测试模板库；现有测试 helper 为每个套件克隆独立库并清理。不得使用生产库。

## 画面对照

以下均为合成测试画面，无客户材料。前后桌面均 1440×960，手机均 390×960。空项目原型是既有的独立材料片段，外围页面壳不同；对照范围为来源选择与上传行为，未调整其他业务布局。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 桌面慢速切换 | [截图](evidence/review-route-state-20261029/before-context-desktop.png) | [截图](evidence/review-route-state-20261029/after-context-desktop.png) |
| 手机慢速切换 | [截图](evidence/review-route-state-20261029/before-context-phone.png) | [截图](evidence/review-route-state-20261029/after-context-phone.png) |

[复核准备状态与侧栏](evidence/review-route-state-20261029/review-ready.png) · [空项目上传](evidence/review-route-state-20261029/empty-upload.png) · [空项目材料原型](evidence/review-route-state-20261029/prototype-empty-desktop.png)

## 集成与发布

需统一发布 API 和 web；无新增依赖、数据库迁移、worker 或计费逻辑变化。本轮模型调用 0、生产任务修改 0，未提供冒充完整后端的本地验收入口。后续由指定集成/发布 chat 纳入固定测试版本，经用户验收及明确授权后发布。
