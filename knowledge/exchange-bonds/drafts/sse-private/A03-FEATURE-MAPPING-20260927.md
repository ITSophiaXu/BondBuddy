# A03：九个审核维度与十二个选择器码的交接

日期：2026-09-27。按已确认的[A03/A05方法](APPLICABILITY-DECISIONS-20260926.md)细化；响应[#19具体问题](https://github.com/ITSophiaXu/BondBuddy/issues/19#issuecomment-5852641810)。这不增加业务条件、不批准任何项目，也不发布字典。本PR不修改公共契约，由#19负责人在唯一字典及审核接口中实现并评审。

| #311审核维度 | 既有selector代码 | 允许映射的证据条件 |
| --- | --- | --- |
| urban_construction | city-infrastructure | 本期主体/业务事实已审核，不能凭名称认定 |
| real_estate | real-estate | 对应房地产业务及适用条件已审核 |
| group_operations | group-operated | 对应集团经营条件已审核，可与前两项并存 |
| special_product_or_use | special-product-purpose | 实际专项品种/用途已识别；本码只表明需要专项增量，不能据此批准全部专项规则 |
| embedded_or_perpetual | convertible-structure / exchangeable-structure / perpetual-structure | 按具体条款逐子项确认；父项present不能推断三个子项都present |
| optimized_review | optimized-review / simplified-disclosure | 分别有本期采用方案、资格/简化依据和适用日；优化审核不必然等于已获简明披露资格 |
| restructuring | restructuring | 对应事项及现行定义核对；触发审阅不等于发行禁止 |
| special_issuer | special-issuer | 已确认的特殊主体及其增量要求，不能靠模糊标签豁免 |
| transition_arrangement | transition-arrangement | 实际受理/发行/协议时点和对应过渡条文 |

1. **允许多码并存**：同一父维度下，多个子项分别有证据才同时保留；不为适应单值字段删掉一个码。不能以合并标签隐去未知子项。
2. **未细分保留待审**：只知道“有含权/续期结构”或“优化/简明之一”的，不能产出具体肯定码，也不能把其余子项补成无；整体选择保留needs_review。
3. **否定须覆盖子项**：父维度absent仅在全部子项及完整本期材料已排查后可映射为空；not_applicable须有按范围逐项说明，不当作未搜索的替代。父项present时仍须说明其他子项的有/无/不适用，不能遗失部分未知。
4. **历史可重放**：映射版本/hash、审核记录及原始父/子证据一起固定；增加/撤回子项或更新材料后重新审核，不修改旧记录。

## 已发现的实际接口差距（#19 / @loooo139）

基线 `c2eb3b3`：`packages/contracts/src/rule-applicability-context.ts` 的每维`featureCode`为单值，且DTO及loader校验只接受下划线格式；既有selector的十二码多为连字符格式。只填上述映射表还不能把真实多码传到当前loader。

请#19沿唯一字典明确多子项的版本化承载方式及代码编码桥接，并请受影响负责人review；不要在本业务检查器复制一套公开枚举，也不要将连字符静默改下划线后声称已与原字典一致。PR #315只做行业候选绑定，未声称完成此处映射，不能以其合入当作本依赖解除。

验收反例：父项present但无子项、只核可续期未核可转/可交换、同时命中两项、优化审核存在但简明披露未知、父项absent但材料集合不完整、代码字符串能过DTO却不在字典、旧版本审核重放不得覆盖新撤回。
