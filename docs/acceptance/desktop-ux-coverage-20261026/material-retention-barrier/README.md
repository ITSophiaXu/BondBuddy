# 原材料保留与删除开始屏障：本地专项

起点 `b28c6262`，分支 `codex/desktop-ux-coverage-20261026`。本增量修复已验证的原件删除竞态：真实 M4 提交已完成材料校验、尚在账务锁上等待提交时，支持材料或模板可能被另一请求软删除；旧 purger 的末次 pin 查询看不到未提交任务，之后仍可能删掉它将使用的原件。

**G03 / UX-A03“暂停 → 补料 → 继续同一任务 → 新 Word”尚未完成，整体 goal 保持 active。** 本切片只协调原材料字节的 pin 与删除。用户已选择 B：必要重做另行报价、确认追加金额后继续；具体定价公式仍未确定。本次没有采用补料、开放 V2、发起供应商调用或新增收费；仅本地提交，没有推送、PR 或部署。

## 实现边界

- `0133` 为 run、原 V1 execution、legacy/canonical M4 snapshot、job 的相关写入和 terminal → active 恢复增加共同材料锁。按真实 signed bigint key 去重排序。有效 JSON 引用在材料行尚未出现时也先锁住同一 tuple，避免分阶段写入遗漏后出现的材料。
- 等待后用新的语句读取真实 material/input/tombstone，保留原 local 引用和 M4 source/project/version/hash 精确语义。缺失行及不匹配的跨项目 M4 hash 只增加 speculative lock，不因此成为新的业务准入条件；无效 JSON/version 安全跳过。draft、候选、处理计划不获得字节保留权。
- purger 在短事务中取得同一材料锁，核对准确 immutable target、token、attempt 和数据库实时有效租约，再读 pin。有 pin 则释放 claim；无 pin 则保存 append-only `bb_storage_purge_starts`，提交后才进入 Blob I/O。不在 Blob I/O 期间持有这些事务锁。
- producer 先提交时，purger 看见 pin 并保留字节；purger 先提交删除记录时，后来的 producer 整笔回滚，使用既有 `409 INPUT_REVISION_CONFLICT`。删除失败、删除后 finalize 中断及后续重试均保留首次 start，不重新开放引用。
- 普通材料的 owner/project/id/version/upload/object key/hash/byte size 固定；原解析、签章、描述和单向删除路径继续使用原规则。V1/head 约束及原保留期限不放宽。协议显式要求 READ COMMITTED，其他隔离级别拒绝，避免等待后仍使用旧快照。
- `0133` 拒绝任何现存 claimed tombstone，并将历史 material `attempts>0` 保守登记为 `legacy_attempt`。该记录表示过去可能已经执行破坏性 I/O，不证明过去确实删过字节。未尝试的 pending material 及 orphan 不回填 start。

## 验证口径

新增测试使用真实 API/queue/storage lifecycle、PostgreSQL 16 和内存私有对象。M4 正向竞态在真实 execute 的 credit-account 行锁处等待，并通过 `pg_blocking_pids` 证明 purger 等待材料锁、未进入 Blob。反向竞态先证明原 failed Word 任务具备合法恢复条件，再在已提交 start 的 Blob barrier 处尝试同一恢复，核对 run/job/provider/账务/outbox 和私有对象没有被该恢复改写。

四种分阶段 SQL 引用（local material_versions、manifest.materials、M4 document、M4 QA）另外覆盖：材料不存在时持锁、随后真实创建及软删除、purger 等待、producer 提交后保留字节；它们不冒充公共 API 接受缺失材料。错误但格式有效的 M4 hash 仍不建立 pin，也不会被 speculative lock 变成新门槛。另覆盖 token/attempt/过期租约/active pin/隔离级别负例、legacy/canonical/job/subtype 晚到写入、start/材料身份不可变及 terminal 复活拒绝。

完整 0132 → 0133 迁移在私有 clone 的外层回滚事务中回放，核对 claimed 时原子失败、历史回填、准确元数据/时间窗口/V1/head/pin 不变。专用 seed-only 模板先成功安装 0133，后仅更新本地模板中两项完善后的 helper；该更新的原 SQL、patch、实际安装函数及审计均单独保留，完整最终迁移仍由上述回放测试验证。

旧夹具的材料 hash/version 原地改写被新约束正确拦截。membership、issuer 和非生产通道夹具改为初始不一致输入；parse-admission 因既有 parse-job 精确 guard 不能直接写入错误 hash，在私有 clone 外层回滚内短暂关闭唯一 byte-identity guard 构造历史腐坏，立即恢复后执行原 HTTP 断言。savepoint 模拟提交在 RELEASE 前执行 deferred checks，保留真实提交边界。另补旧 timeout prompt 的准确 lease input 引用。原业务断言保留，生产约束未放宽。

首轮 SQL 的 dollar quote 编辑错误导致迁移失败，修复后成功；旧 API/worker 腐坏夹具及漏 prompt 引用产生的失败、第一次不合法 stale parse-job 夹具失败均保留。首次失败 SQL 全文未独立保存，不能声称可逐字节重现该编辑版本。重跑及冻结前的通过均不累加为最终采用计数。

## 最终采用结果

| 独立集合 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| 新增并发、删除屏障及完整迁移回放 | 16 | 0 | 0 |
| API 保留、删除、M4、处理计划及旧工作回归 | 56 | 0 | 3 |
| API 非生产通道及材料解析准入回归 | 4 | 0 | 0 |
| Worker membership、身份、超时恢复、复核重组及 M4 回归 | 33 | 0 | 1 |
| 契约 OCR / 发行人绑定单元 | 40 | 0 | 0 |

采用计数共 **149 pass / 0 fail / 4 skip**，测试总数 153。四个 skip 为未配置 Azurite 的用户删除整旅程、storage pin/retry/orphan、dump/restore/Blob-copy/replay 及 worker M4 完整交付/计量；它们没有通过复验。membership 的 opt-in 在最终环境中明确设为 1，已实际运行。契约 examples 和 data-lifecycle 校验另外通过，不与 40 项测试相加。

最终 API/worker 构建通过。先构建、再冻结、再运行最终集合；不声称构建都位于冻结区间内。前后 **2,432** 个源、编译输出、Python、skills/知识及配置逐字节相同，snapshot SHA-256 为 `76eb628499113d6da6cb24770b205c781b867bbb4cae3cf9145de9a27bfacd57`。本轮 10 个源/测试/迁移文件另外按 Git 实际过滤后的 index bytes 校验；准确范围以 snapshot 与 sources proof 为准。

本地 Node.js 为 24.22.1，专用 PostgreSQL 为 16.14，cluster 为 `.local/report-postgres/data`、loopback 15540、用户 `bb_report_test`、模板 `bb_execution_report_template_20261027`。最终明列表审计只保留原 `0027` migration seed，material/upload/tombstone/start 等被审计表无测试行，没有 test clone 或其他客户端。核对本次直接启动的准确 PID **45368** 及启动时间 `2026-10-26T21:39:48.937Z` 后停止，确认 PID 文件已不存在；未复用上一轮 PID。

最终源及夹具经独立只读复核。采用轮次、原始日志、失败、重跑、环境和停止证据见 [summary.json](summary.json)、[selection.json](selection.json)、[raw-files.json](raw-files.json) 及 [manifest.json](manifest.json)；10 项准确暂存证明见 [sources.json](sources.json)。压缩副本逐项核对原始 SHA-256，冻结前通过和失败均不叠加到采用计数。

## 后续部署与未完成范围

将来部署须先停止**全部旧 storage workers**，确认它们不能再发新 claim，再排空 claimed tombstone 并安装迁移及新 worker。只检查某一时刻 claimed 为零不足以证明旧进程已停止。安装采用 NOWAIT 锁，繁忙时失败并在排空后重试，不与旧 purger 混跑。本轮没有执行上述生产步骤。

本切片没有修复项目业务正文清理、所有历史 purge receipt 的正文覆盖或跨项目正文清理边界。活动项目业务正文仍应遵守 `until_user_deletes`，不能因普通运行日志到期删除。完整补料采用、后继执行/增量处理、新 Word 的桌面旅程及追加报价/账务仍须完成，不以本次测试数量换算旅程覆盖率。

没有真实供应商、Azure/Azurite、支付、客户材料、浏览器或 Word/WPS 专业/视觉验收。外部 runtime/dependency 不在源码冻结范围；数据库审计范围以 verifier 明列表为准。
