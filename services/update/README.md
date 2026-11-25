# 募集书更新独立服务（update service）

新版「募集书更新」的独立实现。设计见 [`docs/update-service/plan.md`](../../docs/update-service/plan.md)。

**核心原则：** 固定流水线代替自由智能体。文件解析、取数、填数、校验、生成 Word 全部由程序完成；
模型只在少数明确的判断点上做小调用（通过 agent-runner 调用 DeepSeek Harness，后续 PR 接入）。

## 当前进度（PR-1：确定性流水线首个切片）

| 阶段 | 内容 | 状态 |
|---|---|---|
| S2 | 历史募集书 DOCX 结构解析，定位与现有 `bondbuddy_word_delivery.writer` 完全一致 | ✅ |
| S3 | 财务报表 XLSX 识别：报表类型、编制单位、报表日期（含 Excel 日期序列号）、金额单位、左右两栏；忽略无关/过期工作表并记录原因 | ✅ |
| S3 | 勾稽与派生：`#REF!` 等缺失合计项按会计恒等式推算并标注；不一致项列入核对清单 | ✅（首批 3 条恒等式） |
| S5 | 报告期规划：一期更新 / 年度滚动 / 跨多年补更三种模式 | ✅ |
| S6 | 报表类表格：行名对应（精确 + 宽松）、旧数复核、新一期填数、占比列分母反推与重算、表头期间替换、两行表头 | ✅ |
| S7 | 不含金额的正文（表题、引导句）报告期替换；含金额段落列为叙述单元待办 | ✅ |
| S9 | 调用现有 writer 生成修订版、清洁版和有效基线 Word；接受全部修订 = 清洁版、拒绝全部修订 = 基线，由 writer 自检 | ✅ |
| 评测 | 与人工最终稿逐格对比（correct / wrong / missed） | ✅ |
| S3 | DOCX 附注、PDF（文字版/扫描件 OCR） | ⏳ 下一个 PR |
| S6 | 财务指标公式库、附注明细表、模型映射单元 | ⏳ |
| S8 | 叙述章节改写（DeepSeek Harness 单元） | ⏳ |
| — | Web/API、登录、部署 | ⏳ |

## 真实样本结果（任丘建投，2025 年 9 月末一期更新）

只用财务报表 XLSX、不调用任何模型：

- 13 张报表类表格自动更新，与人工最终稿逐格对比 **242 格一致、0 格错误**；
- 2 张表旧数复核不通过（母公司资产负债表的第三列口径、有息负债表），**自动拒绝修改**并列入待办，没有写入错误数据；
- 全流程 21 秒（解析 5 秒，生成 Word 15 秒），生成的修订版可被 LibreOffice 正常打开，含 292 处原生修订。

未覆盖的部分（附注明细表、财务指标、业务数据、叙述段落）列在 `report.json` 中，由后续 PR 处理。

## 运行

```bash
# 仓库根目录
PYTHONPATH=python:services/update python3 -m bondbuddy_update run \
  --prospectus 历史募集书.docx --financial 财务报表.xlsx \
  --issuer 发行人全称 --out /tmp/update-out [--golden 人工最终稿.docx]
```

输出：`修订版.docx`、`清洁版.docx`、`有效基线.docx`、`baseline-prepared.docx`、`report.json`
（以及提供 `--golden` 时的 `golden-eval.json`）。

## 测试

```bash
PYTHONPATH=python:services/update python3 -m unittest discover -s services/update/tests -v
# 真实样本回归（样本不入库）
BB_UPDATE_SAMPLE_DIR=/path/to/samples PYTHONPATH=python:services/update python3 -m unittest services/update/tests/test_core.py -k Sample
```

依赖与 `python/requirements.txt` 相同（python-docx、openpyxl、lxml）。

## 与现有代码的关系

- 复用 `python/bondbuddy_word_delivery/writer.py` 生成修订版和清洁版，不修改它。
- 为让更多段落可被 writer 安全修改，`docx_model.prepare_source` 生成「可编辑基线」：去掉不影响显示的
  `lastRenderedPageBreak`/`proofErr`，把段落内的书签挪到段落前后（OOXML 允许书签作为 body/tc 的子节点）。
- 发现 writer 的一个口径问题：`visible()` 会把 `w:pPr/w:tabs` 里的制表位定义也计成 `\t`，而
  `apply_replacements` 只按 run 计算偏移，导致带制表位的段落编辑失败。本服务在生成计划时跳过这段前缀（`Block.prefix`）；
  建议另开 issue 修正 writer 本身。
