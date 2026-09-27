# #20 全部31条文献核对及剩余20条处理验收

日期：2026-09-27。分支`feat/m1-20-full-rule-review-20260927`，从`c2eb3b3`开始，提交前快进同步至`develop@64826c6`。范围为#20工程及文献处理，不是发布或真实客户验收。

## 完成交付

- [31条核对报告](../../knowledge/exchange-bonds/drafts/sse-private/RULE-REVIEW-20260927.md)：逐条列原文、发布/生效/替代/过渡观察、适用性、例外、内部方法与正式要求区别、处理/输入、正反例及未覆盖项。结构化记录含原件/公告SHA-256。核对者为Codex文献分析，不冒充Maxy签认或正式来源批准。
- `2026.09.27-draft.6` / checker v4：原11组检查延续；剩余20条补14组受限检查、6组人工审核处理。全31条已有处理，六条无自动专业判定仍列uncovered；25条局部检查也有未覆盖边界，正式coverage31条仍uncovered。
- 内部`AdditionalCheckInput`/`ManualCheckInput`、[实际被测试读取的合成示例](../../packages/domain/examples/sse-private-check-input-v4.json)、生成脚本、对#15/#19的[完整输入交接](../../knowledge/exchange-bonds/drafts/sse-private/EXECUTABLE-CHECKS.md#v4-input)。没有新增公开DTO、迁移或worker阶段。
- v2九条/v3十一条继续回放；v4字段不写入旧返回面，混版/参数错配拒绝。不会把新规则套进旧run或默认升级正式发布。
- [A03九维→十二码](../../knowledge/exchange-bonds/drafts/sse-private/A03-FEATURE-MAPPING-20260927.md)按已确认方法明确子项证据、多码并存、未细分待审和否定完整性，指出#311单值及下划线/连字符接口差距，交#19统一实现；本PR未自改公共契约。
- 更新AGENTS索引、产品说明书15/17、架构、知识包、章节模板版本、原型知识视图和关闭清单。未修改客户原件或其他五套范围规则内容。

## 工程验证

| 验证 | 结果 | 证据边界 |
| --- | --- | --- |
| 七个M1 TypeScript项目编译及Vite生产构建 | 通过；同步最新基线后重编worker通过 | 编译/打包，不是部署 |
| 完整domain测试 | 188通过、0失败、0跳过 | 包括本轮23项新增分组测试 |
| #20聚焦六份测试 | 60通过、0失败、0跳过 | 新20条均有正常/反例/缺证或范围分支；已包含在188中，不重复计数 |
| 历史稿模型/规则内容、选择、生产选择与release ledger消费者 | 44通过、5跳过、0失败（49项） | 依赖真实PG/授权联调的用例跳过；未声称真实模型或数据库验收 |
| 官方公告/原件回归 | Python 2通过、0失败、0跳过 | 验证归档原件/hash/公告、日期及正文隔离，不等于专业签认 |
| 离线重建 | 273个知识/原型/示例文件前后hash一致 | 保持2026-09-26法规基准；不是新一轮网站现行检索 |
| 文献记录和链接 | 31条结构化来源hash一致、真人approval全为空；352处本地链接/锚点有效 | 来源/版本/可追溯性检查 |
| Git差异检查 | 通过 | 无空白错误；原件无差异 |

复现：先按仓库package scripts构建contracts/domain，再运行`node --test packages/domain/dist/*.test.js`；官方来源用`python -m unittest discover -s scripts -p test_sse_private_knowledge.py -v`。执行`python scripts/build_exchange_knowledge.py`与`python scripts/build_sse_private_check_example.py`重建知识和示例；只使用本机依赖，不调用模型。

## 本轮未完成的门槛

1. **法规与专业判断**：文献核对不代替来源批准。协会负面清单/适当性/受托与会议配套、被引用公司法/重组/税务及专项现行来源的具体缺口见各条；六类人工处理和其他条内未覆盖项需真实专业覆盖决定。
2. **#15 / Xuefeng**：完成同一owner/project/input/material/parse/issuer pin到本轮字段的可信适配、完整期间/表种/章节发生位置遍历。#312/#314已实现16项历史表格候选及PG回归，实际是external/needs_confirmation，不是审计verified；不能误报尚未开始或已全面核证。
3. **#19 / Xuefeng**：#311整体审核/撤回与loader已交付；仍需A03多码/编码桥、实际字典发布、来源/项目审核及规则/模板/coverage正式release。#315只是行业候选绑定，不自动解除门槛。
4. **#31/#35及#146**：目标环境真实run/日志/全文成果，以及产出后的行业与Word/WPS逐章验收。首次有历史稿测试不依赖#77，不把生成后验收变成循环前置。

没有执行模型调用、生成真实募集书、伪造专家签认、启用规则或部署。本轮不关闭#20；按[五项关闭关口](../../knowledge/exchange-bonds/drafts/sse-private/CLOSURE-CHECKLIST.md)继续核验。
