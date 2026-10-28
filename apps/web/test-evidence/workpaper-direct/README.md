# 直接批量生成底稿 · 2026-10-28

用户明确要求取消“先检查可生成文件”。本次将入口改为一次提交即创建批次，每份文件在同一次编制调用内确定结果并输出底稿或具体说明。不是隐藏独立检查按钮后继续串行调用 assessment。

基线：develop `5d24d5d85a0c9fb7551354b437d832f9a475867e`。实现、原型及本证据在同一提交；对应 PR #773，影响已迁移文件生成 → 批量生成底稿页面（前端 #361）。开发和自测完成，尚未部署；本地集成版和用户验收尚未完成。

## 原型与实现

实现：`apps/web/src/workpaper-panel.ts`。原型：`product-prototype/public/workpaper-batch.html`。页面流程均为“选择底稿 → 批量生成 → 下载文件”，操作卡显示费用上限和说明文件退款规则。

|状态|实际页面（1440 / 390）|原型（1440 / 390）|
|---|---|---|
|选好文件，尚未提交|preparation-1440.png / preparation-390.png|prototype-preparation-1440.png / prototype-preparation-390.png|
|主按钮局部|preparation-card-1440.png / preparation-card-390.png|prototype-preparation-card-1440.png / prototype-preparation-card-390.png|
|提交后进度|progress-1440.png / progress-390.png|prototype-progress-1440.png / prototype-progress-390.png|

12 张截图已逐张查看，主按钮、价格与说明没有裁切；390px 没有水平溢出。均使用合成目录，350 项中取消 1 项，实际提交 349 项。原型演示 3 项完成，实现截图为队列刚创建的 0 项完成。实现保留全站导航、来源项目和文件库入口；原型是独立内容页。既有表格密度不同，实现滚动区约显示 6 行，原型约 10 行；上传区原型使用通用介绍，实际页显示默认尽调范围。主操作卡布局、文案和行为一致，用户最终视觉验收待完成。

## 验证

- Edge / Playwright `apps/web/tests/workpaper-batch.spec.ts`：13/13 通过，0 跳过。包括一击提交、没有 assessment 请求、旧检查暂停／运行／完成均不设门槛、响应丢失和刷新、旧已确认付费请求原样重放、空选择、暂停续跑、说明下载入口、旧批次重新编制、桌面与手机原型。
- PostgreSQL 16.10：在仅监听本机的独立合成数据库完整执行迁移 0001–0120。300 项直接批次经过真实 API、数据库队列、输入锁定、结算和下载，失败项重试后交付 299 份底稿及 1 份说明，ZIP 共 300 个不重复文件；旧检查保留但不阻挡新批次。Blob 和模型均为测试替身。
- 说明结果在编制阶段持久化，停止追扣余款；已扣进度积分以追加流水全额退回。结果发布只清除积分暂停，不撤销用户暂停。按 run 固定结果、跨用户拒绝、重复发布和失败项重试均覆盖。
- M4 单次文件编制测试实际执行工作区准备、结果收集、Word 输出及交付：生成和资料不足两种结果均只调用一次合成模型；说明由指定模板形成，没有第二次模型调用。旧 assessment 和文件库数据库回归继续验证兼容。
- M4/API/worker 定向回归：38 通过、0 失败、1 跳过。唯一跳过为 Windows 不支持的输出符号链接场景，需 Linux CI 验证，未计为通过。
- contracts：49 个测试通过，171 个合成例、12 个内部资料例及 4 个生命周期例通过。contracts、API、worker、web TypeScript 通过；Vite 生产构建通过，保留既有大于 500 kB chunk 提示。

复现：构建 contracts/API/worker；将 `BB_TEST_DATABASE_URL` 指向迁移后的独立测试模板库，设置 `BONDBUDDY_TEST_PYTHON`、`BONDBUDDY_WORD_PYTHON`、`BB_PYTHON` 为业务 Python，运行 `workpapers.pg.test.js`、`workpaper-assessment.pg.test.js`、`workpaper-library.pg.test.js`、`m4-stages.test.js`、`workpaper-direct-output.test.js`、`workpaper-traceability.test.js` 及相关 M4 billing/workspace 测试。页面复现使用 Vite、`BB_E2E_BASE_URL=http://127.0.0.1:5237`、`BB_E2E_BROWSER_CHANNEL=msedge` 和上述 Playwright 文件。

本次没有真实模型调用、真实客户文件生成或生产账务操作。浏览器测试模拟 HTTP；数据库回归使用真实 API/队列/账务与合成模型、内存 Blob；不能据此认定真实内容、排版或用户验收已通过。临时网页和数据库在交付前停止，不将其称为已启动的统一本地集成版。

## 迁移与集成

新增 `db/migrations/0120_workpaper_direct_generation.sql`，无新依赖。新增 direct/assessed 启动方式及不可变逐项结果表；历史确认方式、运行记录及输入原样保留。新提交绑定目录、来源、选择、要求和价格，旧已确认请求仍接受原 assessment 绑定。保留之前的输出错误分类和大文件 schema 修复。

统一集成 contracts、API、worker、web 和 runtime skill/hash。迁移先于新 API/worker，新后端可用后开放新页面；旧 worker 不理解 direct manifest，不能继续消费新批次。回退需先停止新提交，处理完或安全暂停 direct 批次，保留迁移和账务流水，不以删除新表回滚。发布负责人再核对实时版本和活动任务。

GitHub CI 的历史提交曾因账户付款／支出额度限制未能启动；交付时须查看 PR 最新提交的 checks。Linux 文件执行和最终用户验收仍需在统一集成中完成。本开发 chat 不执行生产发布。
