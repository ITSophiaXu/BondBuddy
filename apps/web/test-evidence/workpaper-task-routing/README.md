# 文件生成任务误入募集书更新页面：验证与交接

日期：2026-10-28。开发和自测完成；未纳入统一本地集成版，用户未验收；**代码完成，尚未部署，待统一发布**。

## 问题与修复

用户从“全部项目”展开文件生成任务，点击“查看任务”后进入募集书全文更新状态页。底稿范围检查和新版募集书影响检查的 run 使用 `generation`，但任务集合投影没有关联对应检查表，返回的 `operation`、`topic_id` 均为空；前端因此落到募集书编制路由。

- 任务集合按真实检查记录返回 `workpaper_assessment` / `workpaper_check`，任务名称分别为“检查可生成底稿”/“检查底稿更新影响”。各自独立参与待处理汇总，避免与编制任务互相覆盖。
- 两类任务在现有文件生成工作区打开，URL 保留项目、run 和 operation。状态、目录、募集书版本、检查进度、要求及完成结果来自所选执行；不恢复为最新任务，不因查看而创建文件工作区或提交生成。
- 新增只读 `GET /projects/:project_id/workpapers/assessments/:run_id`，即使原检查早于最近 20 条也能读取；不存在、其他项目和其他账号均返回 404。现有工作区和历史输入不改写。
- 旧募集书工作区链接在原有异步任务恢复中纠正，保留返回项目。不会在页面入口阻塞草稿编辑；底稿检查排除出编制任务自动恢复候选。
- 暂停、继续、停止复用原 run 接口；服务正在核对执行结果时只提供刷新和停止，不显示手动继续。打开、刷新、旧链接恢复均不提交新检查/生成。
- 按模板生成的 M4 topic 路由及旧版募集书 generation 任务保留原行为。

## 固定版本与原型

基线：`e05df68f`（develop）。实现、测试、原型和截图同一源码提交：`ec925299f0cedc3d8fd9e6bc274095bbeb551b74`。

原型：`product-prototype/public/workpaper-task.html`；共享样式 `workpaper-task.css`。实现：`apps/web/src/workpaper-task.ts`，挂在 `FileWorkspace` 已有工作区内；任务入口共享于全部项目、项目文件和 BondBuddy 任务卡。

用户本次截图要求为任务类型纠正依据。保留文件生成工作区导航，没有改动准备/确认生成流程。1440×960、390×960 原型与实现同尺寸检查：检查标题、状态、固定输入、已检查条数及操作顺序相同；原型仅展示本次检查卡，实际产品保留既有项目导航和侧栏。卡片使用同一份样式，已人工查看截图，未发现裁切、横向溢出或控件重叠。

| 视口 | 实际页面 | 原型检查卡 |
| --- | --- | --- |
| 1440×960 | [paused-1440.png](paused-1440.png) | [prototype-paused-1440.png](prototype-paused-1440.png) |
| 390×960 | [paused-390.png](paused-390.png) | [prototype-paused-390.png](prototype-paused-390.png) |

## 验证

- Edge 浏览器：本次路由场景 **8/8**，异步读取期间编辑恢复 **1/1**；最后一次定向执行 **9/9**。包括从列表点击、刷新、继续同一个 run、旧链接跨页查找、历史检查结果、缺失/异项目拒绝、影响检查选择旧 run、服务核对期间不重提，以及两种宽度原型。
- 原有底稿生成 **15/15**；全部项目 **3/3**。两组均保留原业务断言。
- 路由/恢复模型单元 **9/9**；实际本地 PostgreSQL API 集成 **1/1**（不跳过），覆盖 23 条检查历史、任务类型/汇总、原始编制分类及项目/账号隔离。
- contracts、domain、rule-pack-registry、rule-applicability-context、API 编译；web TypeScript 与 Vite 构建通过。171 个公共样例、12 个内部样例、4 个生命周期样例通过。没有新增迁移、依赖或 worker 修改。
- 开发过程扩展回归 100 项曾为 87 通过、12 失败、1 可选跳过。入口阻塞与旧链接夹具两个问题已修正，最终定向 9/9。另 **10 项原有失败**在未修改 `e05df68f` 独立工作区逐项复现：1 项旧“连接中断”文案断言、4 项上传回执夹具、3 项取消后继续修改入口、2 项误传替换入口。没有放宽这些断言，也不将整个旧测试集记为通过。

主要命令：

```text
node --test apps/api/dist/workpaper-task-routing.pg.test.js
node --test apps/web/dist-test/project-collection-model.test.js
playwright test tests/workpaper-task-routing.spec.ts
playwright test tests/authoring-continuation.spec.ts --grep "initial task read"
playwright test tests/workpaper-batch.spec.ts tests/all-projects.spec.ts
```

数据库使用独立本机空实例和私有克隆；浏览器使用真实前端及 synthetic HTTP。没有访问或改变用户线上任务，没有真实模型调用、生成质量验收或客户扣费。测试模拟不能当作用户验收。

## 集成与发布

需将 API 与 web 同批纳入集成测试；API 负责补齐已存在任务的类型并提供按执行读取检查的接口。沿用已经存在的 0118/0119 表，不迁移或重建历史任务，worker 无需变化。先用原暂停任务验证“全部项目 → 查看任务”，并验证项目文件中的同一任务入口；查看应无业务写请求。后续恢复任务仍受服务端既有条件约束。

本次没有生产发布或线上暂停任务恢复；不把 PR 合并或测试通过视为用户验收。专门发布 chat 按既定流程统一发布。

## 后续核对：项目问答

2026-10-28 用户追问项目问答是否同样误跳转。检查现有链路未发现相同遗漏：问答创建在同一事务内写入 `generation` run 和 `bb_project_qa_runs`；任务集合原已关联该表并返回 `qa_prepare` / `qa_answer`，两者优先进入 `#qa?project=…&run=…`。问答工作区按 URL 的原 run 读取，指定历史记录不存在时提示无法读取，不切换到募集书或其他回答。此行为在本 PR 基线即已存在，本次未修改问答产品代码。

补充 `project-qa-task-routing.spec.ts`，Edge 浏览器 **5/5** 通过：从“全部项目”点击暂停/完成的识别、回答任务；有较新回答时仍选中原任务；刷新保留原 run；指定历史记录不可读时留在问答页面；所有查看和刷新均无写请求。测试使用真实前端和合成 HTTP，不是线上任务核验。

路由模型补充问答回归后 **10/10** 通过，覆盖运行、暂停、完成、失败，以及已有 Word 成果时仍优先进入对应问答任务；Web TypeScript 和 `git diff --check` 通过。没有新增迁移、依赖、费用或生产变更。
