# 底稿目录批量生成交接（2026-10-27）

状态：开发与自测交付；未部署，未宣称本地集成版或用户验收完成。
分支：`feat/workpaper-batch-20261027`，基线 `origin/develop@1d8615c3`。
本文件不替代集成 chat 维护的 `work/local-integration-handoff.md`。

## 接入范围

文件生成 → 选择项目及募集说明书 → 项目条“批量生成底稿”。XLSX 目录可预览、筛选和勾选；最多 1,000 份，每份 Word 正文＋编制说明，后台逐份执行、暂停/继续/取消后续排队、失败重试与 ZIP 下载。

目录最少提供“底稿名称”或“文件名称”列；推荐列：编号、底稿名称、目录路径、类型、编制要求。文件夹类型填“目录”。旧 XLS 需另存 XLSX，公式转值后再上传。目录预览显示跳过隐藏表、公式及重名路径等提示。

每份沿用 4,500 积分，开始前展示总额。几百份真实任务会产生相应模型费用与积分消耗；本次压力测试使用合成内容，没有调用供应商。目录中的证照、访谈、函证、签章项目输出待补资料页或待执行提纲，募集书披露不视为独立核查证据。

## 迁移与依赖

- 新增迁移 `0117_workpaper_batches.sql`，已在专用本地 PostgreSQL 16 测试库应用，未触及生产库。集成前核对同期迁移编号，若冲突以追加迁移重编号，并在新测试库重放。
- API 将已有 `yazl@^3.3.1` 从 devDependency 调整为 production dependency；lockfile 同步，不增加新包版本。
- contracts、API、worker、web 需要一同构建；worker bundle 需含 `apps/worker/skills/m4-workpaper/SKILL.md` 及更新后的 runtime manifest/hash。
- 仍使用现有 Postgres、私有 Blob、Codex 适配器、队列及计费设置；无新增环境变量、生产配置或网络要求。
- 老 worker 不调度新底稿批次。统一发布及回退时先暂停新入口/排队并处理活动单项；保留新增表及已有成果，不删除用户批次数据。

## 验证记录

- XLSX 单测 5 项：500 行真实格式合成 XLSX、共享字符串、合并分类、层级/无编号目录、路径清洗、重名、公式、重复行号和大小边界。
- 浏览器 34 项通过：新增工作区 3 项＋原型 2 项＋原固定文件生成回归 29 项；覆盖 350 项预览、349 项选择/报价、准确来源、刷新恢复、不确定提交原请求重试，以及 1440/390 宽度布局。HTTP 为合成 mock，不代表真实后端端到端验收。
- M4 单份工作区验证实际 Python 写出两个可编辑 DOCX，加载准确条目、来源及新 skill，采集并交付文件；模型响应为合成。
- Office ZIP/DOCX 安全回归与 runtime skill 哈希验证通过；固定/动态积分回归通过（低余额启动、扣费、暂停、取消、退款及账号隔离）。
- contracts/API/worker/web TypeScript 和 Vite build 通过，公共契约 171＋12 样例及 4 个生命周期样例通过。Vite 原有大 chunk 提示仍存在。
- 300 项真实 Fastify API＋PostgreSQL 队列压力测试通过（467 秒）：导入 500 行并选择 300 项，故意失败 1 项，其他 299 项继续成功；重试只执行失败项，301 次尝试得到 300 份正文和 300 份说明，ZIP 为 601 个唯一条目（含清单）。核对固定原募集书输入、跨账号 404、并发领取、防重、暂停、净扣费与精确目录路径。另补测 3 项取消后恢复和互斥批次，共执行 304 次合成处理，成功项 run ID 保持不变。私有 Blob 接口为内存替身，模型调用记录为 0，不代表 Azure 存储或供应商实测。
- 需要 Azurite 的现有 `m4-pipeline.pg.test` 与 `project-files-e2e.pg.test` 本轮跳过：未配置该依赖，不计为通过。

## 集成与验收步骤

1. 将本分支固定 commit 合入独立集成工作区，应用迁移并构建 contracts/API/worker/web，使用集成专用数据库、私有存储及账号。
2. 在同一入口选择/上传获授权募集书，上传包含目录、同名文件、缺项及原始证据项目的 XLSX，核对清单和总额。
3. 先小批真实模型生成，检查正文引用、主体/期间/币种/单位、缺项标记和证据边界；再根据授权范围测试大批量生成。当前上限 1,000 是代码限制，已跑压力规模为 300，未跑 1,000 个真实模型调用。
4. 运行中刷新/关闭页面；暂停、继续、取消后续排队，确认完成项保持可下载；制造一项可控失败并仅重试该项；核对账务及失败退款。
5. 上传新募集书后确认已提交批次继续使用原版本；验证异账号无法读取目录、批次或 ZIP。
6. 检查 ZIP 编号/目录/文件数量及清单，实际打开 Word；由业务人员复核后记录用户验收。不要将工程测试通过视为专业复核。

原型与实现截图见 `apps/web/test-evidence/workpaper-batch/README.md`。本次临时 Vite 仅用于 mock 浏览器测试，不作为可用的统一集成验收地址交付。

## 复现命令

在已安装依赖的仓库内构建 contracts、API、worker；`BB_TEST_DATABASE_URL` 指向已应用全部迁移的独立 PostgreSQL 16 模板库，测试会克隆并清理子库。禁止填生产地址。

```text
node --test apps/api/dist/workpaper-catalogue.test.js apps/api/dist/docx-inspector.test.js apps/api/dist/m4-knowledge.test.js
node --test apps/api/dist/m4-fixed-billing.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js
node --test apps/worker/dist/workpapers.pg.test.js
node --test --test-name-pattern="workpaper CLI" apps/worker/dist/m4-stages.test.js
```

最后一条需 `BONDBUDDY_TEST_PYTHON` 指向装有 python-docx 的 Python。压力测试时限为 30 分钟，覆盖文件数为 300；首次 10 分钟时限曾在本机负载下不足，最终版本完整通过。

浏览器测试在 `apps/web` 下运行，设置 `BB_E2E_BASE_URL` 为本地 Vite、`BB_E2E_BROWSER_CHANNEL=msedge`，执行 `node ../../node_modules/@playwright/test/cli.js test tests/workpaper-batch.spec.ts tests/file-generation-workbench.spec.ts --config playwright.config.ts`。不需要真实模型账号。
