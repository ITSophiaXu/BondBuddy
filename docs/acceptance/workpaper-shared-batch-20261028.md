# 共享批次生成开发验收

状态：后端开发和自测完成；网页类型检查通过，完整网页打包受测试环境依赖下载故障阻塞；未部署、用户未验收。测试数据与模型均为 synthetic，不调用真实供应商。生产数据库、任务、账务和服务未变更。

## 隔离环境

从本地既有 `bondbuddy-release-afternoon:6a6b2c42` 镜像取得 Node 22、Python 和依赖，在独立工作区构建当前源代码。专用 PostgreSQL 16 位于 `bb-shared-plan-test-20261028` Docker 网络；没有生产连接、没有对外数据库端口，也未修改其他本地集成容器。测试数据库应用全部迁移至 0121，各 PostgreSQL 测试再克隆独立数据库。

## 自动化检查

```sh
npm run build -w @bondbuddy/contracts
npm run build -w @bondbuddy/domain
npm run build -w @bondbuddy/rule-pack-registry
npm run build -w @bondbuddy/rule-applicability-context
npm run build -w @bondbuddy/api
npm run build -w @bondbuddy/worker
PYTHONPATH=python python3 -m unittest python/tests/test_workpaper_shared_batch.py python/tests/test_project_files.py -v
node --test apps/worker/dist/workpaper-shared-stage.pg.test.js
node --test packages/contracts/dist/workpapers.test.js apps/worker/dist/m4-runtime-skills.test.js apps/worker/dist/workpaper-direct-output.test.js apps/worker/dist/workpaper-traceability.test.js apps/worker/dist/workpapers.pg.test.js apps/worker/dist/workpaper-library.pg.test.js
npm run check:contracts
npm run build -w @bondbuddy/web
```

新增 Python 检查覆盖完整长表尾行/合计、真实空白/横线/零值、单位/附注、横纵合并、嵌套表、脚注依赖、宽表关联列、PDF 原生表格、重复编制字节稳定、目录及全文映射、原文数值与口径、具体说明以及来源隔离。原有文件追踪测试同时回归。

新增 PostgreSQL 集成检查执行三个目录项、一次合成模型编制、一个原始证据说明、一次单文件失败及重试。覆盖模型日志接受后/共享计划入库前崩溃、日志重放、owner 隔离、方法变更拒绝复用、快照不可变、暂停/继续、失败后停止批次自动重发、说明退款以及完整授权 ZIP。图片字节只在私有 Blob，正文及 ZIP 不带内部记录。

已通过：Python 16 项；新共享批次集成文件 9 项（含导入的 8 项目录解析测试）；相关 Node 回归 27 项（含真实 PostgreSQL 的 300 文件批次、失败重试、计费和 ZIP）；contracts 检查的 171 个合成样例、12 个内部资料库样例、4 个生命周期样例及其附带测试。各组有重叠导入，不合并为独立用例总数。

contracts、domain、rule-pack-registry、rule-applicability-context、API、worker 构建通过。网页 `tsc --noEmit` 通过；随后 Vite 未完成，因为借用的 worker 镜像没有 `@rolldown/binding-linux-x64-gnu@1.2.9`。只向隔离容器尝试安装该固定版本，npm 官方端点在容器和 Windows 主机均返回 TLS 握手失败（包含保留证书校验的 TLS 1.2 兼容重试）。未关闭 TLS 校验，未改生产依赖或锁文件。统一集成环境需补齐正常构建依赖并重跑网页打包。

## 版式检查

使用 documents 技能的 `render_docx.py`、隔离镜像内 LibreOffice/Poppler 渲染两份合成文件：72 个主体明细及合计；有相同已披露事实的原始证据说明。生成文件 4 页、说明文件 8 页，检查全部页面的表头、末行、合并单元格、文字和页边界。原始测试材料、PNG、PDF、DOCX 和工具副本留在本地 `work/shared-batch-qa/`，不提交、不作为用户业务成果。

## 集成与发布交接

新增迁移：0121。没有新增生产 npm/Python 依赖。现有直接生成、计费、下载及旧任务路径需要与新 API/worker 同一固定版本集成。无需新增用户输入或独立预检页面。

最终统一验收待办：使用真实目录与募集说明书实际调用 Codex；逐项核对已披露数据归集、相关性、全部表格与图片、分类与所有成果页面；测量模型编制及逐项交付耗时；验收余额不足、运行中取消、重启恢复与当前网页行为。此次合成通过不能替代这些验证，不能表述为用户已验收或已上线。

已接受的共享计划不可变；本版没有模型追加修订计划的入口。内容需要重新编制时使用新批次，不自动覆盖旧批次的成功文件。
