# 阶段与模型恢复边界：本地专项

本轮贯通实际 queue、pipeline、模型 journal 与两处历史工作消费者，避免阶段名和任务累计调用编号成为后继输入的错误复用依据。**V1 gate 保留；没有采用补料、活动执行切换、追加计费或同任务新版 Word，G03 / UX-A03 和完整 goal 仍 active。** 未推送、创建 PR 或部署。

## 实现

- checkpoint 保留 `stages` 形状，可信写入增加完整 `stage_execution`。claim、锁内读写、完成/恢复、pipeline 和补料冻结/文件读取检查准确 tuple；无 stamp 仅兼容已解析的 V1，冲突 stamp 不自动修复。通用进度保存保留阶段、provider results、operator 决定及恢复审计。独立材料解析 job 不改。
- prompt 读取增加 `model_request` kind 和准确 input revision/hash。即使阶段集合身份正确，混入其他输入或 kind 的 prompt 也不能读取字节或进入 adapter。
- logical call ID 不改，持久 attempt 编号仍按 job 递增；schema reask 预算单独计本执行调用次数。历史 prompted attempt 先验证完整执行/输入/prompt 绑定再筛选；缺失/损坏来源不返回 absent，旧 unknown 仍阻断新发送。unprompted V1 兼容记录保持可见，但不能获得伪造的结果绑定。
- 公开复核按准确执行选择旧/新协议，来源只读取对应完成 call/prompt 的检索证据；旧分批阅读的 timeout 与结果引用先核对真实来源再决定是否适用。原始 operator/provider 历史保留。

## 验证结果

| 独立集合 | 通过 | 跳过 | 失败 |
| --- | ---: | ---: | ---: |
| API 恢复边界 | 39 | 0 | 0 |
| API 旧工作、草稿、交付等回归 | 149 | 1 | 0 |
| Worker adapter、暂停、prompt、公开复核及分批阅读 | 67 | 2 | 0 |

实际选集和命令在 [verify.mjs](verify.mjs)，每个 spec 在启动前检查存在。API 的整套 synthetic queue/Azurite 测试，以及 Worker 的 durable Codex/Azurite 与 provider reconciliation/Azurite 测试因未配置 Azurite 而跳过，不算运行通过。真实 PG 的执行身份、stage 写入/升级、恢复拒绝、调用绑定/序号、锁顺序及 Worker 原输入暂停恢复/prompt 拒绝均实际运行。纯 helper/adapter 的跨版本场景使用明确 mock/格式 fixture，**没有在 PG 放松 CHECK 来创建 V2，也不证明真实 V2 执行**。

contracts、API、Worker 构建和 web typecheck 通过。构建期间补充测试及 latest-only compatibility wrapper 后，再完成 API 编译；最后增加通用进度对 timeout repair 审计的保护并再次编译 API。所有测试在最终冻结后运行。13 次 verifier 调用均保留；本轮没有失败测试轮次。与此前专项和既有 662 pass 分别记录，不据此增加 G03 旅程通过数。

本轮使用合成 PG 数据、内存私有对象及 fake Codex 进程，不调用真实模型或支付服务，不处理客户文件；未进行浏览器/Word/WPS 排版或专业内容验收。

## 来源和证据

- [summary.json](summary.json) 给出采用轮次、退出码和各测试集合计数；[raw-files.json](raw-files.json) 记录原文件路径、原始字节数/hash 与 gzip 位置；[manifest.json](manifest.json) 记录归档字节数/hash。gzip 在生成时解压逐字节核对。原始记录没有改写，归档脚本见 [archive.mjs](archive.mjs)。
- 最终 before/after 两轮各 2,310 项源码、编译产物、契约、迁移、Python 及配置冻结一致，snapshot SHA-256 均为 `7400022a5ad9e28cb8590f88777b7af87258dc7b40a61ae2a006a11b640d9622`。冻结范围由 snapshot 与 verifier 明列，外部 Node/Python 二进制及依赖包不在其中。
- 复用 `.local/report-postgres/data` 专用 PostgreSQL 16、loopback 15540、`bb_report_test` 及 `bb_execution_report_template_20261027` 模板。启动身份和准确 PID 已核对；最终列明审计表仅有预期迁移 seed，无测试 clone 或其他 client，随后停止并确认 PID 文件消失。审计不涵盖未列出的表。
- 80 个初始归档文件保存 13 次 verifier 调用的原记录及日志；另封存本 README、source/index 证明与 start.json 引用的三版 verifier，共 86 个文件。旧专项档案未改。
- [sources.json](sources.json) 核对 21 个变更源码/测试与已测试冻结的原始字节，并保存实际 staged Git blob 的字节数/hash；Git 对换行的过滤结果与 index object 相等。[source-proof.mjs](source-proof.mjs) 保留该核对方法，不把工作区 CRLF 与 index LF 的不同 hash 说成原始字节相同。

## 仍待完成

SQL readiness/delivery 尚不独立验证 stage stamp，继续依赖现有 V1 与准确成果来源约束。`recoverUnifiedTimeout` 的自动恢复安全次数仍按整个 job 历史累计。历史绑定逐条查询存在额外查询开销。后继采用须一起处理这些入口的活动身份、不可变版本链和旧来源，并先冻结旧工作，再按明确依赖与重做计划切换阶段；不能复用同名旧 prompt 或清空后整单重跑。

用户已选 B“必要重做另行报价，确认追加金额后继续”，B1/B2 定价公式仍未确定。本轮不推定金额或新增扣款。采用 CAS、报价确认/账本、准确材料保留、真实增量处理、三类 executor 及最终同任务新 Word 的桌面连续旅程仍是完整目标的必要工作。
