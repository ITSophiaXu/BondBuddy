# 内部测试的同任务补料采用（0135）

本轮以 `d3325da8` 为起点，保留完整桌面 UX goal。真实 PostgreSQL 已验证三类任务在原 `run_id` 中采用候选输入、形成 V2 并领取准确租约；这不是补料后新版 Word 或付费 G03 验收。没有公开采用路由，没有推送或部署。

## 实现与边界

- 内部服务先冻结已核对的候选输入，供独立授权者为准确 input revision/hash 建立新测试 grant；冻结本身不改变活动输入、项目最新输入、队列或费用。采用事务重新核对暂停、保存回执、处理计划、候选、旧工作和材料，写不可变授权回执、V2、canonical snapshot、head CAS、新执行 checkpoint、queued 事件与 outbox。
- 原 run/job 的请求、原输入、channel、grant、报价与账务字段保持原意。新执行从空 `stages` 开始，provider/operator 全历史保留，旧阶段仍在保存回执中。准确请求重放只返回原采用回执。
- `assertRunExecution` 负责结构性执行身份；统一 `assertRunExecutionTestGrant` 在领取、新调用、finish、规则能力与 fact producer 上复查该执行的实时 grant。V2 不使用原 run grant；provider result 的准确证据落库不额外依赖 grant 仍有效。
- 复核候选在 hash 冻结前按原执行及补料回执确定新 report ID，业务版本加一；保留原报告、source report、operation、finding 和 evidence links。缺失或错配身份依据时不生成可采用候选。
- 0135 使用不可变来源、精确外键、head CAS 和提交时完整性检查。先取得完整材料 advisory 锁，再按稳定顺序以 `FOR SHARE NOWAIT` 锁定来源项目和材料，核对存活状态、角色与 hash；不能在最终核对后采用已删除或开始清理的字节。已采用 V2 获取材料保留 pin，未采用计划仍不获取 pin。
- 此次只开放内部 `non_production_test` 的 V1→V2。生产、付费 reservation/meter/accrued-points 路径拒绝；V2 artifact 的旧自动绑定也明确拒绝，避免把迟到旧 writer 错标为新执行。V2 working/artifact、三类实际续做请求与 Word delivery 尚待接通。逻辑调用名保持稳定，既有 execution binding 负责区分调用历史。

用户选择的 B“必要重做另行报价、确认后继续”保持不变；具体追加价格公式仍待明确。本轮没有发明费率、追加金额或收费确认，也不能将内部测试授权解释为付费授权。

## 最终采用结果

仅采用 [selection.json](selection.json) 指定的最后结果，不累加重复运行或历史 308 项。

| 选集 | 通过 | 跳过 | 失败 |
|---|---:|---:|---:|
| 采用、准确授权、真实跨项目删除竞态 | 15 | 0 | 0 |
| 执行、候选、补料准备与材料清理回归 | 151 | 0 | 0 |
| Worker 授权、规则、fact 与恢复回归 | 83 | 2 | 0 |
| 合计 | **249** | **2** | **0** |

contracts、API、worker 构建通过。SSE capability 的真实 PG opt-in 已开启。两项跳过分别是授权任丘原件的显式 opt-in 检查和已有 Python Word 交付 opt-in；没有将它们计为通过。

三类正向采用均核对：原请求/原 grant/原输入/原账务不变、新 candidate hash、V2 snapshot、空活动阶段、原 provider history、准确重放、V2 claim、旧 lease 拒绝、材料 pin、旧 artifact writer 拒绝。另验证新 grant 撤销阻止领取、两个采用者只提交一个、直接 SQL 无回执或不完整采用不能提交。两条真实 M4 竞态在最终 basis 核对后，由第二连接实际提交材料或来源项目软删除，再放行采用，要求整笔 409 且原 authority/events/outbox 不变；没有伪造 SQL 结果。

测试使用真实隔离 PG、真实 API 捕获的暂停/补料回执以及合成私有 DOCX 字节。没有外部模型、真实支付、Azure Blob、实际 V2 Word 交付或业务内容专业验收。

## 源码与数据库封存

第一对源码冻结覆盖 151 项回归、83/2 worker 回归及当时失败的采用复测；第二对冻结覆盖最终 15 项采用复测。两对各自前后均为 2,471 条完全一致。两对之间仅改变 `run-supplement-test-adoption.ts` 及其编译 JS，移除错误的队列列名；前两组选集不导入该模块。最终冻结 SHA-256：`7dd42fe906f85e5436662702a0895dd8ed088dbcba6b34b65203afc384a2583d`。

独立 PostgreSQL 16.14：`.local/test-successor-postgres/data`，127.0.0.1:15542，用户 `bb_successor_test`，本轮 postmaster PID 32636，启动于 `2026-10-26T23:18:13.463Z`。全量重放到 0135；停止前无测试 clone、无其他客户端，template 只保留原 0027 seed。最终 source-after 于 `23:39:15.290Z` 完成，随后 `pg-stop` 于 `23:39:32.170Z` 完成并检查监听、PID 文件及原进程消失。

部署仍需遵守 0133 的先决条件：停止旧 storage worker、阻止新 claim、排空已认领 tombstone，再迁移并启动新 worker。0135 表锁使用 NOWAIT，写入未排空时应失败重试，不能把本地空库迁移当成线上滚动部署验收。

## 失败与纠正

原始输出逐字节 gzip 封存于 [evidence](evidence/)，未覆盖失败回执：

1. 沙箱 initdb 无法创建 Windows restricted token；使用普通用户初始化本轮专用测试集群后成功。
2. 首次 worker 构建暴露旧 fixture 的 `number`/`1|2` 类型差异，修正 fixture 的明确执行身份。
3. 首次采用选集为 6 pass/5 fail：一个 V1 单元把结构查询内的 receipt 子查询误计为 resolver 查询；其余实际采用因 JS 丢失 PG 时间微秒被正确拒绝。计数改为独立查询，时间改为 SQL 内直接引用同一 receipt。
4. 第二次采用选集为 10 pass/5 fail：真实数据库发现服务误写了不存在的 `bb_jobs.available_at`；移除此列，最终 15/15 通过。

此外，有三个沙箱 PowerShell 辅助进程停在控制台启动阶段。只读确认它们只有 conhost、没有目标 node 子进程或新 verifier 目录后，先前 Stop-Process 的 .NET 错误及保护检查均保留；按准确 PID 用 taskkill 终止，原句柄返回 terminal 后才重新启动采用选集。真正运行中的回归进程未重启。详情见封存的 `startup-note.json`；此类未启动辅助进程不计作已执行测试。

完整 G03、90% 场景覆盖及主要场景 100% 仍未证明。下一步是 receipt 授权的历史工作读取、三类真实生成 stage 的 V2 请求、working/artifact/registration/delivery 闭环，再完成追加报价与确认。
