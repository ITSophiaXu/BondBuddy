# #20 第三批规则与历史稿接入工程记录

日期：2026-09-27。分支基线 `develop@5d7860f`（开工82fee23，已吸收#306）；规则 `2026.09.27-draft.5` / checker v3。本文为工程验证，不是法规签认、真实样本验收或生产发布。

## 问题与交付

API按 `ProductionRulePackPin.packId/contentHash` 保存规则，历史稿输入仍取旧 `pack_id/content_hash`，会错误暂停；旧prompt只有规则版本，模型没有实际规则正文。本次修复字段接缝，调用既有 `revalidateProductionRulePackPin`读取并复核精确release，再按适用性投影规则正文、例外、输入/证据要求和对应原文/版本/定位。无需修改公开DTO、规则枚举、数据库迁移或任务状态机。

新增两组受限研究检查：

- **资金用途**：复用既有用途code，逐项规模和配套材料状态；确认清单完整、币种单位与发行费用扣除前后口径一致才精确加总。缺项目/股权/基金/债务依据保留局部待确认；生产性支出概括披露资格不自动认定。
- **信息披露负责人**：负责人及联络人姓名/职务/联系方式、负责人岗位资格、禁止任职情形审核完整性、变更与真实承诺。未变更且有有效既有承诺不重复签署；模型不能代签或编造已签署事实。引用官方负责人指引第2—6条，补齐第4条禁止任职各项原文定位。

累计十一组实现，其他20条候选尚无对应自动检查；其中部分涉及跨章关联/外部资料或条件性增量，不能简单用20个布尔字段替代。全部31条仍关闭、research_only、无正式发布，研究返回值始终 `productionEligible=false`。v3保留v2原九项回放，拒绝混用版本及参数。研究基准仍为2026-09-26；9月27日是工程版本日期，不自动延长法规核验时效。其他五个市场/方式知识包内容未改。

## 两条接口交接

### #15 事实 → 研究检查

入口 `@bondbuddy/domain/sse-private-checks::evaluateSsePrivateDraftChecks(pack,input)`；类型为内部 `SsePrivateCheckInput`、`FinancialCheckInput`、`ProceedsOfficerCheckInput`。新字段的[可运行合成样例](../../packages/domain/examples/sse-private-check-input-v3.json)由新增测试实际读取；[字段语义与边界](../../knowledge/exchange-bonds/drafts/sse-private/EXECUTABLE-CHECKS.md#v3-input)一并交接。

每项证据是 `{value,status,anchors}`。trusted adapter必须从同一owner/project/input/material/parse版本及实际审核记录构造；样例的synthetic定位/verified只用于单元测试。null/无定位/冲突/用户陈述不进入确定性结论。年度、合并/母公司、币种单位、报告/表种/项目清单须完整遍历；本接口不读取最新材料或擅自批准事实。用途配套资料、签署承诺可能来自其他已锁定本期资料，不能要求财务报表凭空提供。

### #19 正式规则 → 历史稿模型

`apps/worker/src/historical-rule-context.ts::loadHistoricalRuleGuidance(db,pin,context)`默认使用既有正式registry，不安装第二套selector。读取API持久化pin及rule_pack_context，校验返回pin、包ID/版本/hash，调用已有 `evaluateRulePackCapability`，只投影实际适用规则及所引用来源。规则原文位于prompt不可信数据区，不能提升工具权限、把例外推广到全部任务或把规则文字当发行人事实。

已撤回/授权失效/未批准/不适用时返回明确暂停；篡改内容或pin不能改用latest。本轮不调用研究checker代替正式审批，也不修改#19 reviewer ledger和producer/approved loader。

## 恢复和边界

- 模板改为 `historical-sse-private-v2`，完整规则投影和其hash进入prompt及现有逐片binding。首次执行与恢复均再验证规则；已有v1绑定不能在v2下静默重放或新发供应商请求。部署前须识别在途v1任务，保留checkpoint/attempt；需要重新执行时按既有流程建新run，不能删日志伪装重试。
- 规则正文投影超过180,000 UTF-8字节或整份prompt超过240,000字节明确暂停，不截断原文或例外。该上限可能限制大规则包/大量事实的真实任务，须用真实组合进一步测量；本轮不声称已支持任意长上下文。
- 规则指导不赋予现有表达式任意法律改写能力。当前无法完成的条款改写/目录重组需明确needs_evidence，并在结果留待人工确认，不能通过retain假装完成。
- 缺局部材料按UPD-GAP-01继续有依据的修改；研究finding不新增整稿硬阻断。#77不是有历史稿路径依赖。
- prompt仍走既有私有快照和模型attempt/usage日志；公开进度只含计数/引用。本轮不执行模型、计费或部署操作。

## 验证记录

环境：Windows / Node 24.19.0。现有共享依赖以junction复用，@bondbuddy均指向本工作区。npm不在PATH，实际用本地TypeScript/Vite执行仓库各包相同build脚本；未改锁文件/依赖。

| 检查 | 结果 | 范围 |
| --- | --- | --- |
| contracts/domain/registry/context/API/worker TypeScript + web TypeScript/Vite | 通过 | 全M1包构建 |
| `node --test packages/domain/dist/*.test.js` | 165通过，0跳过 | 包含新增11组用途/任职边界，旧财务/规则回归 |
| historical-model-stage / historical-rule-context / historical-update / run-pipeline | 53通过，3跳过 | API pin、规则引用/例外/条件过滤、撤回恢复、篡改/超限、缺口、精确更新；跳过1个真实授权大样本和2个需指定Python的解析组件测试 |
| registry/selection/release-ledger回归 | 15通过，4跳过 | 跳过4个需要真实PG16的用例；不宣称数据库联调通过 |
| 公共契约 | 122+12样例、4个生命周期样例、29项OCR测试通过 | 无公开契约变更 |
| 离线重建/链接 | 246份文件重建hash一致，137处链接/原文锚点有效 | 保留原件及版本边界 |
| 官方来源Python单测 | 2通过 | 公告链接、附件hash及日期边界；非专业签认 |
| 原型exchange-knowledge路由 | 5通过 | 六种范围隔离、原文/注释与替代版本 |
| 归档离线检查 | 通过 | 31个ZIP登记项、现有原文/hash、脚注、范围与未发布边界 |

没有配置PostgreSQL/Azurite、真实模型或Windows WPS/Word端到端验收；上述resolver/model替身仅为组件条件，不是实际生产release或真实审核。合成fixture只存在测试内存，不写入发布台账。

## Dependency callout 与下一份交付

已在[#20开工评论](https://github.com/ITSophiaXu/BondBuddy/issues/20#issuecomment-5852317728)明确@loooo139；[Xuefeng回复](https://github.com/ITSophiaXu/BondBuddy/issues/20#issuecomment-5852353443)给出以下协作目标，均为对方预计交付，不能当作已完成：

| 负责人/Issue | 还缺什么 | 对方给出的下次交付 |
| --- | --- | --- |
| Xuefeng / #15 | 任丘九月2025年1—9月主表、合并/母公司、单元格证据；其余年度及条款/用途/任职/承诺按本期资料逐项补。不能用2025三季报生成2023/2024审计事实 | 9月27日18:00（北京时间）前回链首个适配/测试切片或说明材料歧义 |
| Xuefeng / #19 | 整体追加审核/撤回、完整特征否定证据与approved loader；A01–A06、#300目标意图及#293/#296有限台账已具备，不再等待重复确认 | 9月28日12:00（北京时间）前给首版可联调PR或逐项未满足门禁 |
| Maxy / #20 | 剩余现行配套法规、行业分类原文/使用边界与selector映射、逐条来源/方法及真实成果验收；正式发布须实际授权审核 | 本切片不代签、不开放研究包；按31条清单继续 |
| #31/#35，#146 | 接真实规则/事实后运行授权样本，取得prompt/attempt/usage、修订稿/清洁版及行业/WPS验收 | 集成安排需结合前两项交付再确定 |

#20保持OPEN。该PR完成的是规则增量和内容消费者，不宣称首个真实全文更新已通过验收。
