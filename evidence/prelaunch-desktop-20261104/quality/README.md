# 文件生成质量：覆盖分析与离线机械检查

日期：2026-11-04。第一轮机械检查观察 HEAD 为 `ecfd757407a499026df487f2ab01486687ad860b`，Git tree 为 `8a74adc661689938d24a62c91cb55a6f3d43620e`；第二轮续改跨层 probe 的准确 subject 为 `8df8b5089a6e02a36165167ae536ef1e39ca7a6f`；第三轮运行实现基于 `da5974ba96d318c1dbdc6c9c22909099d220c41b`，五个现有 PG 测试夹具适配当前协议，QA 另补混合附件与恢复/结算断言，准确源码/编译产物 hash 见 [cross-entry](cross-entry/README.md)。各轮分别注明，不把后续文档提交当成重新执行的代码版本。本记录不是发布凭据。未修改业务源码、worker 运行实现、生成器或质量阈值，未复制/cherry-pick #871，未操作生产配置或积分。

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
| 第二轮续改：真实 API/PG/queue 与编译后前端 guard | 7/7 通过、0 skip（1 父 test＋6 场景） | [continuation-api-pg.log](continuation-api-pg.log)、[结构化结果与源码/编译产物 hash](continuation-api-pg-results.json)，subject `8df8b50`；合成认证、DOCX 和内存 Blob，无模型，具体边界见下文 |
| 第三轮跨入口：API9＋worker9 个现有 PG 文件 | 各文件均取得通过结果；首轮与定向复验分开记录，不跨轮累加 | [cross-entry/README.md](cross-entry/README.md)：实际 Fastify/隔离 PG/Azurite/worker 阶段、原生 Word/ZIP 及 Chromium，认证、模型和网站均合成；年度事实 parser/PG 使用既有授权原稿且只本机处理。包含所有初次及中间失败，不代表真实模型、正式商户或完整质量 gate |

Python 综合的分组数：parser 39、授权 DOCX parser 1、outline 7、file authoring 7、fixed edit 18、四原稿 fixed-edit replay 1（4 个子案例）、unified Word 8、首稿 writer 8、Word delivery 5、revision CLI 5。

Windows 失败是 `test_rejects_existing_output_and_unsafe_directory` 中 `chmod(0755)` 应触发 `OUTPUT_DIRECTORY_UNSAFE` 的断言。Windows 没有相同的 Unix mode 语义。使用现有 WSL Linux `/opt/venv/bin/python` 原样重跑该 writer 的全部 8 项，通过；原 Windows 失败没有删除、改写成通过或通过扩大 skip 隐藏。这个局部复验不是整套 Linux 质量门禁。

多入口 Python 的分组数：底稿 shared 11、147 份中性格式模板 1、底稿 source 4、M4 finance 17、finance tool 3、effective source 2、诚信报告 4、项目问答 9、复核 Word 16、复核文件批注 14、复核修订 13，共 94 项。问答的旧 DOC 转换使用现有 LibreOffice，未 skip。底稿 ZIP 测试逐成员核对 248 份 synthetic DOCX 的 CRC、hash、命名及原始输入不变，另测缺失/截断/损坏/超限、存储超时、失败重试和重复下载缓存；这些不证明 248 份真实模型底稿的业务质量或部分生成失败后的批次恢复正确。

各产品入口及 DOCX/PDF/ZIP 的实际输出格式、损坏/错版材料/部分失败/重复生成与继续修改的覆盖边界，见[场景矩阵的产品入口映射](scenario-matrix.md#产品入口与实际输出格式)。XLSX 在所列场景中作为财务材料或底稿目录输入；本轮没有测试或承诺生成 XLSX 成果，不能由募集书组件测试推及全部模块通过。

## 已确认的政策缺口与未执行项

当前 [file-authoring-delivery.test.ts](../../../apps/worker/src/file-authoring-delivery.test.ts:20) 仍要求 `WORD_QUALITY_REJECTED` 属于 advisory，结果为 `deliver`、`deliveryPolicy=generated_pair_v1`、`content_review=not_performed`。它证明旧交付行为仍在，不能证明符合 11 月 1 日可信宿主失败必须拒绝的要求。没有将该测试改成“通过新质量要求”，也没有在本任务修改敏感生成代码。

所有轮次均未发起真实供应商模型调用，未运行当前最终候选的完整 `quality:prospectus:validate` 或 `quality:prospectus`，未产生或伪造质量通过凭据。第三轮实际运行 worker 阶段、检查点与数据库交付，但模型为注入的 synthetic seam；现有 Linux CI 的原生沙箱也不等于真实模型验收。没有执行生产真实原稿→模型→双 Word→真实下载全链路，也没有执行独立全文财务事实、规则适用、逐页视觉和 Word/WPS 客户端复核。#871 合入后的准确候选及固定 Linux 清单仍须复验。

[场景矩阵](scenario-matrix.md) 逐项区分机械证据、已知政策缺口和必须补做的真实验收。第二轮仅补齐当前 `8df8b50` 的 Q15 及 Q17/Q18 部分机械证据，Q16 的可信宿主质量拒绝、#871 首稿确认 expiry guard 与最终合入候选集成仍待执行，没有把只读兼容审查当成集成通过。

## 第二轮：续改跨层机械证据

准确 subject 为 `8df8b5089a6e02a36165167ae536ef1e39ca7a6f`。先以当前源码执行 `npm exec tsc -- -p apps/api/tsconfig.json` 和 `npm exec tsc -- -p apps/web/tsconfig.test.json`，均 exit 0；随后只导入当前 API `createServer`、queue 的 `claim/promoteWordArtifact/checkpointStage/finish` 及编译后的 `readContinuationBasis`。没有修改这些实现或移植 #871。

真实执行部分包括通过 `app.inject` 调用的 Fastify HTTP handlers、专用 PostgreSQL 16.14 隔离克隆、queue 事务、同字节成果登记与当前稿选择、artifact 元数据和授权下载、前端 guard 及 input 持久化。`app.inject` 没有经过 TCP、Nginx、前端 ApiClient 或浏览器；结果 JSON 保留的当时标签 `metadata: "real HTTP"` 只指真实 route 处理，不代表真实网络请求。认证为注入的 synthetic principal，Word 为合成 DOCX，私有 Blob 接口由内存 Map 实现；没有真实登录浏览器、Azurite/Azure 或模型。因此不能写成生产或真实模型全链路验收。

| 场景 | 从实际接口到客观断言 | 结果与限定 |
| --- | --- | --- |
| Q15 同 ID 首稿 | 真实创建项目/input/run，queue 两次 promote 相同 DOCX 得到同 ID/hash，checkpoint `baseline_kind=none` 后 finish 登记 generated/current；GET run/versions/artifact 进入编译后 guard；result/current 分别准备与提交前重读，再 POST input-revisions | 两选择均准确持久化 `authoring.previous_output` 和来源格式 template；实际授权下载 hash 等于合成 DOCX；锁输入不新增 run。只是当前实现的无模型协议，不证明 #871 合入后仍通过 |
| Q17 错 hash/version 请求 | 用真实 metadata 的准确 pin 作为基准，只修改请求中的 SHA 或不存在的 artifact version，POST input-revisions | 均 HTTP 409 `INPUT_REVISION_CONFLICT`，各次新增 input/run 均为 0；这是请求负例，没有手改不可变数据库记录，也不是“同一个成果 hash 被正常更新”的伪场景 |
| Q17 正常当前稿变化 | 完成第二个真实 API/queue 合成生成任务，正常注册新的 current version/hash/selection；GET 后 guard key 变化，仍能准确读取旧 run 的 result | 新 current 精确 pin 新成果，result 精确 pin 旧成果；旧 selection 的 input POST 为 409，新增 input/run 均为 0。计数基线取在第二个合法任务完成之后 |
| Q17 存储故障 | 仅在合成内存 Blob 删除字节或放入同大小损坏字节，真实 GET artifact 先做字节校验，再由 result/current guard 重读 | API 503，两个选择均拒绝，新增 input/run 为 0；随后恢复原字节。明确是存储故障注入，不是数据库 availability 直接篡改或新质量门禁失败；只证明 guard 路径拒绝，没有宣称绕过 guard 的直接 input 请求也会重新读 Blob |
| Q18 旧状态边界 | 读取同 ID 旧成果 API 与数据库证据，续改读取后再次对比 | 仍是 `generated_pair_v1`、`content_review=not_performed`；证据 ID 和 passed/available 未被读取行为改写，未出现 `word-quality-v1`。不追认正文/业务质量，不证明尚未合入 #871 的迁移行为 |
| Q17 公开撤销路径 | 通过真实 DELETE project 使已有 artifacts 进入 revoked，再读取 metadata、result/current 并提交旧 pin | metadata/读取/旧 input 均被 404 拒绝，新增 input/run 为 0；限定为项目删除后的真实撤销，不冒充独立 artifact 撤销 API 或 #871 failed gate |

这里的“0”仅指新增 `bb_input_revisions` 和 `bb_runs`；artifact 元数据 GET 会按现有行为创建短期下载授权及审计记录，不能称为“数据库总写入为 0”。两次调用 guard 的 probe 不替代真实浏览器事件绑定验收，也没有重新运行本批既有前端 fixture。

可复现 probe 原文保存在 [continuation-api-pg-probe.mjs.txt](continuation-api-pg-probe.mjs.txt)，其 SHA 与结果 JSON 内 `.local/quality-continuation-probe.mjs` 完全对应；不因后续安全说明静默修改已运行的脚本或标签。复跑时将原文放回同工作区忽略目录 `.local/quality-continuation-probe.mjs`，准备仅本机的完整迁移模板，通过 `BB_TEST_DATABASE_URL` 指向该专用模板。**原 probe 调用克隆 helper 后才断言连接地址，所以复跑必须先执行以下只读预检，成功后才能运行 probe**；先校验 host/port/template，连接该已限定 loopback 的实例读取并确认目录，在任何 `isolatedTestDatabase` 调用前完成。禁止指向生产连接。

```powershell
@'
import assert from 'node:assert/strict';
import {Client} from 'pg';
const url=new URL(process.env.BB_TEST_DATABASE_URL);
assert.equal(url.hostname,'127.0.0.1');
assert.equal(url.port,'55434');
assert.equal(decodeURIComponent(url.pathname),'/bb_prelaunch_payment_template');
const client=new Client({connectionString:url.toString()});
await client.connect();
try {
  const row=(await client.query("SELECT current_setting('data_directory') AS directory,current_setting('port') AS port")).rows[0];
  assert.equal(row.directory.replaceAll('\\','/'),'C:/Users/lezhai/Downloads/Bondbuddy/prelaunch-desktop-20261104/.local/prelaunch-payment-pg');
  assert.equal(row.port,'55434');
} finally { await client.end(); }
'@ | node --input-type=module
if($LASTEXITCODE -ne 0){throw 'Dedicated PostgreSQL preflight failed; do not clone or run probe'}
node --test --test-concurrency=1 .local/quality-continuation-probe.mjs
```

helper 在独立测试结束时清理克隆。预检不安装环境或修改数据库；当前复跑仍需精确代码与编译产物 hash 相符，不能仅凭未来日志名认定同一 subject 通过。

第二轮结束时剩余测试克隆 0、其他客户端连接 0；核对专用目录和端口后 `pg_ctl -m smart -w stop` exit 0，最终 status exit 3、`127.0.0.1:55434` 为 `ECONNREFUSED`。普通沙箱首停无信号权限，经批准提升后仅停止此实例，两次记录均在 [continuation-postgres-cleanup.json](continuation-postgres-cleanup.json)。普通沙箱首次启动也因受限令牌 error 87/3 被拒，批准恢复后才执行测试，没有重新 initdb 或连接其他数据库。

## 第三轮：跨入口交付、失败恢复与扣费

覆盖复查发现现有五项 CI 没有执行 18 个影响文件/计费链的 PG 文件。已补跑 API9、worker7、M4 case templates 和年度事实 PG 各 1 文件，涵盖多文件生成与检查、底稿共享计划/付费复核、问答回填、诚信核查、动态复核、模板双 Word 及存量材料恢复。年度事实测试用既有授权原稿，本机 parser→16 个候选/anchor→PG ledger/outbox 和检查点/归属负例；它在非 unified 的存量/恢复路径仍可达，新的统一编制直接原稿路径绕过该步骤，不能将它算作新生成或模型质量证明。原有 M4 CI 已覆盖的批量底稿和 pipeline 不重复补跑；计数包含导入的既有 unit 与嵌套子项，不相加声称新的场景总数。

原始失败来自旧测试夹具：合法 HTTP 金额仍用 number、响应断言仍期待 number、复核手动 queue 测试没有显式启用 synthetic queue，以及 QA 缺隔离输出目录。适配现有测试和环境，保持原金额、扣费、暂停/恢复、已完成文件、模型调用次数及归属断言。QA 另补可读主稿＋无文字补充附件：精确 pin、具名缺口/有效引用、实际 Word 说明、已完成答案/hash 复用、每题一次 journal intent、一次 120 积分结算及完成请求重放无新增 run/账务事件均通过；首轮新增查询错用不存在的列，修正为按 job 关联 run 后复验通过，原失败保留。它不代表损坏文件或缺 Blob 可容错，也不新增该 suite 原无的独立 402 场景。诚信复验中曾误把故意 number 的 422 负例转成字符串；恢复原负例后通过，中间失败也保留。`enableSyntheticQueue:true` 只服务本地手动 claim/finish；没有单独试跑 `enableRunRuntime:true`，不据此判断生产模型是否就绪。

真实组件为 Fastify `app.inject`、独立 PostgreSQL、Azurite、持久队列/journal、Python parser/Word 与 Chromium。认证主体、模型结果和 Chromium 网站响应为合成；输入材料含合成材料和上述本机解析的既有授权原稿，不向供应商传送。不经过公网/Nginx/正式商户，未访问真实核查网站。实际命令、各轮原始日志、源码/产物 hash、失败原因与专属服务清理见 [cross-entry](cross-entry/README.md)。生产临时会话的只读状态核对另记在总证据，不混入此组测试。

M4 workflow 追加这 18 文件及必要 Chromium/隔离输出目录、授权本机 parser opt-in，原有步骤、25 分钟限制和权限保留；新步骤要求 tests>0、fail/skip/todo 均为 0。配置检查不是执行结果，最终提交的 Linux CI 以 PR 的准确 head/run 读回为准。

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
