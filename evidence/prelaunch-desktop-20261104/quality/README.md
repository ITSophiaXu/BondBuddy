# 文件生成质量：覆盖分析与离线机械检查

日期：2026-11-04。检查对象为本工作区的当前实现；观察到的 HEAD 为 `ecfd757407a499026df487f2ab01486687ad860b`，Git tree 为 `8a74adc661689938d24a62c91cb55a6f3d43620e`。本记录不是发布凭据。测试期间未修改 worker、生成器或质量阈值，未 cherry-pick #871，未操作线上账号、生产配置或积分。

结论：原件完整性、解析锚点、固定编辑、修订/清洁关系和部分输入链有机械证据，但**正式生成质量验收未完成**。当前实现仍沿用质量拒绝可作为 advisory 交付的旧政策；#871 的独立质量门禁及当前最终 commit/tree 的真实模型金样、独立财务/章节/完整渲染复核未完成，不能以本轮 synthetic 或离线原件检查替代。

## 依据与样本边界

- [2026-09-25 授权样本索引](../../../tests/samples/README.md)：4 案例、15 原件、26,246,609 字节，仅限团队开发/测试；不是公开再分发、跨用户复用或生产参考库授权。
- [目标期间与缺失材料决定](../../../tests/samples/2026-09-25/TARGET-CONFIRMATIONS.md)：只确认目标与具体缺口处理，不代表财务事实或成果验收通过。缺失值不能填零或编造；必要历史比较数不能因不属于主要目标期间而删除。
- #871 位于另一个独立工作区 `C:/Users/lezhai/Downloads/Bondbuddy/prospectus-quality-20261101`，本轮只读观察其 HEAD `dca895ff66b71efb9f960ab10f70e253356e6074`。其 [质量决定](C:/Users/lezhai/Downloads/Bondbuddy/prospectus-quality-20261101/docs/product-decisions/2026-11-01-prospectus-quality-gate.md) 明确覆盖 10 月 2 日“双 Word 即交付”的旧规定。该分支的检查结果不能归到本工作区，也不能签发本工作区的发布凭据。

四组真实原件均为上交所普通私募样本，不覆盖其他市场/品种、完整扫描 PDF/OCR、无原稿首稿或全部客户模板。本轮未上传这些原件；授权 DOCX 只在本机读取、解析和进行临时 synthetic 固定编辑，原件不变，临时成果由测试清理。

## 本轮实跑

| 检查 | 结果 | 证据及范围 |
| --- | --- | --- |
| 原件 manifest SHA-256、大小、Office/PDF 基础完整性 | 15/15 原件通过 | [authorized-samples.log](authorized-samples.log)，26,246,609 字节；不证明正文事实正确 |
| Windows Python 解析与 Word 综合 | 99 项：98 通过、1 失败、0 skip | [python-mechanical.log](python-mechanical.log)，失败原样保留；其中四份授权历史 DOCX 采用 synthetic 固定编辑，非真实模型更新 |
| Linux 首稿 writer 复验 | 8/8 通过、0 skip | [linux-no-history-word.log](linux-no-history-word.log)，包含上述权限失败所在测试；未修改断言/源码 |
| 精确原文改动、重复金额不同期间、缺失事实保留和来源链接 | 5/5 通过、0 skip | [python-project-files.log](python-project-files.log)，全部为 synthetic 文稿 |
| worker 输入、材料工具、格式/交付、有限财务提取 | 首轮 22 项：21 通过、1 opt-in skip | [worker-mechanical.log](worker-mechanical.log)；其中旧 advisory 交付行为“通过”是政策缺口，见下文 |
| 显式开启授权任丘历史稿真实 parser 回归 | 7/7 通过、0 skip | [worker-authorized-facts.log](worker-authorized-facts.log)，包含首轮跳过项，另外六项为重复回归，不叠加成新增覆盖；有限 16 个年度原始位置不等于全文财务验收 |
| API 原稿格式选择、自动采用迁移及输入链 | 首轮 11 项：6 通过、5 因未配置 Azurite skip | [api-input-lock.log](api-input-lock.log)，保留最初 skip |
| 真实 HTTP/PG/本机 Azurite 输入链 | 中间 4/5 通过、1 缺 Python skip；最终 5/5 通过、0 skip | [中间记录](api-http-input-chain.log)、[最终记录](api-http-input-chain-full.log)，合成账号/材料与真实服务端处理；五项已在首轮出现，不能重复计数 |
| Linux 多产品入口的本地导出/来源机械检查 | 94/94 通过、0 skip | [linux-product-export.log](linux-product-export.log)，包含底稿、M4 计算/来源、诚信 DOCX、问答回填、复核 DOCX/PDF 批注与修订导出；全部为 synthetic 内容或已随库交付的中性格式模板，无模型调用 |
| DOCX 包、底稿 ZIP/下载及 M4/复核 stage 边界 | 54 项：52 通过、2 个 Linux 限定 symlink skip | [product-export-boundaries.log](product-export-boundaries.log)，真实 Fastify 与内存 DB/Blob fixture；M4/复核的模型回调为 fake，不能算真实模型/PG/生产验收 |
| Linux 符号链接安全边界复验 | 2/2 通过、0 skip | [linux-symlink-boundaries.log](linux-symlink-boundaries.log)，原样运行 Node54 中 Windows 跳过的两项；不删除或更改原 skip，不扩大为整套 Linux gate |

Python 综合的分组数：parser 39、授权 DOCX parser 1、outline 7、file authoring 7、fixed edit 18、四原稿 fixed-edit replay 1（4 个子案例）、unified Word 8、首稿 writer 8、Word delivery 5、revision CLI 5。

Windows 失败是 `test_rejects_existing_output_and_unsafe_directory` 中 `chmod(0755)` 应触发 `OUTPUT_DIRECTORY_UNSAFE` 的断言。Windows 没有相同的 Unix mode 语义。使用现有 WSL Linux `/opt/venv/bin/python` 原样重跑该 writer 的全部 8 项，通过；原 Windows 失败没有删除、改写成通过或通过扩大 skip 隐藏。这个局部复验不是整套 Linux 质量门禁。

多入口 Python 的分组数：底稿 shared 11、147 份中性格式模板 1、底稿 source 4、M4 finance 17、finance tool 3、effective source 2、诚信报告 4、项目问答 9、复核 Word 16、复核文件批注 14、复核修订 13，共 94 项。问答的旧 DOC 转换使用现有 LibreOffice，未 skip。底稿 ZIP 测试逐成员核对 248 份 synthetic DOCX 的 CRC、hash、命名及原始输入不变，另测缺失/截断/损坏/超限、存储超时、失败重试和重复下载缓存；这些不证明 248 份真实模型底稿的业务质量或部分生成失败后的批次恢复正确。

各产品入口及 DOCX/PDF/ZIP 的实际输出格式、损坏/错版材料/部分失败/重复生成与继续修改的覆盖边界，见[场景矩阵的产品入口映射](scenario-matrix.md#产品入口与实际输出格式)。XLSX 在所列场景中作为财务材料或底稿目录输入；本轮没有测试或承诺生成 XLSX 成果，不能由募集书组件测试推及全部模块通过。

## 已确认的政策缺口与未执行项

当前 [file-authoring-delivery.test.ts](../../../apps/worker/src/file-authoring-delivery.test.ts:20) 仍要求 `WORD_QUALITY_REJECTED` 属于 advisory，结果为 `deliver`、`deliveryPolicy=generated_pair_v1`、`content_review=not_performed`。它证明旧交付行为仍在，不能证明符合 11 月 1 日可信宿主失败必须拒绝的要求。没有将该测试改成“通过新质量要求”，也没有在本任务修改敏感生成代码。

本轮未启动真实 worker 模型执行、未发起任何模型调用，未运行当前最终候选的完整 `quality:prospectus:validate` 或 `quality:prospectus`，未产生或伪造质量通过凭据。没有执行生产真实原稿→模型→双 Word→真实下载全链路，也没有执行独立全文财务事实、规则适用、逐页视觉和 Word/WPS 客户端复核。真实 worker/沙箱/检查点与数据库交付仍须在准确最终候选及固定 Linux 清单复验。

[场景矩阵](scenario-matrix.md) 逐项区分机械证据、已知政策缺口和必须补做的真实验收。矩阵中 #871 与同 ID 首稿续改的合并前场景均为待执行项，没有把只读兼容审查当成集成通过。

## 既有真实失败证据

以下来自 #871 独立分支的 [既有回归记录](C:/Users/lezhai/Downloads/Bondbuddy/prospectus-quality-20261101/docs/acceptance/prospectus-quality-regression-20261101.md)，本轮只读其记录，没有重新打开私有客户取证或重新调用模型：

- 早期真实 V1 丢失原稿输入，宿主按无基线首稿处理。同一 LibreOffice 环境原稿/V1/V2 为 196/37/196 页，不能将此写成最初 104→39 页反馈的精确复现；V1 的双稿同 ID/同字节也不能证明保留了原稿。
- 后续真实候选多次出现主表正确而正文旧金额/比例遗漏，结构和机械通过不能抵销它们。
- `0f140e5b` 固定机械 319/319，但真实财务和视觉复核未通过；固定 43 位置为 29 匹配、14 拒绝，包含期间释义冲突、2 处确认未更新的正文金额及待核定位，不能宣称 14 个错误金额。还发现表题孤立、跨页表头及空格填值继承的字体/对齐问题。
- 后续补丁和零模型重放不改变原真实运行的失败/未通过结论。当前最终候选的真实模型金样、独立复核与完整分页复核仍未完成。

## 可复现命令与环境

当前 Windows Node 为 26.13.0，WSL Linux Node 为 24.14.0；Windows bundled Python 为 3.12.14，WSL Linux Python 为 3.12.3。此环境不同于发布要求的固定 Linux/准确发行镜像，不能据此签发发布凭据。

```powershell
# Windows bundled Python 路径通过 load_workspace_dependencies 取得。
$env:PYTHONPATH='python'
$env:PYTHONUTF8='1'
$env:PYTHONIOENCODING='utf-8'
$env:BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION='1'
python tests/samples/verify.py
python -m unittest python.tests.test_document_parser python.tests.test_authorized_docx_regression python.tests.test_source_outline python.tests.test_file_authoring python.tests.test_fixed_edit python.tests.test_fixed_edit_authorized python.tests.test_unified_word python.tests.test_no_history_word_writer python.tests.test_word_delivery python.tests.test_revision_cli -v
python -m unittest python.tests.test_project_files -v

# BONDBUDDY_TEST_PYTHON 与 BB_PYTHON 指向上述已安装依赖的 Python。
node --test --test-concurrency=1 apps/worker/dist/unified-input.test.js apps/worker/dist/authoring-material-tools.test.js apps/worker/dist/file-authoring-format.test.js apps/worker/dist/file-authoring-delivery.test.js apps/worker/dist/rq-prospectus-annual-fact-extractor.test.js
$env:BB_RUN_AUTHORIZED_RQ_ANNUAL_FACT_TESTS='1'
node --test apps/worker/dist/rq-prospectus-annual-fact-extractor.test.js

# BB_TEST_DATABASE_URL 指向专用 loopback、完整迁移的测试模板，由 helper 克隆/清理。
# BB_TEST_AZURITE_CONNECTION_STRING 仅指向本任务 127.0.0.1:11066 的 Azurite。
node --test --test-concurrency=1 apps/api/dist/source-format.test.js apps/api/dist/source-format.pg.test.js apps/api/dist/prospectus-auto-adoption.pg.test.js apps/api/dist/input-revision-chain.pg.test.js
node --test --test-concurrency=1 apps/api/dist/input-revision-chain.pg.test.js

# 各入口的包/下载/stage 边界：仍为 fake 模型及内存 DB/Blob fixture。
node --test --test-concurrency=1 apps/api/dist/docx-inspector.test.js apps/api/dist/workpaper-download.test.js apps/api/dist/workpaper-zip.test.js apps/api/dist/word-delivery-artifact.test.js apps/worker/dist/workpaper-direct-output.test.js apps/worker/dist/m4-stages.test.js apps/worker/dist/review-file-stage.test.js
```

Linux 复验用 `PYTHONPATH=<当前工作区>/python /opt/venv/bin/python -m unittest discover -s <当前工作区>/python/tests -p test_no_history_word_writer.py -v`。API dist 已由同工作区 `tsc -p apps/api/tsconfig.json` 编译；worker dist 沿用本批根构建。运行时没有提供生产 `DATABASE_URL`、Blob 或模型凭据。

Linux 多入口命令是在当前工作区运行 `PYTHONPATH=python /opt/venv/bin/python -m unittest python.tests.test_workpaper_shared_batch python.tests.test_workpaper_templates python.tests.test_workpaper_source python.tests.test_m4_finance python.tests.test_m4_finance_tool python.tests.test_m4_effective_source python.tests.test_integrity_report python.tests.test_project_qa python.tests.test_review_word python.tests.test_review_file_annotations python.tests.test_review_corrections -v`。首次普通沙箱调用 WSL 被 `Wsl/Service/E_ACCESSDENIED` 拒绝，保留 [原始失败日志](linux-product-export-attempt-denied.log)；经仅本机测试的沙箱提权后才完成上述 94 项，没有修改 skip 或安装运行环境。

Linux 符号链接复验使用现有 Node 及上述 Python，在当前工作区设置 `BONDBUDDY_TEST_PYTHON=/opt/venv/bin/python BONDBUDDY_WORD_PYTHON=/opt/venv/bin/python BB_PYTHON=/opt/venv/bin/python PYTHONPATH=python`，运行 `node --test --test-concurrency=1 --test-name-pattern=symlink apps/worker/dist/m4-stages.test.js apps/worker/dist/review-file-stage.test.js`。两项均执行且通过；不是完整 M4/复核 Linux stage 回归。

本任务专用 Azurite 仅绑定 `127.0.0.1:11066`，最终启动包含 `--disableTelemetry`；首次默认匿名遥测连接被沙箱 `EACCES` 阻断，随后在任何材料上传前停止并禁用遥测重启。HTTP 输入链只向本机上传 synthetic 材料。PostgreSQL 复用本任务测试模板的隔离克隆，由账务 agent 统一检查清理和停止；没有读写生产或用户账本。

质量检查结束后已正常中断本任务创建的 Azurite，并确认 `11066` 无监听；保留本机数据目录。已通知账务 agent 不再使用 PG，未停止其仍在使用的实例。日志 SHA-256 清单为 [SHA256SUMS](SHA256SUMS)，只用于核对本批证据原字节，不是质量通过凭据。
