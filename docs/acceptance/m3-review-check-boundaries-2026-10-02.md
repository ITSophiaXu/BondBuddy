# M3 #48 / #49：证据、表格上下文与格式检查边界

日期：2026-10-02。这里记录工程验证及明确剩余范围，不代表真实供应商调用或行业签认。本文不包含客户原文、财务值或生成成果。

## 本轮已补齐

- 金额硬结论不能只依赖模型自报的主体、指标、期间、币种、单位、口径和原始/重述基础。缺少可信结构化来源或受限的完整单句逐字证明时，保持人工待核；模型选择的计算关系仍不等于已验证公式。
- 格式检查读取执行前已保存的显式要求，如 `正文中文字体为宋体`、`表格字号为12磅`，按输入版本及文本哈希保留用户标准来源。条件、冲突、含糊标准不猜测，不冒充监管规定。
- 表格上下文按 owner/project、材料版本及 SHA、解析快照及响应 SHA、工作表或最内层 DOCX 表路径隔离。补充同表前12个非空行、完整目标行和最多12条同表前文，修复数值跨批后期间/单位/行标签消失的问题。
- 原记录 ID、定位、合并单元格锚点、公式原文及不确定性均保留。隐藏/未知可见性的工作表不会取得确定性财务事实资格；不借用其他工作表的表头。
- 上下文默认上限64,000字节、240条。候选未能全部装入时，提示中给出遗漏数，报告记录具体批次目标的 `uncovered`，不静默截断或补猜。
- 同快照的 Word 表前正文可以保留原文引用，但表外语义关联仍为 `unverified`；跨表、跨工作表、跨解析快照的表格语义引用被拒绝。上下文记录不能变成本批新增抽取来源，也不能扩大差异复核已选目标。
- 模型调用标识绑定完整提示内容，避免更新上下文后重用原来缺表头的提示快照/响应。

实现入口：

- `apps/worker/src/review-record-context.ts`
- `apps/worker/src/review-model-stage.ts`
- `packages/domain/src/review-financial-context.ts`
- `apps/worker/src/review-formatting-context.ts`
- `apps/worker/src/review-rule-context.ts`

## 可重复验证

Windows PowerShell，Python需安装 python-docx、lxml、openpyxl：

```powershell
npm.cmd run build -w @bondbuddy/worker
$env:BONDBUDDY_TEST_PYTHON='C:\Users\lezhai\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe'
node --test packages/domain/dist/review-*.test.js apps/worker/dist/review-*.test.js
git diff --check
```

结果：worker build通过，83项测试通过，0失败、0跳过；diff检查通过。domain/contracts/API依赖沿用本分支前序构建产物。

新增回归在 `review-record-context.test.ts` 中用临时合成 XLSX/DOCX 调用真实原生 parser，不调用模型供应商：

1. 三工作表 XLSX：前置隐藏旧期辅助表、合并表、母公司表；D24/D25跨批后仍可引用本表A1/B3/E3/D4及完整目标行；不混入其他表或旧解析记录。
2. 真实合并单元格不虚构被合并单元格，缓存公式保持 `formula_cached_result_unverified`，引用恢复精确证据 pins。
3. 多表、多批次 DOCX，包括不同父单元格下均编号为table:1的嵌套表；同快照表前说明保持未验证，而非整批失败。
4. 容量不足在提示和最终覆盖记录中一致呈现；差异复核不能通过上下文扩大所选目标；隐藏表完整单句仍不能升为确定性事实。

格式回归另外通过合成真实 DOCX 验证样式继承、直接字号覆盖、表格字体差异经 production loader 到 checker 的链路。

## 剩余范围及可复用资产

| 范围 | 当前边界 | 可继续复用的资产/具体工作 |
| --- | --- | --- |
| 表头语义与财务映射 | parser没有语义表头声明；前12个非空行只是结构候选，表外、更深层、多区块表头不能自动证明适用。多数真实散列单元格仍为人工待核。 | `native-financial-fact-extractor.ts`已有受限同表标签/期间/单位/口径映射，可另建严格保留来源状态的review适配器。不能将candidate或mapping confidence当已审计事实。 |
| 跨批/跨表公式 | 本轮没有构建可信的跨批公式图；模型计算只引用同一响应中的observations。模型选择的关系仍为unverified。 | 建立独立的受限公式/指标关系生产者；现有`rq-q3-formula-candidate-extractor.ts`的缓存公式候选不可直接升级。外部工作簿引用缺失时继续待核。 |
| 真实财务验收 | 已登记的15份真实样本覆盖四个上交所私募案例，不能据此代表深交所、大/小公募或协会各品种。目标期间确认不等于财务事实/成果签认。 | 复用`tests/samples/2026-09-25/manifest.json`、`TARGET-CONFIRMATIONS.md`、issue-15财务review工作表。既有大XLSX授权测试固定parser 1.0.6，迁移至当前1.0.7后再复跑，不声称它在本轮未经修改已通过。 |
| 生产规则适用性 | `PUBLISHED_RULE_APPLICABILITY_TAXONOMY_VERSIONS`当前为空。固定发布账本的引文可作为unknown适用性的参考，不能伪造为已审批生产规则。 | 完成真实适用性审核/发布pins；已有SSE私募受限checker及研究规范可用于离线验收，不绕过production gate。 |
| DFI/市场边界 | 精确路由及不跨市场兜底已测；尚无完整、可信的DFI注册与本期发行条款检查生产者，模型片段判断不能证明全文缺失。 | 先对固定来源的注册/发行阶段、工具适用性及未确定本期条款建立确定性输入和正反案例，再接入已有NAFMII研究资产。 |
| 格式 | 已接显式用户字体/字号；现有ChapterTemplate无可执行字体/字号标准。页眉页脚、目录域、标题层级、主题字体和视觉分页仍未覆盖；格式问题`can_revise=false`。 | 复用parser已提供的辅助部件定位，另设有来源的检查标准及OOXML修订能力；当前文本修订器不能承诺改字体/字号。 |

本轮修复不解除上述未覆盖项，不提供“全文财务/合规通过”结论，也未启用未批准规则。
