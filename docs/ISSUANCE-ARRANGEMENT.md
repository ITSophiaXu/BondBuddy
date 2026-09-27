# #32 发行安排核对与章节联动组件

2026-09-27，基于develop@65118d6。入口为`@bondbuddy/domain/issuance-arrangement`的`reviewIssuanceArrangement(proposal, financial)`。本组件处理有原输入定位的语义提案，执行金额/条款/作用范围检查，返回待确认问题与章节检查清单。**未接入在线抽取、对话、run或Word，不表示跨品种全文更新已上线，不关闭#32。**

## 输入和信任边界

`ArrangementProposalSchema`是domain内部严格schema，非新HTTP DTO。不改`packages/contracts`、公开发行方式枚举、数据库或运行状态。市场、发行方式、文书用途、Money及单位换算复用公共契约；财务期数复用现有`estimateUpdateDifficulty`。

| 输入 | 约定 |
| --- | --- |
| context | 原任务owner/project/inputRevision/inputHash；调用者须先从已授权、未删除项目和不可变输入版本读取并核对，不接收浏览器自报归属 |
| sources | 项目字段或未来持久化消息的原文、sourceId/version/owner/project/textHash；只支持用户补充，不伪装为审计证据 |
| evidence | 指向原输入的精确UTF-16 start/end/quote和sourceId/version/textHash；错版本/hash/原文、跨账号/项目、拆代理对均拒绝 |
| document | 上游已区分的原稿/目标文书用途、实际工具和注册覆盖范围；本组件不靠DFI/MTN等正文关键词重新分类 |
| registrationAmount / issuanceAmount | 各自独立，金额含exact或ceiling限定。共用Money单位（人民币元/万元/亿元），定点计算；注册总额不是本期金额或剩余可用额度 |
| tranches | 显式提案中的品种ID/名称/金额/条款；不预建品种一二，不把覆盖工具清单变成tranches |
| commonTerms | 条款须声明all、指定品种ID列表或single_only；只有符合该范围才继承。本品种显式null/存疑值覆盖共用值，不复制其他品种 |
| callbacks | 明确不同的from/to品种及原文条件；不自动执行金额调配，不因回拨文字忽略总额冲突 |
| institutions | 机构名称、原角色文字、underwriting/other_agencies来源分组和作用范围。一个明确位于承销商分组且未填角色的机构可标主承销商，保留single_underwriter推导标记；不猜联席/受托/簿记角色 |
| financial | 原有难度估算输入（包括源profileVersion、目标revision、完整新旧期间和重述/替换决定）；目标revision须与本提案一致 |

`textHash = updateContentHash(text)`，是原文JSON字符串的确定性哈希，**不是原文件字节hash**；若后续需要材料来源，须通过其专用证据契约接入，不能改标为本格式用户输入来跳过审核。sourceId/version的持久化真实性、字段与分组语义、对话归属由调用端验证。原文定位仅证明“引用在哪里”，不证明模型理解正确或用户已确认业务事实。

文字提案必须出现在引用原文中。金额仅机械核对明确的阿拉伯十进制金额及元/万元/亿元和“不超过/至多/上限为”限定，不能截掉紧邻上限词改为exact，也不能截去数字前缀、小数点或正负号。中文大写数、复杂区间或其他币种不能猜算，保留原文并形成待确认。无效的局部金额/条款在整理结果中留null，原提案及证据仍保留；来源说明、矛盾及新旧输入不会被组件覆盖或持久化。

## 业务检查

- 精确分项与精确总额不等、已明确分项超过总额、全部分项容量不足以达到精确总额，均列金额冲突，不能自动调平。即使另一档金额未知，已知金额超过总额仍提示。
- 各档上限之和超过总体上限不直接认定矛盾，因为各上限未必同时发行；列分配待定，不把上限求和当实际金额。未知项不按零定案、不平均分配余额。
- 只有单档且金额未定、无显式疑义时可使用本期共用金额；多个品种不能各复制一次总额，也不能继承注册总额。
- 各档期限独立；共同利率/还本付息/含权/增信/用途/对象按明确范围继承。空值不自动解释为“没有回售/赎回/担保”等否定结论。
- 多家承销商缺角色或作用范围时输出问题；一家主承销商无需虚构联席。机构文字及推导方式与原输入保留。
- DFI注册覆盖MTN/CP/SCP不生成已发行品种，不强填未来期限/票息；DFI本期文件缺实际工具时要求澄清。MTN文件出现DFI背景仍保留上游MTN文书身份；冲突保留待核，不能由词频裁定。
- `difficulty.estimatedN`完全沿用财务期间算法：同期跨市场/品种及注册转本期的结构变化仍可N=0；两档不会把同一新增期算两次。待确认期间仍N=null。`structureReasons`只记录已知差异，不把未知原用途当成已确认用途变更；其不修改财务期数或代表已匹配目标规则。

## 输出与后续接线

输出包括原输入/原提案、逐档解析结果（含继承标记）、机构角色/作用范围、带原文证据的issues，以及封面、发行概况、风险、资金用途、偿债、评级增信、投资者保护和机构表8类章节检查清单。此清单是后续逐处覆盖的要求，**没有原文章节锚点、实际修订或合规通过结论**。

`status=ready_for_review`仅表示本组件未发现机械矛盾，不是确认完成；所有结果固定`sourceStatus=user_asserted`、`eligibleForManuscript=false`。存在局部缺口时保留其他明确提案，按UPD-GAP-01继续工作稿能力的其他部分；本组件不暂停或启动run，也不扣分。

`context.inputHash`仍是服务器任务输入hash；`proposalHash`绑定完整提案+financial，`reviewHash`绑定整个结果（排除reviewHash字段）。输入被克隆，后续编辑原数组不改变既有结果。调用端应私有存储原输入/结果，不把含业务文本的对象写公共日志或事件。真正重放/去重与结果版本存储仍待worker接入。

依赖交接：

1. **#18 / @ChrisLiu95，配合平台消息持久化**：版本化补充输入、问题/修改交互。这里的message只是内部适配类型，不声称现有消息持久化已完成，不增加用户注册模式选项。
2. **#31 / ITSophiaXu 与 @loooo139**：真正的自然语言模型抽取、候选语义/作用范围核对、原文全篇锚点与修改计划；本模块schema可用于约束提案，但未经审核的模型输出不能直接写Word或当已核财务事实。
3. **#19、#20–#30 / @loooo139 与业务负责人**：按目标市场、文书阶段和实际工具锁定可用规则/目录；本组件不改生产发布gate、规则版本或allowlist。
4. **#34/#35 / @ChrisLiu95、@muhualing**：目标章节实际增删/条款改写的Word消费及真实联调。当前#31简单替换/插列还不覆盖通用章节重组，不能在接口未定时伪装已完成。

测试及状态见[本轮验收记录](acceptance/issue-32-arrangement-review-2026-09-27.md)。示例来源全部为[合成测试](../packages/domain/src/issuance-arrangement.test.ts)，无真实供应商/客户成果或专业验收声明。
