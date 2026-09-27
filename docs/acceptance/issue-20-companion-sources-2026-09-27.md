# #20 配套来源与例外交接工程记录

日期2026-09-27；分支`feat/m1-20-companion-sources-20260927`；基线develop `2b64679`。这是离线知识资产及文献分析，不修改API/DTO、数据库、worker、运行字典或正式规则包。全部专业批准字段为空，draft.6/checker v4及其2026-09-26基准不变。

## 交付与复核

- [来源清单](../../knowledge/exchange-bonds/verification/2026-09-27-companion/README.md)：适当性DOCX与官方公告、公司法政府转载HTML、JR/T0020—2024官方PDF。固定原字节、URL/时间/hash，保留全文30/266条及48页定位。
- [576码对照](../../knowledge/exchange-bonds/verification/2026-09-27-companion/industry-comparison.json)：代码/层级/父级相同，1处名称和11处说明不同，不宣布两标准法律等效。提取器读取双方固定原件，不信任手改的生成码表。
- PDF人工目视核对封面、前言/引言（物理4/5页）、分类范围（物理7页），以及12处文本差异所在表行。目视核对用于验证提取，非业务专家签认。
- [条款/24项验收预期](../../knowledge/exchange-bonds/drafts/sse-private/COMPANION-APPLICABILITY-20260927.md)给出边界及现有professionalOnly/manual handler差距。没有把预期场景登记为已执行并通过。
- AGENTS及产品说明书15/17已同步；[关闭清单](../../knowledge/exchange-bonds/drafts/sse-private/CLOSURE-CHECKLIST.md)更新已合并#315/#316/#317、#19桥接启动及#35预发暂停状态。

## 实际验证

环境：Windows，Python随本机Codex运行时；pypdf 6.10.0、pdfplumber 0.11.9，视觉检查用pypdfium2 5.13.0。未要求修改生产Python依赖；本脚本仅作离线资产构建。

| 检查 | 实际结果 | 能证明什么 |
| --- | --- | --- |
| `python -m unittest discover -s scripts -p test_sse_companion_evidence.py -v` | 10通过，0失败/跳过 | 4份原件及manifest一致；30/266条连续、原文锚点及关键例外保留；576码逐格可追溯；12处差异不被吞掉；篡改/缺条拒绝、脚本不成为条文；8份生成文件离线重建字节一致 |
| `python -m unittest discover -s scripts -p test_capco_industry_evidence.py -v` | 7通过，0失败/跳过 | 既有CAPCO固定原件、合并单元格、前导零、候选映射及历史取证可重复，未因新比对破坏 |
| 变更文档的本地链接/锚点及`git diff --check` | 117处有效，无空白错误 | 交接索引可达；不替代规则或成果验收 |
| Git暂存字节与本地固定文件 | 4份原件及8份生成视图逐字节一致 | 原件不受换行转换影响，生成视图固定LF保证跨平台重建 |

本PR没有运行时改动，不重复宣称全M1/真实模型/PG链路全绿。既有#315独立domain168项、#317作者和负责人domain188项的结果在各PR保存，不混记为本PR的执行。

## 尚未完成

- [来源缺口](../../knowledge/exchange-bonds/verification/2026-09-27-companion/unresolved-sources.json)：协会两页正常访问返回567，重组官方页超时；没有绕过站点限制，也不使用搜索摘要作为正式正文。公司法仅有政府转载，未完成人大母本/配套过渡核验；穿透、税务、专项等未因此补完。
- 正式来源/项目审核、规则发布、条内专业覆盖、可信事实接入仍须独立完成。现有25组检查/6组人工处理全部research_only。
- #35报告预发`64826c6`在整体审核处暂停、成果0；2025-09-30的法规日期不能直接复用2026基准包。尚未取得本轮真实模型成果、目标环境下载和行业验收，也未做Word/WPS实际打开检查。

因此#20继续OPEN；本次完成的是配套证据和可复核的接入交接，不能勾选“31条全部正式批准/真实成果验收通过”。

## 用户后续验收边界调整（2026-09-27）

Word/WPS桌面兼容不再阻断#20，移交#146独立跟踪，有实际问题再提缺陷。关闭清单改为G1–G4；保留规则/真实内容验收，但不将全库配套补证、生成后的验收或完整客户端矩阵作为首次内部工作稿生成的统一前置。对`2b64679`实际代码核对：整体审核缺失直接返回needs_review，随后有未发布字典判断，production registry另要求生产release与无uncovered coverage；这些是工程接入层次，不能概括成“少几份法规所以不能更新”。没有在本次文档修改中绕过或实现新的线上执行入口；#19/#35按明确边界推进接入。

本次边界调整只改8份Markdown，新增/修改的7处本地链接全部有效，`git diff --check`通过；提取器/原件/运行代码无改动，不重复运行前述17项来源测试，也不宣称线上任务已恢复。
