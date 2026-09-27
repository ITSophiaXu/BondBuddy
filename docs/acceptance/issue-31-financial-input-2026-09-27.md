# #31 财务事实来源接入（2026-09-27）

Refs #31、#15。基线为 develop@65118d6（#318已合并）。本切片修复“external来源即使证据充分也不能进入历史稿生成”的消费端限制，不关闭#31，不代表预发已部署或任丘样本已成功生成全文。

## 行为与边界

| 场景 | 结果 |
| --- | --- |
| 锁定财务/中期报表/附注或审计材料，audited或external，值已知、extracted/verified与实际状态一致、证据完整且无疑义 | 可以参与确定性修改；不提升来源或状态 |
| 本发行人的唯一历史基线 | 另核原文record、材料/version/hash、quote、locator和解析版本；只有有效正文的精确证据可用 |
| external实际用于替换/新增列 | 原文位置记录`UPDATE_NON_AUDIT_SOURCE_USED`并生成中文待核说明；保留支持的修改，计划为needs_confirmation |
| 公式缓存/缺外部源、低置信度、未知值、OCR/证据疑义、假verified | 不提供给模型，也不能由domain计算为确定性事实 |
| 模板/相似稿/参考企业、用户口述、异账号/发行人、未锁定材料 | 不作为本发行人可用事实；归属/版本完整性不符按原边界拒绝 |
| 同一身份有竞争候选 | 冻结全集，不隐藏不确定候选；原有决策选择及版本校验继续执行，选择不提升候选状态 |
| 重放时新增/改动候选或决策 | 读取原精确版本；篡改/缺失拒绝，新增版本不改变旧任务 |

内部实现：`historical-fact-policy.ts`复用材料和历史锚点检查、证据投影；domain `isUsableHistoricalFact`供prompt准入与计划器共用。source kind随冻结候选和私有prompt保存；公开DTO、数据库迁移、发行方式枚举、运行状态机及计费均未修改。

prompt模板升级为`historical-sse-private-v3`，增加来源类型和材料角色，禁止未审计材料冒称审计机构确认/跨期沿用审计意见。已有v1/v2模型绑定不静默复用；保留旧任务和attempt，按新执行流程运行，不删除checkpoint假装重试。模型仍只能提出位置、候选ID、表达式和覆盖说明，最终值由程序计算。

## 已执行验证

Windows本地；模型、规则reader、数据库/对象存储使用明确标注的合成组件替身。真实Python解析器与writer的组件用例使用合成DOCX，不是客户成果或WPS验收。

| 检查 | 结果 |
| --- | --- |
| 全仓M1构建 `npm run build` | 所有workspace通过 |
| domain全套 | 198/198通过 |
| 历史生成、计划、规则正文和事实决策仓储组件 | 77项，75通过、2跳过、0失败；含2项实际Python解析用例 |
| 历史Word阶段 | 4/4通过；含实际Python writer组件 |
| contracts样例 | 122个公共合成样例、12个内部库样例、4个数据生命周期样例通过 |
| OCR v2公共契约 | 29/29通过 |
| 产品说明书重建 | 19模块、188本地链接、133表格、4个JSON示例，0错误；合订版同时同步已合并章节此前未重建的内容 |
| 8项真实报表只读核对 | 原件hash不变；另用openpyxl核对8格公式/显示值、6组直接上游计算；无业务签认或入库 |

2项跳过为需独立PostgreSQL16的事实决策集成，以及默认关闭的授权大型DOCX分片测试。当前测试未配置真实供应商/PG/Blob运行，不把跳过或既往测试算为本轮真实端到端验收。

复现（先安装依赖并build；Windows使用PowerShell设置环境变量，Python设UTF-8）：

```sh
node --test packages/domain/dist/*.test.js
node --test apps/worker/dist/historical-update.test.js apps/worker/dist/historical-model-stage.test.js apps/worker/dist/historical-rule-context.test.js apps/worker/dist/fact-decision-repository.test.js
node --test apps/worker/dist/historical-word-stage.test.js
npm run check:contracts
node product-prototype/product-specs/build-spec.mjs
```

实际Python用例要求`BONDBUDDY_TEST_PYTHON`指向已装`python/requirements.txt`依赖的解释器；Windows另设`PYTHONUTF8=1`和`PYTHONIOENCODING=utf-8`。初次Windows writer的cp1252输出失败在设置此环境后通过，没有因此更改生产writer。

### 评审修复后的增量验证

基于develop@a863951（含#319/#323）合流后：全仓构建通过，最终测试夹具调整后worker重新编译通过；domain201/201，历史生成/计划/规则/事实决策/Word及Q3 mapper共85项，83通过、2项原有条件跳过、0失败；Python输出路径与优化模式校验3/3。说明书重建19模块、188链接、133表格、4JSON示例、187验收标识，0错误。

长待核原因与同锚点external提示完整分段，各条不超过512个UTF-16代码单元；实际Python生成的合成Word已打开ZIP逐条核对comments原文，包含长文本、来源限定及代理对，无截断。保持1000条总量上限，超限在模型阶段明确暂停，不交给Word报通用校验失败。核对表输出拒绝当前仓库、其他仓库/worktree及指向仓库的别名；原件size/SHA显式异常在Python -O下仍生效。#323新增8个公式缓存候选的已知状态形态均不能进入prompt或产出修改计划；该测试使用合成存储候选，不代替实际PG或用户签认。

最终合流至develop@4fbeced（含#322/#324）：全仓build通过，domain254/254；上述worker85项仍为83通过、2原有条件跳过、0失败。补充裸Git仓库防护，按HEAD及objects/commondir识别无`.git`外壳的存储目录，禁止直接、嵌套、路径穿越和符号链接别名输出；实际临时`git init --bare`合成回归及原有校验共5/5通过，无客户数据读写。说明书19模块、190链接、133表格、4JSON、190验收标识，0错误。

## 尚未解决的真实运行依赖

1. **#15 / @loooo139**：#314的16条年度候选实际为external/needs_confirmation，含PARSE_SNAPSHOT_NEEDS_CONFIRMATION、SOURCE_CONFIDENCE_MISSING，仍不可用。#323已将新一期8项公式缓存入库，但仍有FORMULA_CACHE_VALUE_UNVERIFIED、FORMULA_SOURCE_CHAIN_UNVERIFIED等疑义，不能用于生成；[逐项核对交接](issue-15-rq202509-review-handoff-2026-09-27.md)只是待用户确认的证据表，不代写审核。DOCX_DRAWINGS/DOCX_AUXILIARY_PARTS还影响整个基线入口，需按原文位置/影响范围处理，不在本切片批量清空。
2. **#19/#35 / @loooo139、@muhualing**：预发两次gate复验停在rule_applicability_overall_review_required、成果0；仍需可执行的固定账号/样本/输入/规则版本内部授权测试路径。#319分类子项桥不等于生产发布或受控入口完成。本切片不伪造审核、发布来源或开启research_only规则。
3. **#31 / ITSophiaXu**：首个真实模型计划和全文覆盖验收仍待运行；当前仅支持确定性替换/简单插列，复杂条款改写、章节重组、扫描历史稿等缺口继续如实列出。
4. **#34/#35 / @ChrisLiu95、@muhualing**：使用实际模型计划验证Word修订/清洁/基线及下载、断线返回和完整日志。writer及下载UI已实现；#146桌面兼容性独立跟踪，不以同一份成果的事后验收阻止其首次生成。

样本和目标已获授权，不再索取四组原件。首个场景仍为任丘九月、上交所普通私募、2023/2024年度及2025年1—9月；#77参考库不阻塞有历史稿场景。未满足本页依赖前，不声称合并本PR就能完整测试或关闭#31/#20。
