# 补料处理计划与活动执行依据：本地专项

本切片保存不可变的内部处理计划，并将其交给 M1 编制、M3 复核、M4 文书的真实请求构建器。覆盖准确完整旧稿，以及首次模型调用前、保存 prompt 前后的真实暂停。活动执行依据单独持久化，但仍只允许原 V1。**没有采用补料、追加报价确认、V2 执行、模型续跑或补料后的新 Word；G03 / UX-A03 与整体 goal 仍 active。** 未推送、创建 PR 或部署。

## 行为与边界

- `0131` 保存指定补料回执、准确执行/输入、checkpoint、候选材料、旧文件引用、basis/plan hash 和固定的全文重核规则。计划不复制 manifest、要求、prompt 或报告正文，不授予材料保留、下载、采用、队列、模型或收费权限。
- 创建和读取先核对私有字节，再按 project → run → job 锁顺序重核暂停、租约、未决调用、回执、候选和文件状态；不在这些锁内执行 Blob I/O。请求幂等键不能指向另一回执或依据；读取不以项目最新草稿替代指定回执。
- `no_prior_work` 要求没有模型阶段结果、调用尝试、provider result、捕获结果或工作文件。即使已确认未发送的 attempt 也不能当作无历史；部分、缺失、损坏或已清理的旧工作均拒绝，不能降级为空。允许已经保存准确 prompt 但从未尝试模型调用的暂停。
- 三类 preparer 通过显式 `processingPlanId` 使用持久计划，工作区 I/O 和原件验证前后重新核对准确依据。无旧稿时使用真实候选 writer，不伪造 `previous_work`；完整旧稿沿原 continuation writer。返回对象为副本，修改它不能改变内部请求。
- 保留 M1 固定私有要求、M3 原复核操作和选定问题范围、M4 原来源/模板/正式底稿/知识及固定模型方法。M4 即使尚无 attempt，已保存的 method 仍必须匹配。M1 未 discard 时使用保存的 clean 编辑基线；M3/M4 旧文件作为待重核参考。
- `0132` 为全部 run 严格回填唯一原 V1 活动 head，保持完整 owner/project/run/execution/input tuple 及 PostgreSQL 原时间精度。新 run 自动创建 head；缺少原执行的回填原子失败。正常写入不能改删 head，真实 resolver/claim/resume/阶段写入在 head 缺失或冲突时拒绝，不修复或回退原字段。
- 当前没有章节/问题依赖图或任意 scratch 恢复，计划保守要求结合全部候选材料重核。上述内部请求准备不证明已完成增量执行或复用收益。B“必要重做另行报价、确认后继续”已选，B1/B2 具体公式仍待确定，没有推定价格或新增流水。

## 验证与证据

| 最终独立集合 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| API 持久计划、head 迁移与真实执行边界 | 50 | 0 | 0 |
| API 候选/回执/旧稿准备、业务快照、artifact 和 prompt 回归 | 223 | 0 | 0 |
| Worker 三类持久计划请求准备 | 17 | 0 | 0 |
| Worker 三类共用 writer 与原 preparer 回归 | 31 | 0 | 0 |
| Worker 原执行、暂停、交付与 M4 回归 | 82 | 0 | 5 |

最终采用合计 **403 pass、0 fail、5 skip**。跳过项分别是 M4 完整交付/计量与输出 symlink，以及 DOCX/PDF 复核交付恢复和 report symlink；受 Windows 和未配置 Blob/Azurite 的条件限制，DOCX/PDF 链路另要求 Linux。它们没有通过复验。测试数量不换算为用户旅程覆盖率。

contracts、API、Worker 构建及 web typecheck 通过。最终 API/Worker 构建在夹具修复之后完成；**先构建，再冻结，再运行定向测试**，不声称构建命令都位于冻结对内。前后各 **2,425** 项源码、编译输出、Python、skills/编制知识及配置逐字节一致，snapshot SHA-256 为 `71dbc9c9c7a1f1493a5840d70cb637c03df4e071f16e1b99a382abee9d808eec`。范围以 snapshot/verifier 为准，外部运行时和依赖包不在冻结范围。25 个本轮源码/测试/迁移文件另与 Git 实际过滤后的 staged blob 核对，保留 CRLF/LF 的准确含义。

首次迁移在 PL/pgSQL `IS DISTINCT FROM CASE` 表达式缺少括号处失败，修复后成功。首轮旧 API 回归为 216 pass / 7 fail：六个失败叶用例及其父用例均源于新延迟 FK 下旧腐化夹具的 DML 后 ALTER。回滚型夹具改为先排空合法事件、损坏后由外层 ROLLBACK 同时恢复数据和 guard；独立提交型 prompt 夹具同步处理 head/真实 version，验证 FK 后再恢复 guard。原业务拒绝断言保留，生产约束没有放宽。该开发期旧回归期间发生夹具修改及重构建，未作为最终冻结结果采用；两次早期专项通过也不累加。失败日志及其 verifier 版本均保留；没有独立保存首次失败时的 SQL 全文/哈希，最终 SQL 另在源码冻结中。

最终源码、旧工作/无旧工作分支、返回对象隔离和证据口径均经独立只读复核。采用轮次与原始记录见 [summary.json](summary.json)、[selection.json](selection.json)、[raw-files.json](raw-files.json) 及 [manifest.json](manifest.json)，准确暂存源码证明见 [sources.json](sources.json)。压缩副本按原始字节 SHA-256 核对，失败、重复运行和跳过不计为采用通过。

专用 PostgreSQL 16 位于 `.local/report-postgres/data`，loopback 15540，用户 `bb_report_test`，模板 `bb_execution_report_template_20261027`。最终审计确认明列的业务表只有原 migration seed、没有测试 clone 或其他客户端，再核对本次启动的准确 PID **40128** 和启动时间后停止，确认无 PID 文件。审计范围以 verifier 的表清单为准。

测试使用专用 PostgreSQL 16、合成模型意图/Word、内存私有字节及临时工作区；没有真实供应商调用、Azure Blob、支付、客户材料、浏览器或 Word/WPS 视觉/专业内容验收。请求读取仍保留既有私有正文访问审计，不宣称数据库完全无写入。
