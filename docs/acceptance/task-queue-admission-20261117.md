# 多任务排队修复验收

状态：开发与自测完成；代码完成，尚未部署，待统一发布。未提供统一本地用户验收版，用户尚未验收。

补充：后续已执行[全任务类型真实模型验收](task-queue-alltypes-20261117.md)。该轮存在问答和差异复核失败及独立缺陷，不能按全类型成功交付验收通过；下文 158 项仍是先前合成回归结果。

固定基线：develop `3516b7ac7b0a4fa59f135b6b012d062b185ec04e`；工作分支 `fix/1542-queued-task-admission`。关联 #1542；#1543 的 worker 重试屏障及 #1441 的同目标输入指针问题不在本次修复范围。

## 行为

- 多项独立更新进入既有持久队列。旧个人 2 / 全站 4 活动任务限制退休；遗留环境值、注入配置不能重新启用它们。保留紧急停用、账户 deny、认证、输入校验及原计费合同。
- 领取优先考虑账户已有的任务和助手租约数量，再按提交时间和 ID 排序。短事务调度锁使并发领取基于已提交的租约计数；不抢占正在执行的任务。节点槽和共享模型许可继续限制实际执行，过期租约不会被计数逻辑直接删除。
- 共用来源的不同目标可独立执行、暂停和恢复。来源归属、可用性、准确材料版本及已有同目标写入保护保留；冻结批次仍遵守 8 项窗口与子任务身份校验。既有 M4 来源元数据短锁仍可能在保存冲突时要求重试。
- 旧额度拒绝保留审计且可按原请求键重试；不能用同一键换输入。重复请求不新建 run 或重复预留。排队、等待模型许可不计入执行收费；取消按原合同释放预留或结束未扣费合同。

## 验证环境与边界

专用 Docker 网络 `bb-task-queue-test-20261117`（无公开端口）、PostgreSQL 16 独立空库、Azurite 独立存储、Node 22.23.3、TypeScript 5.9.3。模板库 `queue_test_lf` 已执行完整 194 份迁移，测试文件自行克隆、销毁数据库。仅合成用户、输入、存储和子进程；没有生产连接、客户原件或模型供应商调用。

API 测试使用真实 Fastify 路由、PostgreSQL、计费台账与队列；内存 blob / Azurite 和合成模型结果的边界已在测试中标注。八槽测试运行真实 Node 子进程，验证 250 文件冻结批次中的 8 个任务同时持有 8 个不同节点槽，交付 16 个合成 Word，完成后 holder 为 0 且取得正向退出证明。它不验证真实模型生成质量。

依赖下载遇到公共源 TLS 故障，复用了本机已有 Linux worker 镜像中的运行依赖及已有 TypeScript/类型声明缓存。关键版本与锁文件核对：pg 8.23.0、fastify 5.12.5、@azure/storage-blob 12.33.0、@sinclair/typebox 0.34.52、TypeScript 5.9.3、@types/node 22.20.3。package-lock.json 和第三方依赖均未改变。

Windows 绑定盘引起读取超时后，将同一源码与资源复制到 Linux 容器构建。managed 退出测试单独以测试 runner 作为容器主进程执行，避免常驻进程或其他测试被正确计入存活进程证明。无密码合成角色仅在专用测试子网允许连接。历史测试补齐现行审计材料要求、最新输入版本指针和显式历史计费开关；没有降低生产校验或修改计费规则。

## 验证结果

依赖包 contracts、domain、rule-pack-registry、rule-applicability-context 及 API、worker TypeScript 构建通过。完整迁移链 194/194 通过。以下为相关回归，各测试以最终有效复验结果计数，不代表全仓测试或用户验收。

| 测试 | 通过 | 覆盖 |
| --- | ---: | --- |
| contracts `dist/*.test.js` | 72 | 兼容 DTO 与契约 |
| `automatic-billing.pg.test.js` | 6 | 自动报价、余额不足无预留、请求竞争、原报价和重试 |
| `execute-quota-billing.pg.test.js` | 2 | 当前自动计价与历史进度计费各 12 项同来源独立更新；真实上传、报价、并发接收、唯一预留、重放、暂停续跑、取消及不可变输入 |
| `task-queue-scheduling.pg.test.js` | 2 | 账户公平领取、8 次并发领取唯一、同来源多目标、暂停隔离、同目标保护、批次助手及跨用户隔离 |
| `zz_trial_guard.test.js` | 13 | 旧配置退休、旧拒绝同键重试与输入不可换绑、账户 deny、紧急开关、用量审计及健康告警 |
| `m4-workspace.pg.test.js` | 7 | 交接、独立目标并行、同目标冲突、不可变来源、保留/回收和原计费行为 |
| `model-call-budget.pg.test.js` | 6 | 共享许可有界、公平等待、进程退出证明与连接故障 |
| `review-assistant.test.js` + `review-assistant-linked.test.js` | 28 | 助手跨账户公平领取、会话顺序、幂等、未知结果及权限边界 |
| `execution-node-eight.pg.test.js` + `managed-run-recovery.pg.test.js` | 11 | 真实八槽进程、成果落库、退出证明、受限运行角色及安全恢复 |
| `model-capacity-billing.pg.test.js` | 11 | 更新/生成/复核等待不扣费；取消、暂停、租约替换、SIGKILL、进程内等待及迟到清理 |

上述相关测试按最终有效结果去重汇总：158 通过、0 失败、0 跳过。契约示例另有 179 份 synthetic + 12 份内部库示例，以及 4 份数据生命周期示例通过。

运行方式：设置专用 `BB_TEST_DATABASE_URL`，trial suite 另设 `BB_TEST_AZURITE_CONNECTION_STRING`；依次构建依赖包、API、worker 后，对表内编译文件运行 `node --test --test-concurrency=1 ...`。managed 进程测试在单独 PID namespace 执行。M4 交接与更新等待计费夹具修正后分别使用 `--test-name-pattern='synthetic M4 handoff'`、`--test-name-pattern='^update:'` 定向复验；不重复计算同一测试。

详细本机日志在该工作区 `work/task-queue-tests/`，包括初次环境/旧夹具失败和定向复验，未将失败的尝试记为通过。最终有效结果见 `contracts.tap`、`api-final.tap` 中自动计价和队列两组、`api-rerun.tap`、`m4-handoff-final2.tap`、`worker-final.tap` 中模型预算与助手组、`worker-native-final.tap`、`model-wait-billing.tap` 和 `final-boundaries.tap`。

## 发布依赖与待办

新增 `0191_task_target_execution_mutex.sql`；无新第三方依赖。迁移、API 目标互斥调整和 worker 领取逻辑应一起进入固定候选版本。旧容量变量可留存但被忽略，不需要为本次变更修改生产配置。

旧源码会继续应用原限制，不能仅应用迁移就宣称修复。已接收任务、历史拒绝、计费合同及成果均保留；回退不能删除排队任务或按 TTL 清除租约/holder。发布前核验每个实际 API/worker 组件版本，不能用主站 bundle 代替节点已生效证据。

最终统一验收待办：集成 chat 将本 PR 纳入固定本地版本，用户通过网页提交两个或更多同来源独立募集书更新，验证各自排队/进度/取消、积分与成果隔离，再由指定发布 chat 按既有授权统一上线并核验。开发 chat 没有生产部署、迁移、重启或账务操作，也未自动向其他 chat 发消息。
