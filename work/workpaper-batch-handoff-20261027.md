# 底稿目录批量生成交接

状态：开发与自测交付，尚未部署、尚未用户验收。
分支：feat/workpaper-batch-20261027；本次已集成 develop a9c8c5dc。
本文件不替代集成 chat 维护的 work/local-integration-handoff.md。

## 功能范围

文件生成 → 选择项目及募集说明书 → 批量生成底稿。上传 XLSX 后可预览、筛选、勾选，最多 1,000 项。系统结合募集书逐项判断，展示全部不生成项、分类、理由、可引用原文及待补材料。用户明确勾选并确认后，可生成项编制底稿及编制说明，不生成项产生对应的不适用说明；资料不足不写成业务不适用。

支持后台逐份执行、暂停/继续/取消后续排队、只重试未完成项、单独下载及按原目录 ZIP 下载。全部不生成时也可下载说明包。实际底稿每份沿用 4,500 积分，按可生成数量报价；判断及不生成项说明不另收费。目录名称列必需，推荐列：编号、底稿名称、目录路径、类型、编制要求。文件夹类型填“目录”；旧 XLS 需另存 XLSX，公式转值后再上传。

## 迁移与依赖

- 新增迁移 0117_workpaper_batches.sql、0118_workpaper_assessment.sql，已在专用本地 PostgreSQL 16 测试库应用，未触及生产。集成前核对同期迁移编号；如冲突，重编号并在新测试库重放。
- API 将已有 yazl 3.3.1 从开发依赖移至生产依赖，lockfile 同步，没有新增包版本。
- contracts、API、worker、web 需要一同构建；worker bundle 需含 m4-workpaper/SKILL.md 及匹配的 runtime manifest/hash。
- 继续使用现有 PostgreSQL、私有 Blob、Codex 适配器及账务设置，无新增环境变量、生产网络或服务配置。
- 老 worker 不识别判断 run 和新底稿批次。统一发布及回退时先暂停新入口/排队并处理活动单项；保留新增表及已有成果，不删除用户数据。

## 验证记录

- XLSX 单测覆盖 500 行真实格式合成 XLSX、共享字符串、合并分类、层级/无编号目录、路径清洗、重名、公式、重复行号和大小边界。
- 新增范围判断 API/PostgreSQL 测试通过：真实文本提取＋合成模型响应，验证生成/不适用/原始证据/无效引用降级、确认前不生成、混合及全不生成包、零收费说明、冻结确认版本、跨账号隔离、请求防重及来源变更。
- 既有文件生成浏览器回归 33 项和底稿/原型交互 6 项通过，覆盖 1440/390 宽度、350 行目录、349 项选择、3 项不生成、346 项费用、明确勾选确认、修改要求后重新判断、不确定提交恢复和全不生成说明下载入口。最终补测见下方收尾记录。HTTP 为 mock，不代表真实后端端到端验收。
- 说明 DOCX 经本机 Word 只读打开并导出 PDF，渲染为 PNG 目视核验，一页内容完整。证据为 test-evidence/workpaper-assessment/ 中纯合成样本。标准 render_docx.py 因未安装 LibreOffice 不可用，使用真实 Word 导出替代。
- 原实现已有 300 文件 API/PostgreSQL 队列压力测试、M4 真实 DOCX 输出、计费与隔离测试通过；新增确认阶段后的最终压力测试结果在收尾记录填写。模型响应和生成内容为合成，Blob 为内存替身。
- 真实模型与 Azure Blob 尚未实测。现有 Azurite 专用端到端测试未运行，不计为通过。

## 集成验收步骤

1. 将固定提交集成到独立工作区，应用迁移并同步构建各包，使用独立测试数据库、私有存储及账号。
2. 选择获授权募集书，上传含目录、同名文件、缺项及原始证据项目的 XLSX。点击判断，核对每项分类、引用、理由和待补材料；未确认不得生成。
3. 分别测试混合及全不生成情况；确认后检查每项对应 Word。小批真实模型验证语义判断和正文质量，再按授权范围测试大批量。本次 1,000 为代码上限，未跑 1,000 份真实模型。
4. 检查刷新/关闭页面、暂停/继续/取消排队、失败重试与账务；成功文件应保留。
5. 改换募集书或修改要求后，未提交范围须重新判断；已提交批次继续使用原版本。跨账号目录、批次、说明和 ZIP 不可读取。
6. 检查 ZIP 底稿/编制说明/不适用说明目录、编号、数量和生成清单，打开 Word 并由业务人员复核。不要把自动化通过当成用户或专业验收。

原型与实现同尺寸截图见 apps/web/test-evidence/workpaper-batch/README.md。临时 Vite 仅用于 mock 浏览器验证，不作为统一本地验收入口交付。

## 复现

构建 contracts、API、worker、web。BB_TEST_DATABASE_URL 指向已应用全部迁移的独立 PostgreSQL 16 模板库，测试会克隆并清理子库；禁止使用生产库。BONDBUDDY_TEST_PYTHON 指向装有 python-docx 的 Python。

- node --test apps/api/dist/workpaper-catalogue.test.js apps/api/dist/docx-inspector.test.js apps/api/dist/m4-knowledge.test.js
- node --test apps/worker/dist/workpaper-assessment.pg.test.js apps/worker/dist/workpapers.pg.test.js
- node --test apps/worker/dist/m4-runtime-skills.test.js apps/worker/dist/m4-stages.test.js
- node --test apps/api/dist/m4-fixed-billing.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js
- 浏览器在 apps/web 运行，设置 BB_E2E_BASE_URL 为本地 Vite、BB_E2E_BROWSER_CHANNEL=msedge，执行 node ../../node_modules/@playwright/test/cli.js test tests/workpaper-batch.spec.ts tests/file-generation-workbench.spec.ts。

压力测试时限为 30 分钟，覆盖 300 份。浏览器测试无需真实模型账号。

## 最终收尾记录

- 新流程 300 份压力测试通过，主测试 600 秒（总运行 612 秒）：25 组范围判断检查点，确认后导入 300 项；1 项故意失败，其他 299 项成功；只重试失败项，共 301 次尝试得到 300 份底稿和 300 份编制说明，ZIP 共 601 个唯一条目。额外 3 项取消后恢复，合计 304 次合成处理。固定来源、防重、并发调度、暂停、账务和成功 run 保留均通过。
- 浏览器最终 7 项底稿/原型测试通过，增加募集书变更后的旧确认请求恢复；与现有 33 项文件生成回归合计 40 项。截图已更新并目视检查。
- M4 skill/hash 及正文/编制说明输出回归通过：完整组 21 项通过、1 项平台 symlink 跳过；原工作稿准备页断言因新流程变更已改为确认范围断言，该项独立重跑通过，并实际写出两份可编辑 DOCX。
- 固定和动态积分回归 2 项通过；范围判断及 5 项 XLSX 回归再次通过。contracts、API、worker、web TypeScript 和 Vite build 通过，已有大 chunk 提示保留。公共契约 171＋12 样例与 4 个生命周期样例通过。
- 最新 develop 仍为 a9c8c5dc；未部署、未提供集成测试入口、未宣称用户验收或真实模型实测完成。

## 2026-10-27 本功能独立本地验收版

用户明确要求本地运行验收后，已启动 http://localhost:5211。网页、API、worker 固定为 `9e9ddf35170c191524e5f211f4579076db226161`；PR #762 已推送三个真实链路修复：首次空目录页面（772da5a5）、Excel 中文数字实体解析（dc57d245）、模型严格输出格式（9e9ddf35）。

环境位于本工作区 `work/local-acceptance-20261027/`，启停与账号见该目录 README.md。Docker Compose 实例 `bb-workpaper-acceptance-20261027`，独立数据库、持久化 Azurite 和测试积分；唯一宿主机入口为 127.0.0.1:5211。数据库已应用 0117、0118，没有生产变更，也没有改写共享集成交接文件。

真实浏览器已验证登录、募集书上传采用、实际 XLSX 上传解析、四项真实模型判断和明确确认门。四种状态各一项，确认前无底稿批次；确认后得到一份分析底稿、一份编制说明、三份未生成说明和生成清单，ZIP 六个唯一条目、84,847 字节。判断调用为 gpt-6-sol、20,188 ms；文稿调用 433,130 ms，两者均 measured usage、exit 0。引用位置来自服务端核对的原文；五份 Word 均可读取，资产负债率 60%，资料不足和原始证据说明均明确“尚不能认定该业务不适用”。实际测试积分 4,500。

本次增量交互回归 6/6；解析和严格模型格式单测 9/9，单测内 PostgreSQL 用例因未提供专用测试库跳过。实际上传、Blob、数据库和模型链路使用上述隔离运行环境。合成样本及测试积分不代表真实客户材料或生产账务；此前 300 份压力测试仍为合成模型，未执行几百份真实模型生成。

状态：开发和自测完成；本功能独立本地验收版可验收；用户尚未验收，代码尚未部署，待统一发布。真实证据见 `test-evidence/workpaper-local-20261027/`。自测项目：http://localhost:5211/#generate?project=f5cf3d46-1312-430f-befd-ce63ee6a2d8b&step=workpapers 。真实生成样本只有一份底稿，本次约七分钟，批量真实模型耗时和内容质量仍待用户验收。
