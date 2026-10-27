# 补料草稿与私有已保存工作引用

2026-10-26；基于 `27718689` 的本地增量，未推送或部署。完整 UX goal / G03 **active、未完成**。

## 实际行为

安全人工暂停后保存补料草稿，会在原 run→job 锁、无租约、无未核对调用的同一事务中冻结原 checkpoint 和准确已完成模型结果引用。原输入、job、调用结果、项目草稿和原消费不变。每条结果须与 checkpoint 中唯一的 attempt/result/schema/hash 引用完全一致，不能从“最新结果”猜测或补全缺损 checkpoint。重复请求返回同一回执，不产生第二份捕获；不同草稿 revision 各自保留自己的暂停工作。

公共 `saved_work` 契约仅返回 `not_captured / captured / stale_boundary` 和 stage/result 计数；不返回模型正文、object key、私有文件或下载 grant。旧回执没有捕获时如实显示未记录，不通过回填猜测旧暂停时已有工作。当前 checkpoint 变化时显示需重新保存；页面允许材料选择不变时明确再保存。未保存、本机编辑、上传未确认、保存回执未知或冲突时不展示旧的确认状态。

`captured` 只说明引用元数据已冻结，不代表文件字节已检查、能直接复用、得到长期保留或已进入新输入执行。清理、删除账号和项目继续遵守原规则，草稿独有材料没有新增永久保留。恢复同一已保存结果而未产生新 checkpoint，仍是同一已捕获工作；job 的阶段变化本身不伪报为新工作。

## 不可变来源与读取

- 迁移 `0120_model_call_execution_bindings.sql` 将真实 prompted attempt 绑定准确 owner/project/run/job、execution/input 和 prompt。历史调用只有已存在的完整准确元数据才能回填；无 prompt 或元数据不完整的旧调用不被补造来源。数据库仍只允许 V1。
- 真实 provider latest、结果重放、runtime 和 observation 均核验该绑定。先读取已有 attempt，再验证其来源；缺绑定不能被过滤成“没有旧调用”而触发重发。
- 迁移 `0121_run_supplement_saved_work.sql` 追加不可变 checkpoint 与结果引用表，绑定原准备回执及准确输入。没有改写既有迁移、调用、输入、账本或旧回执。
- 内服 `readCapturedSupplementResult()` 要求准确回执/result ID 和期望 schema，核验归属、原输入、完成调用、结果及 prompt 清理记录，再 bounded 读取和验证准确 JSON 字节。它不公开下载，也不更改 reconciliation、暂停状态或账单。
- 读取在独立事务中先取 prompt_snapshot→provider_result 内容锁，等待后重查可见性，并覆盖 Blob I/O 和异步 schema 校验。真实内容清理使用相同锁，不能在读取校验期间清除来源，或在清除已胜出的情况下返回旧结果。

新旧回执仍只是补料准备，没有采用、后继业务快照、V2、追加报价确认或扣费。它没有把暂停中的私有旧工作塞入仅接受成功成果的 `previous_output`，也没有放宽公开成果下载门。

## 验证

最终计数和所采用轮次由 [verification-summary.json](records/verification-summary.json) 记录；重复通过不累计为新的旅程或覆盖率。首轮失败和修正保留在原始记录中。

| 最终验证 | 结果 |
| --- | --- |
| contracts / API / worker / web 构建与 web TypeScript | 通过 |
| 契约样例 | 184 synthetic + 12 internal library |
| API / PostgreSQL | 121 通过，1 既有跳过 |
| worker | 64 通过，3 既有跳过 |
| main / 组件 UI / 在途专项 | 7 / 20 / 1 通过，无失败、重试成功或跳过 |
| 内容清理并发专项 | 4 通过，已包含在 API 计数内 |
| 升级回归 | 15 项断言，206 张旧表逐行不变 |

最终验证前后 2,028 个源码、构建、测试和迁移文件 hash 一致。4 项跳过来自既有 Azurite queue、M4 与 legacy unified pipeline 环境案例及 Windows 不支持的 Linux symlink 案例；本轮新来源、捕获、读取和内容清理并发测试没有跳过。

迁移升级使用自己创建且验证名称、owner、OID 的独立 clone，恢复到 0119 的结构后植入准确历史调用、同 hash 不同 revision 的 prompt、缺输入元数据的 prompt、无 prompt 调用、旧准备回执、私有结果引用及非空积分账本。应用原 0120/0121 SQL 后，15 项断言通过，206 张旧业务表逐行不变，仅准确来源被回填；旧回执没有被捏造工作引用，V2 和错误新意图继续拒绝。该 clone 已清理，模板数据没有修改。见 [升级结果](records/migration-upgrade-1.json)。

API/PG 验证实际 HTTP session/CSRF、真实 claim/prompt/call observation、安全暂停、保存回执和只读结果字节。覆盖八类错误 checkpoint 的整事务回滚、幂等与独立 revision、历史回执、async schema、hash/size/缺字节、错误归属及两类 purge tombstone，确认原调用、用量、输入、事件、账本和字节不因读取改变。

并发验证通过 `pg_stat_activity` 和 `pg_blocking_pids` 观察真实锁等待：prompt 清理等待读取、provider result 清理等待读取，以及清理先持 prompt 锁时读取等待，清理提交后拒绝且不读结果字节。没有用固定 sleep 推断成功。

桌面验证沿现有 main 和任务面板，含 M1/M3/M4、回执未知、刷新、双 context CAS、旧工作过期及明确重新保存。在途专项使用受控本地 Node adapter、真实 worker journal 和本地私有合成字节，证明当前调用保存后暂停、草稿冻结准确原结果且原输入恢复只调用一次；不代表供应商、Azure、后继业务生成或新版 Word 验收。浏览器视口为 1440×960，另含整页截图，来源是合成账号与材料。

## 失败记录与环境

首轮 API TypeScript 在新增测试的可选 schema 参数和 UUID 推断类型处失败；修正测试类型，并明确要求期望 schema。首轮 API 专项四条新测试因 fixture 的 redaction version 使用连字符、不满足原有命名规则而失败；改为合法 `synthetic_v1`，原校验未放宽。其余首轮结果保留。

在途专项新增断言最初误以为“后续阶段暂停”必然改变保存工作，实际该阶段没有保存新 checkpoint。测试改为明确要求完整 checkpoint 与原暂停完全相同，准确回执继续为 `captured`；真实进度变化的 `stale_boundary` 另由 PG 和 UI 正反例覆盖。没有修改生产逻辑来满足错误断言。

专用 PostgreSQL 16.14 使用既有 `127.0.0.1:15526` 空模板及隔离测试 clone。`pg_ctl start` 首次因 Windows restricted-token 错误 87 失败，随后按原 cluster 路径隐藏启动 postgres 并验证数据库身份。真实 main 用 5198；组件测试用自己启动的 Vite 5199，均关闭自身服务，没有操作共享 5173。数据库最终状态和停止证据见 `records/`。Vite 保留原大 chunk 提示。

最终模板为 0 run / 0 execution，全部 `bb_g03_*` 数据库仅剩原专用模板，无其他客户端连接。按已核验的 cluster 绝对路径和端口停止 PostgreSQL，`pg_ctl stop` 为 0，随后 status 为 3（无运行服务）。见 [数据库清理核对](records/database-cleanup-audit.json) 和 [停止记录](records/postgres-stop.json)。

## 复现与剩余工作

`reproduce/verify.mjs` 先清理继承的 BB_/数据库/Azure/OpenAI/DeepSeek 配置，仅使用上述专用模板和本机登记 Python。从仓库根先运行 `migrate`，再 `contracts-build` → `api-build` → `worker-build`，并执行 `web-tsc`、`web-build`、`contracts-check`、`api-test`、`worker-test`、`browser-real`、`browser-ui`、`inflight-test`。main 和 inflight 分为两个 Playwright 进程，避免复用已经关闭的隔离 clone。升级验证由 `reproduce/migration-upgrade.mjs` 单独创建和清理自己的 clone。集群需由操作者先按专用路径启动，不连接真实用户数据库。

证据为 synthetic；`records/` 保存编号日志、命令、退出码、升级和源文件 hash，`browser/` 保存截图与合成断言，内容清单见 [manifest.json](manifest.json)。私有字节目录、生成 Word 和客户原件不提交。

用户已选 B：必要重做另行报价，确认追加金额后继续；具体公式仍未确定。除此以外，仍需正式采用 CAS/幂等回执、后继执行和业务快照、版本化 checkpoint 与新逻辑调用、准确旧 Word 文件引用及实际增量处理、成果/下载/文件族来源、材料保留和授权、累计账务及正确新版 Word。当前原始输出文件生命周期也需随新引用完善，不能凭 JSON 已保留推导所有嵌套文件已妥善管理。G03 不关闭，不据本轮计数声称整体 ≥90% 或主要功能 100%。
