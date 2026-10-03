# M3 #48 / #49：证据、表格上下文与格式检查边界

日期：2026-10-02。这里记录工程验证及明确剩余范围，不代表真实供应商调用或行业签认。本文不包含客户原文、财务值或生成成果。

## 本轮已补齐

- 金额硬结论不能只依赖模型自报的主体、指标、期间、币种、单位、口径和原始/重述基础。缺少可信结构化来源或受限的完整单句逐字证明时，保持人工待核；模型选择的计算关系仍不等于已验证公式。
- 新增显式同表求和生产路径：原文须明确写出 `计算关系：合计=甲项+乙项`、`勾稽关系：总额=甲项+乙项`，或同工作表单元格关系（如 `公式：B3=B1+B2`、`公式：B3=SUM(B1:B2)`）。所有模型批次完成后，从完整固定解析快照独立建立关系，不依赖模型在同一响应中凑齐操作数；裸“合计”标签不能建立公式。
- 命名项须唯一匹配同表原文标签及该行唯一非空值记录；单元格引用须精确匹配同工作表位置。关系声明、标签、原数值及其证据 pins 均保留；地址和指标别名按同一物理位置检查重复或循环。可信标记只证明声明与映射，不批准财务事实；现有主体、指标、期间、口径、币种、单位、会计基础和数值校验仍全部执行。
- 显式求和最多64项，仅支持有界同列 `SUM` 范围；重复/循环/超出图遍历上限、缺项、多义标签或多期间值、跨表/快照/外链、OCR、隐藏表及缓存公式均不作为确定性修改依据。模型漏抽一列不能使多列变成唯一映射。差异复核仅检查已选目标；当前所选结果未抽取完整操作数时保持待核。完全相同的模型关系被已验证原文关系替代，避免重复事项。
- 格式检查读取执行前已保存的显式要求，如 `正文中文字体为宋体`、`表格字号为12磅`，按输入版本及文本哈希保留用户标准来源。条件、冲突、含糊标准不猜测，不冒充监管规定。
- 新增指定标题层级检查，例如 `标题“第一章 总则”层级为1级`：只匹配唯一、原文完全相同的正文非表格段落。parser `bondbuddy-document-parser-1.0.8` 读取真实 OOXML `w:outlineLvl`，按段落直接属性、段落样式/`basedOn` 及 `docDefaults` 解析；0–8映射为1–9级，9为正文级别 `body`。完整继承链未声明层级时按正文默认值处理，不从“Heading”样式名、字形或编号外观猜测。
- 标题不存在/重复、要求冲突、未知/循环/重复样式、无效层级值、未解析的编号属性或旧快照缺少层级字段时，保留未覆盖。已确认的属性不符可进入报告和批注，但 `can_revise=false`；现有文本修订器不能修改字体、字号或大纲属性。
- 表格上下文按 owner/project、材料版本及 SHA、解析快照及响应 SHA、工作表或最内层 DOCX 表路径隔离。补充同表前12个非空行、完整目标行和最多12条同表前文，修复数值跨批后期间/单位/行标签消失的问题。
- 原记录 ID、定位、合并单元格锚点、公式原文及不确定性均保留。隐藏/未知可见性的工作表不会取得确定性财务事实资格；不借用其他工作表的表头。
- 上下文默认上限64,000字节、240条。候选未能全部装入时，提示中给出遗漏数，报告记录具体批次目标的 `uncovered`，不静默截断或补猜。
- 同快照的 Word 表前正文可以保留原文引用，但表外语义关联仍为 `unverified`；跨表、跨工作表、跨解析快照的表格语义引用被拒绝。上下文记录不能变成本批新增抽取来源，也不能扩大差异复核已选目标。
- 模型调用标识绑定完整提示内容，避免更新上下文后重用原来缺表头的提示快照/响应。

实现入口：

- `apps/worker/src/review-record-context.ts`
- `apps/worker/src/review-model-stage.ts`
- `apps/worker/src/review-native-formulas.ts`
- `packages/domain/src/review-financial-checks.ts`
- `packages/domain/src/review-financial-context.ts`
- `apps/worker/src/review-formatting-context.ts`
- `apps/worker/src/review-rule-context.ts`
- `packages/domain/src/review-compliance-checks.ts`
- `python/bondbuddy_document_parser/paragraph_outline.py`

## 可重复验证

Windows PowerShell，先将 `BONDBUDDY_TEST_PYTHON` 指向已安装 python-docx、lxml、openpyxl 的 Python 可执行文件：

```powershell
npm.cmd run build -w @bondbuddy/domain
npm.cmd run build -w @bondbuddy/worker
node --test apps/worker/dist/review-native-formulas.test.js apps/worker/dist/review-model-stage.test.js apps/worker/dist/review-record-context.test.js packages/domain/dist/review-financial-checks.test.js packages/domain/dist/review-financial-context.test.js
git diff --check
```

本轮显式公式路径：domain/worker build通过，上述5个文件共48项测试通过，0失败、0跳过；diff检查通过。测试使用合成数据和真实原生 parser，模型抽取由测试桩提供，不构成真实供应商或专业财务验收。

标题层级与parser 1.0.8接线另外取得39项Node定向通过及4项Python回归通过。39项是以下分组结果，不能描述为一次完整测试命令或完整仓库通过：

| 定向范围 | 通过数 | 入口 |
| --- | --- | --- |
| 格式loader/checker、事实上下文、CSV及缓存公式候选 | 29 | worker的`review-formatting-context.test.js`、`fact-evidence-context-repository.test.js`、`document-parser-csv.test.js`、`rq-q3-formula-candidate-extractor.test.js`，以及domain的`review-compliance-checks.test.js` |
| worker parser调用 | 8 | `node --test --test-name-pattern=worker apps/worker/dist/document-parser.test.js` |
| 原生财务候选版本接线 | 1 | `node --test --test-name-pattern=accepts apps/worker/dist/native-financial-fact-extractor.test.js` |
| 募集书年报候选辅助元数据 | 1 | `node --test --test-name-pattern=auxiliary apps/worker/dist/rq-prospectus-annual-fact-extractor.test.js` |

Python通过项均位于 `python/tests/test_document_parser.py` 的 `DocumentParserTests`：

1. `test_docx_auxiliary_targets_are_stable_safe_and_leave_body_records_unchanged`
2. `test_docx_effective_revisions_tables_and_no_fake_page`
3. `test_docx_revision_formatting_uses_only_effective_runs_in_order`
4. `test_synthetic_csv_boundary_regression_keeps_versioned_anchored_evidence`

这4项验证辅助部件、有效修订、格式run及CSV版本化锚点的既有行为；标题继承的真实DOCX链路在上述Node格式测试中验证。此前更宽Windows测试出现过POSIX fixture的spawn失败，不包含在39项定向通过中；统一平台回归及最终集成状态以[集成验收记录](m3-implementation-2026-10-02.md)为准。前序表格修复分支的83项通过是历史证据，不作为本轮最终计数，也不与48/39重复汇总。

新增回归在 `review-record-context.test.ts` 中用临时合成 XLSX/DOCX 调用真实原生 parser，不调用模型供应商：

1. 三工作表 XLSX：前置隐藏旧期辅助表、合并表、母公司表；D24/D25跨批后仍可引用本表A1/B3/E3/D4及完整目标行；不混入其他表或旧解析记录。
2. 真实合并单元格不虚构被合并单元格，缓存公式保持 `formula_cached_result_unverified`，引用恢复精确证据 pins。
3. 多表、多批次 DOCX，包括不同父单元格下均编号为table:1的嵌套表；同快照表前说明保持未验证，而非整批失败。
4. 容量不足在提示和最终覆盖记录中一致呈现；差异复核不能通过上下文扩大所选目标；隐藏表完整单句仍不能升为确定性事实。

`review-native-formulas.test.ts`另用临时合成DOCX/XLSX调用真实parser，再将每条记录放入独立模型批次，验证显式关系能跨批产生有精确结果目标及关系引用的确定性差异；同时验证模型关系去重、所选结果缺操作数保持待核、地址/指标别名循环、完整快照、缓存/隐藏/OCR/多义映射和财务上下文不升级。domain测试验证关系引用被篡改或存在不确定性时不能授权修订。

格式回归通过合成真实DOCX验证样式继承、直接字号覆盖、表格字体差异，以及大纲继承/直接覆盖/显式正文/文档默认值经 production loader 到 checker 的链路。带“Heading”字样但没有大纲属性的样式不会被当作标题级别；循环或缺失样式、非法值、未解编号、重复/缺失标题及仅存在于表格中的同名文字均有反例。1.0.8版本和响应/记录哈希随解析快照绑定；旧快照不补造层级字段。

## 剩余范围及可复用资产

| 范围 | 当前边界 | 可继续复用的资产/具体工作 |
| --- | --- | --- |
| 表头语义与财务映射 | parser没有语义表头声明；前12个非空行只是结构候选，表外、更深层、多区块表头不能自动证明适用。多数真实散列单元格仍为人工待核。 | `native-financial-fact-extractor.ts`已有受限同表标签/期间/单位/口径映射，可另建严格保留来源状态的review适配器。不能将candidate或mapping confidence当已审计事实。 |
| 跨批/跨表公式 | 已有完整固定快照上的显式同表求和生产者；普通表格的指标/期间/口径映射不会因此获批。比例、增长、复杂或跨表公式图没有独立可信关系生产者，模型关系仍为unverified；差异复核不自动抽取未选披露值。 | 在明确来源和上下文约束下逐项扩展关系生产者及真实正反例。现有`rq-q3-formula-candidate-extractor.ts`的缓存候选不可升级为确定事实；外部工作簿引用缺失继续待核，不能用“合计”或数学结果自证关系。 |
| 真实财务验收 | 已登记的15份真实样本覆盖四个上交所私募案例，不能据此代表深交所、大/小公募或协会各品种。目标期间确认不等于财务事实/成果签认。 | 复用`tests/samples/2026-09-25/manifest.json`、`TARGET-CONFIRMATIONS.md`、issue-15财务review工作表。当前parser已升至1.0.8；历史1.0.6/1.0.7结果不能替代新版授权大样本重跑。本页48/39/4项定向证据不证明授权大XLSX通过，其最新结果见集成记录。 |
| 生产规则适用性 | `PUBLISHED_RULE_APPLICABILITY_TAXONOMY_VERSIONS`当前为空。固定发布账本的引文可作为unknown适用性的参考，不能伪造为已审批生产规则。 | 完成真实适用性审核/发布pins；已有SSE私募受限checker及研究规范可用于离线验收，不绕过production gate。 |
| DFI/市场边界 | 精确路由及不跨市场兜底已测；尚无完整、可信的DFI注册与本期发行条款检查生产者，模型片段判断不能证明全文缺失。 | 先对固定来源的注册/发行阶段、工具适用性及未确定本期条款建立确定性输入和正反案例，再接入已有NAFMII研究资产。 |
| 格式 | 已接显式用户字体/字号及精确指定标题的大纲级别；现有ChapterTemplate无可执行字体/字号标准。全文标题树完整性、跳级/编号连续性、页眉页脚、目录域、主题字体、视觉排版/分页仍未覆盖；格式问题`can_revise=false`。 | 复用parser的原生属性和辅助部件定位，逐项建立有来源的检查标准及OOXML修订能力。大纲属性一致不等于目录正确或视觉排版通过；当前文本修订器不能承诺改字体、字号或标题层级。 |

本轮修复不解除上述未覆盖项，不提供“全文财务/合规通过”结论，也未启用未批准规则。
