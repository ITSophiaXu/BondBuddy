# 底稿变更关联验证 2026-10-27

独立开发分支：`feat/workpaper-traceability-20261027`。不连接生产，未部署。前置 PR #762。

代码固定于 `4245cdf8`，依赖 #762 的 `dce0a78d`。整合后web类型检查、Vite正式构建和12项Playwright回归再次通过；本目录后续证据提交只变更文档与截图。

已运行：

- TypeScript：contracts、API、worker 编译及 web `--noEmit` 通过；Vite正式构建通过，仅有既有大包体积提示。
- Node首轮：45个测试报告通过（导入共享XLSX fixture会重复注册目录测试）。包含真实Fastify/PostgreSQL的分类确认、不可变输入、旧新募集书定位、所有权隔离，以及300份持久任务、失败隔离/重试、计费与300条ZIP文件压力测试。300份用合成文件和合成生成阶段，未调用真实模型。
- 生成工作区：实际读写DOCX与固定模板、全文source-spans、缺coverage拒绝、正确coverage及引用通过、编制说明保留内部；模型阶段由测试适配器替代。
- Python：5项通过，涵盖长表尾数据、脚注、图片部分读取、插入段落不误移、表头变化和删除；147个中性模板均检验hash、XML/ZIP、关系、七类和旧事实清除。
- 浏览器：9项目录生成流程及原型回归、3项文件库测试通过；API为mock。桌面/手机搜索、分页、预览、下载、失效、重试、历史批次重新编制。
- 用户实际审核表只在本机只读解析：默认尽调页248个文件条目、无解析警告；此数没有固化在应用逻辑中，原件不提交。

离线渲染使用 `render_docx.py`、已有LibreOffice/CJK镜像和pdf2image依赖，禁用网络。API真实生成的合成资料不足说明为1页，已目视核对。七类格式另做79页高填充探针并逐页查看缩略图，确认格式可打开，同时观察到模板窄列/强制分页对任意长文本填充有限制；探针不作为排版通过的业务文档。实际模型必须按字段整理列宽、清理空行/分页并渲染检查，不能将中性模板直接交付。

复现使用Node22、Python3.11+及PostgreSQL16。先按迁移建立独立数据库，设置 `BB_TEST_DATABASE_URL` 和 `BONDBUDDY_TEST_PYTHON`；运行 `apps/worker/dist/workpaper-assessment.pg.test.js`、`workpaper-library.pg.test.js`、`workpapers.pg.test.js`；生成阶段定向运行 `node --test --test-name-pattern=workpaper apps/worker/dist/m4-stages.test.js`。前端设置 `BB_E2E_BASE_URL` 后运行上述两个Playwright spec。Python设置 `PYTHONPATH=python`，运行 `unittest discover -s python/tests -p test_workpaper*.py`。

真实模型的覆盖相关性、全部生成稿、数字勾稽、图片OCR和Word/WPS排版留给统一本地集成验收。本记录不冒充真实模型效果或专业一致性签认。确定性检查只定位已建立关联的变动；新增、未映射或未读取内容标为需核对。
