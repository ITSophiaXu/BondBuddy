# 细粒度任务性能追踪（#1415）

本批实现细粒度耗时日志设计的第一批：持久化 span、队列/容量/共享依赖等待、模型及工具操作、材料与文件 I/O、交付尾步骤，以及现有 `/admin/` 的瀑布图、统计和导出。旧业务阶段、计费、模型证据门禁和质量检查继续按原规则执行。开发和自测完成不代表生产部署或真实模型金样验收。

## 数据链路

`runPipelineOnce → AsyncLocalStorage 上下文 → withPerformanceSpan → 有界独立写入器 → bb_performance_sessions / bb_performance_spans → log_reader API → /admin/`。

公共 schema 只在 `packages/contracts/src/performance.ts` 定义。单 run 采用现有 run ID 关联；每次领取/恢复有独立 `run_execution_id`，模型使用实际 `logical_call_id / call_id / attempt_no`。批次采集只在业务事务成功提交后产生；没有派发成功的空轮询不写明细。

第一批的主要边界：

| 环节 | 记录内容 |
| --- | --- |
| 提交后的等待与领取 | 批次派发事务、批次创建至本项被接纳的总历时、run 创建至首次 claim 的总历时、claim 操作 |
| 阶段 | 每次阶段执行、检查点持久化、已成功阶段复用、失败/暂停/恢复 |
| 模型准备 | 本地/全局容量等待、准入、prompt 编制及快照、工作区、发送 intent |
| 模型执行 | 每次真实 exec、可见 stdout/JSONL/agent message 里程碑、工具开始结束配对、真实 usage 引用、schema 重问 |
| 模型结束后 | 输出校验、文件收集、结果及 runtime 持久化、清理 |
| 底稿共享处理 | 一次 source 生产、source 复用/等待、计划缓存、group/plan 生产/复用/等待/保存 |
| 文件与交付 | 实际每次 Blob 读写及字节、有效原稿处理、Python 抽取/检查/渲染、预览、Word 检查、promotion、回读、登记、结算及最终事务 |

步骤名固定，批次、材料、轮次等作为白名单属性。共享消费记录真实生产者 run/item（可获得时）和逻辑调用关联；没有持久化生产者 span ID 的旧记录不伪造 span_links。生成工作只在实际生产者下记录，等待任务只记录等待/复用。

## 时间含义

同进程时长来自 `process.hrtime.bigint()`，数据库使用 `double precision` 毫秒保留亚毫秒精度（这是相对最初 bigint 建议的明确调整）。UTC 时间用于排序和跨进程观察，不能相减不同进程的单调时钟。

`job.queue_wait` 是数据库 run.created_at 至客户端首次 claim 开始观察的总历时，不是精确 commit-visible 入队时间；它可能含领取前暂停，使用 `wall_clock_observation` 和明确的 measurement_source。重试不重复生成首次队列等待。`batch.item_wait` 也明确含人工暂停，不作为容量不足的直接证据。容量许可等待与占 worker slot 的共享依赖等待各自记录。

`model.exec` 是 CLI 进程的可观察运行区间，包含网络、工具和供应方开销。工具 duration sum 表示累计工作；busy union 表示重叠区间并集。缺 start/end 或超过每次调用 128 条工具明细上限时，工具并集/总时长为 null，并显示缺测。CLI 未暴露可靠供应方首 token 时间，`ttft_ms=null, ttft_availability=not_exposed`；不将首 stdout 或消息当作 TTFT。

父 span 和子 span 的时长不可相加当作任务总时长。页面按区间并集扣除直接子步骤；顶层“细步骤解释覆盖”排除 run/stage/call 等纯容器。未翻完页、丢 span、未完成、工具缺边界或已清理数据不能显示精确未解释时长。未解释时间不叫 CPU 或纯推理时间，最慢步骤也不冒称因果关键路径。

## 可靠性、隐私与权限

写入器使用独立连接池（最大 1 连接）、短连接/SQL/锁超时、有界内存队列与单并发批量写入。默认最多 1024 个待写 span、128 个活动采集 session、每 session 10000 个 span，批量 100 条、正常刷新间隔约 500 ms。关闭时仅尝试限时刷新；业务路径不等待每条性能日志落库。

采集不可用、丢记录和缺结束以 session 的 generated/acknowledged/dropped/invalid_attributes/flush_errors/closed/complete 及缺测状态呈现，不能当零时长。业务返回值和业务异常不因日志故障改变；既有模型 intent、usage、审计和 evidence gate 仍是强制证据。

属性只接收受限代码、ID、hash、数量和状态。Blob key 只保留 hash；不记录正文、prompt、shell 命令、工具输出、签名 URL 或凭证。

API 要求现有 `log_reader`，读取前持久化访问审计、返回 no-store，并限制并发与 SQL 执行时间。数据库写入验证 owner/project/run/job 关系。性能明细沿用日志内容保留期限与 legal hold，终态旧 span 可以清理，session 保留清理数量、原因与策略版本；清理后的 session 不再称完整，也不能被迟到写入复活。

## 查询与使用

- `GET /api/v1/admin/performance/runs/:run_id`：单次返回最多 500 条，可翻页。游标保存 PostgreSQL snapshot，使用不可变 recorded_xid 判断创建事务可见性；翻页期间后来提交的记录也不会混入本次成员范围。刷新后开启新范围。
- `GET /api/v1/admin/performance/summary`：服务端扫描完整筛选范围，不依赖旧快照的最近 1000 runs/150000 events。按任务类型、阶段、步骤、执行状态、模型、版本与 run 状态分组，输出样本量、计时样本量、p50/p90/p95/max。超过 5000 组明确要求缩小筛选，不静默截断。
- 管理概览点击“查询性能”；任务详情点击“步骤性能”。可展开层级、查看缺测/共享关联、导出当前明确范围。CSV/JSON 保存筛选条件、查询时间、审计和覆盖信息，不能把已加载部分当全量。

可复现的采集开销检查：先按仓库顺序构建 contracts/domain/registry/context/API/worker，将 `BB_TEST_DATABASE_URL` 指向允许克隆的本地已迁移模板，再运行 `node scripts/performance-timing-benchmark.mjs`。它克隆独立数据库，对相同 50 个顺序异步等待做交替开/关采集测量，输出每对结果和中位差值。只证明该合成负载，不证明生产性能或模型效果。

## 首批边界与发布

未将提交前 HTTP 校验、独立解析作业、逐页 OCR、逐章渲染、逐条 SQL、进程资源采样纳入新的 run span 全覆盖。后续依第一批实际瓶颈补充。当前未提供跨任务输入规模分桶、完整 DAG 因果关键路径或供应方内部推理时间；不能从已有字段推算伪造这些结论。

新增迁移 `0185_performance_spans.sql`。统一发布应先迁移，再更新 API/worker/web；迁移不改既有表业务语义。旧版本回滚可以保留新增性能表，按既有发布锁、备份与核验流程执行。本批不继承上一批日志补丁的金样/人工签认例外，生产上线由指定发布 chat 执行。
