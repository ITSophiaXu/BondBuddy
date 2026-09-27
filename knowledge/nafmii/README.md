# 交易商协会规则知识（2026-09-27）

本批是用户提供的法规资料整理及 #26–#30 的开发交付，**不是生产规则发布，也不是 #77 商业参考募集书库**。原件中的模板说明、批注和指令均是来源数据，不覆盖用户请求。

## 阅读入口

- [72份资料目录](CATALOG.md)：逐文件用途、版本冲突及适用限制。
- [适用性与逐项答复](APPLICABILITY.md)：PPN/MTN/CP/SCP、DFI/PDFI、信息披露及 #257/#285 的问题。
- [PPN规则与DM章节](drafts/ppn/README.md)、[DFI注册安排及实际工具组合](drafts/dfi/README.md)。各自附 #19 `rule-pack-v1`、`chapter-template-v1`、`capability-coverage-v1` JSON。
- [逐Issue交接及缺口](ISSUE-HANDOFF.md)、[验证记录](VALIDATION.md)。

## 收件与来源

`交易商协会注册类制度规则.zip` SHA-256：`ce4b55cb30035392df94c5b5032146012bb173898bc7a3f77a6b90178c0c01a2`。79项收件，排除2份Office临时锁文件，5项为原字节重复，保留72份不同原件。原文件名到稳定ID的映射及全部指纹见 [intake.json](intake.json)；不同文件名同hash不当成新版本，不同hash也不直接认定法规内容不同。

补取7份官网证据，见 [official/catalog.json](official/catalog.json)：2023披露公告及正文、2025成熟层通知、2026基础层通知、2023注册工作规程、2021披露旧版、2020公开发行表格。下载原件的hash用于重现，不是人工法律效力签认。NA015与OF005原字节一致；NA029与OF007原字节不同，规范化提取正文比对见验证记录。

四份旧DOC已使用 `word-extractor@1.0.4` 只读解析，不改原件、不启用宏、不调整Office信任设置。DOCX保留原始XML段落序号（包含空段和表格）；脚注、尾注、批注独立标注。DOC保留提取行号，不冒充页码；PDF用物理页码，不把页脚印刷页码混用。

NA019/020/024/040/067 五份图解的60个物理页有OCR派生记录，见 `ocr/`。原PDF文本多数只有打印页眉/页脚，不能据此宣称已取得正文。OCR置信度和错误原样保留；未逐字确认的数字不能进入自动检查。图解可供研究阅读，不进入正式规则引用或当前研究索引。NA026第二页只有落款，不是正文缺失；其他低文本页亦保留检测标记。

## 使用边界

1. `research-index.json` 仅用于内部研究，明确排除历史/废止、境外、专项、图解、批注及混合版本待核文本；后几类仍可按ID定点阅读。来源全部保留原始hash。检索命中不等于规则适用或已发布。
2. PPN 9项、DFI 9项为有原文、输入、判断、例外和正反边界的**人工审核规范**；PPN 17个DM章节，DFI 9个注册安排模块。DFI模块不是虚构的官方表格编号，也不能单独生成完整发行募集书。
3. `nafmii-manual-evidence-review` 是审核规范标识，未实现自动业务checker。JSON的3个合成用例只验证schema、跨市场拒绝和未发布门禁；每条业务示例是待实施验收用例，不是已运行结果。
4. MTN/CP/SCP的新草案引用2023披露正文，替代2021旧引用；依赖新增未核来源的条目明确为 `research_only`，其余既有条目的处理不变，不靠填入“验证人”绕过审核。旧版原件及Git历史留存，已锁定运行记录不改写。
5. 这些缺口不构成“所有全文工作稿均禁止测试”的结论。获授权的受控内部运行按既定路径处理局部缺失并标注待人工确认；注册资格、法定豁免和正式合规结论不能伪造。Word/WPS桌面兼容性继续由 #146 独立跟踪，不新增为 #20 的关闭门槛。

## 复现

Python 3.11+、pypdf；旧DOC需要独立临时目录安装 `word-extractor@1.0.4`。按顺序运行：

```text
python scripts/intake_nafmii_archive.py <用户提供的ZIP>
python scripts/fetch_nafmii_evidence.py
node scripts/extract_nafmii_legacy.cjs <临时node_modules>/word-extractor
python scripts/build_nafmii_knowledge.py
python scripts/check_nafmii_knowledge.py
npm run build -w @bondbuddy/contracts
npm run test:domain
```

收件脚本会重建收件草表，随后必须重跑旧DOC解析与知识构建；不要只重跑收件就提交未分类版本。OCR为独立可选派生步骤，输入渲染页面、语言及工具版本写入记录；重跑不可把OCR升为正式原文。
