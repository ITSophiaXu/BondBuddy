# B1 补料追加报价与明确确认（0137）

2026-10-27，本地基准 `e16e3ed79e103612b1ab5e7814cd1e32a66c7bb5`。按用户已选的[B1 暂行规则](../../../product-decisions/2026-10-27-supplement-rework-b1.md)实施；完整 UX goal / G03 / UX-A03 仍 active。未推送、创建 PR、合并或部署。

认证 HTTP 新增报价、准确读取与明确确认。报价绑定原执行、最新补料回执、处理计划、候选输入和现价；客户不能提交费用或内部计划。M1 双 Word、M3 配套成果、M4 正文与说明各只计一个业务单位。原收费类别保留，现行整份价重新读取；真正零 attempt 早停追加 0，不依赖价表、不减免原任务费用。报价与确认均不可变，各自与 outbox 事件同事务提交。读取历史准确回执和同 key 重放不重新计价；新确认仍检查当前暂停、材料、价格和 DB 时钟有效期。归档、删除和关闭账号撤销访问。

采用的定向结果如下，按套件分别记录，不合并到历史 15 条旅程或 662 项桌面计数：

| 验证 | 最终结果 | 原始证据 |
| --- | --- | --- |
| 空库完整迁移 | 136 项，至 0137；迁移源码前后相同 | `records/migrate-result.json`、迁移 stdout/stderr |
| API 构建及最终类型检查 | 均 exit 0 | API build 日志、`records/final-typecheck.json` |
| 新报价与确认 API PG | 26 pass，0 fail/skip | `records/api-20261027T005520845Z-19492/quote-pg.*.log` |
| 处理计划 PG 回归 | 41 pass，0 fail/skip | 同目录 `processing-plan-pg.*.log` |
| SQL 直接约束、过期与并发 | 15 pass，0 fail/skip；完整进程 exit 0 | `records/sql-pg-root-final/` |
| 原补料、准备、M1/M3/M4 计费 PG 回归 | 109 pass，0 fail/skip | `records/regression-20261027T005603994Z/pg.*.log` |
| 原计费分类单元 | 4 pass，0 fail/skip | 同目录 `classification.*.log` |
| 新 contracts 单元及既有样例检查 | 7/7 新测试；构建/样例检查通过 | `records/contracts-results.json`；原始输出仅存工具会话，该限制保留 |

API PG 还覆盖原 paid quote 旧价变现价、候选信息变化不改变原收费类别、付费零工作保持原 reservation、真实 HTTP/session/CSRF、额外价格字段拒绝、并发幂等、两种 outbox 故障回滚、旧补料/检查点/现价/真实时钟过期拒绝新确认，以及归档/删除/关闭账号。SQL PG 另核对三类原付费来源、直接篡改与拆分计价、UPDATE/DELETE/TRUNCATE 禁止、材料锁及删除屏障。

API runner 的总退出码 1 是并行 SQL 测试 fixture 源码及其 JS 变化造成的冻结差异，三个实际 child 均 exit 0。差异严格仅限该 SQL 测试文件；所有 API 生产实现与已运行用例依赖未变。该最终 SQL 文件经独立完整 PG 和最终 TypeScript 检查通过，最终 1,417 项源码/产物映射见 `records/sources-final.json` 与 `records/final-evidence.json`。没有重跑已通过且依赖未变的套件来抹去差异。

保留两次非采用 SQL 运行：`sql-pg-01` 为 ESM/CJS 启动错误，未执行 SQL；`sql-pg-02` 被工具等待超时中断，12 条已输出 ok 不计入最终 15 条。准确进程退出及中断说明保存，残留单个测试 clone 经无客户端核查后删除。最终模板无 run/job/quote/confirmation；本轮全部测试客户端已退出。数据库 PID 15704、数据目录和 15542 端口核验后优雅停止，见 `records/db-final.json`、`records/pg-stop.json`。

启动辅助脚本因 Windows 继承管道直到数据库停止后才返回，因而其延迟的 `pg-start.json` 无进程并报 identity verification failed。真实启动成功由当时 `pg-start-observed.json`、数据库日志、迁移和完整测试证明；延迟脚本不作为启动失败或停止失败的依据。原始记录均保留。

这一切片只记录报价和金额同意，没有创建新输入版本、reservation、扣款、材料 retention pin 或模型调用。桌面尚未接线；生产同任务续做需要执行分段账务和生产采用授权，不能仅放开 0135/0136 的付费限制。下一步依赖定位见 `records/execution-billing-segments-dependencies.md`。未执行完整桌面旅程、真实模型/供应商或新增 Word 验收，不据此宣称整体覆盖 ≥90% 或主要场景/功能 100%。
