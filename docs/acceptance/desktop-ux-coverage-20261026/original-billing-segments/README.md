# 原收费记录的费用段与执行绑定（0138）

2026-10-27，本地基准 `05155d3d066e653101e71ff8682ee9c2fe10ceb1`。G03 / UX-A03 与完整 UX goal 保持 active，未推送、PR、合并或部署。

本轮将原 reservation 的报价、policy、上限、原输入及创建时间固化为费用段，并将完整 V1 execution identity 绑定到它。首次收费在 enqueue 前立即 capture，迁移按原值回填；既有账本与已扣金额不变。实际扣款、进度、活动时间、交付尾款、SQL 结算、历史与运维审计读取准确绑定，缺失映射不能猜测原 pointer 继续收费。免费内部 V2 仍无收费段，付费 V2 限制和每 run 一 reservation 约束保留。

按费用段保存的 meter 与旧进度表双向精确镜像，包含微秒时间。直接旧 writer 或新 writer 持对侧子行时，NOWAIT 锁以 55P03 结束，释放后可重试。原 on_delivery、authoring_progress_v1 与 authoring_balance_v2 的取消/退款和交付规则保留；原 quote/policy/cap/pointer 不能事后改写。历史分页与公开 DTO 不变；audit 覆盖全部五类原报价、执行绑定与 meter 镜像，运维冲正可明确指定 reservation。

| 采用验证 | 结果 | 原始证据 |
| --- | --- | --- |
| 最终空库完整迁移 | 137 项至 0138，源码冻结相同 | `records/migrate-final02-result.json`、迁移 stdout/stderr |
| API 构建、最终完整源码类型检查 | 均 exit 0 | `records/build-api-final.json`、`records/final-typecheck.json` |
| 实际功能 PG | 19 pass，0 fail/skip | `records/functional-20261027T012504194Z-50364/` |
| SQL 身份、回填、镜像与锁竞态 | 8 pass，0 fail/skip | `records/sql-20261027T012221309Z-38268/` |
| 审计、历史与定向冲正 | 4 pass，0 fail/skip | `records/compat-20261027T012219994Z-39092/` |
| 原计费与内部补料回归 | 57 pass，0 fail/skip | `records/regression-20261027T012222481Z-44808/` |

功能用例使用真实 HTTP reserve、queue、activity、progress、debit、Word 交付、补款、取消和失败退款；M1/M3/M4 均有覆盖。缺 binding、错 cap/source 及缺 canonical meter 通过查询响应故障注入验证钱包和账本无写入；SQL 用例另证实不可变 guard。audit 的损坏输入使用私有影子表运行实际 SQL，不关闭生产完整性约束。历史回填用真实合成 lot/grant/allocation/settle 前缀，前后账本与原 meter 深等；两方向锁竞态使用真实独立客户端，不把 timeout/deadlock 当成功。

三个旧 policy 场景原先在新任务收费后改 policy；这与不可变身份相冲突。现由真实免费 HTTP 创建未 claim/未收费 run，再由受信测试 helper 在首次收费 INSERT 确定旧 policy、冻结积分、记录分配与 reserve 事件，最后首次设置 paid pointer。未关闭 guard，旧取消金额及退款断言保留。

最终冻结 1,429 项源码/产物映射见 `records/sources-final.json`、`records/final-evidence.json`。回归的 `sourcesStable=false` 原样保留：仅未执行的功能测试 TS/JS 在该轮中被修正，所选 11 个回归文件、生产依赖及 SQL 均未变；改正后的功能文件独立 19/19 通过，最终完整源码类型检查通过。SQL/compat 运行时均冻结相同，至最终仅有该未执行功能文件的差异。不将重复用例或不同轮计数合并到用户旅程覆盖。

保留非采用轮：首次迁移观察到并行 SQL 修改、首次稳定模板早于显式 TRUNCATE 分支改进、首次构建的两处测试类型错误、首轮功能 1 pass/11 fail。首轮功能取错公共报价的 policy 字段，随后残留 queued 任务产生级联；修正测试预期与 cleanup 后完整复验通过，没有为测试放宽实现。原始日志均保留。

最终测试客户端和 clone 已退出，两个空中间模板已删除，最终模板无 run/reservation/segment/binding/meter。PID 31152、创建时间、专用数据目录与 15542 端口精确核验后优雅停止，见 `records/db-final.json`、`records/pg-stop.json`。

本轮没有 B1 重做 reservation、0 追加的费用延续绑定、付费后继授权、新收费或桌面接线。下一步须让补料采用原子绑定准确报价确认和新输入，独立关闭原费用段/保持已耗费用、新段从零计量并独立退款；0 追加继续原未完费用。再接正式生产采用、实际 worker 与完整桌面报价确认/续做链。没有新增桌面旅程、真实供应商或专业内容验收，不据此宣称整体 ≥90% 或主要场景/功能 100%。
