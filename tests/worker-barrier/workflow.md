# Workflow 原生组件集成

`run-workflow.py` 复用仓库 `NativeDatabaseTests` 的一次性 PostgreSQL、host cgroup broker/runner、受保护 `runtime.js` 入口及其真实 enrollment context。业务容器保持 UID 1000、cap-drop ALL、no-new-privileges、只读根目录；只为 workspace/Word 输出配置 `/tmp` tmpfs，网络仅连接一次性内部 PostgreSQL。此入口不验证 systemd/AppArmor 的生产部署配置。

默认测试 `apps/worker/src/workflow-authoring.pg.test.ts`。模型命令是固定 synthetic JSON fixture，不访问供应商；真实业务代码仍执行 intent、usage journal、call cgroup、sealed capture、capacity release、checkpoint、phase handoff、Word writer 与 quality checker。私有对象存储用本地文件 fixture 执行实际字节写入、bounded readback 和 hash 检查；它不是 Azure/腾讯云存储联调。

默认五个场景：

1. direct：一个 journaled outline、两章各一批，commit 后 authoring 原 task empty proof 释放，新 postprocess token 执行真实 Word writer。空 Word 被真实 quality checker 拒绝，正常候选通过 quality；无正式 artifact 时 finish 仍拒绝成功。
2. 第一章 commit 后崩溃：新 token、重建 StageContext，仅执行未完成第二章，outline 与第一章不会重发。
3. intent commit 后崩溃、未发 native：未知调用不自动重发，A 进入 provider_reconcile；A 尚未释放时 B 可以真实领取并推进。
4. controlled DOCX：真实 inventory 两章各一批，固定 editor V2 编辑与 pending comments。第一章 commit 后删除本地工作目录，从持久化的完整 manifest/object/receipt graph 恢复第二章；handoff 后沿用可信 finalize 和 quality gate，最终 Word 保留两章 pending 批注。
5. 正向收费交付：隔离的一次性数据库中显式使用 `update` / `production` channel 和 synthetic 材料，真实 `inputLockStage`、材料原件加载、两章 controlled 编辑、handoff 与新 postprocess token。生产 `boundedPrivateBlobs` 启动固定磁盘 IO child；一次真实卡住且忽略 SIGTERM 的读取必须被 kill+join 才允许 retry / positive release。另在两份 Word promotion 后、pair checkpoint 前模拟进程中断，新 token 继续 quality / readback / promotion / 原账务 finish / positive release，最后为 `succeeded`。断言恢复未重发模型、artifact ID/hash 不变、只一份注册 pair、60 积分只结算一次、成功前仍冻结、最终无冻结。

这些是原生组件集成；第五个场景覆盖真实持久化输入 gate、收费成功结算和成功终态，但不是生产客户或真实模型验收。没有运行完整用户页面、云对象存储或云扩容。`fake-private-blob-io.mjs` 实际读写本地私有目录，connection string 字段仅装载该 synthetic 目录；不访问云服务。前四个组件场景显式取消清理，第五个场景必须真实成功，最终全部随一次性数据库清理。

先编译当前 packages、API、worker，再使用已存在的兼容 Linux 工具镜像。镜像须有 `/app` Node 22 依赖、`/opt/venv/bin/python` 及 python-docx/lxml 等仓库 Word 依赖、`/usr/bin/flock`。`postgres:16` 须已在同一 Linux Docker host 存在；运行过程不构建、拉取或发布镜像。

```sh
python3 tests/worker-barrier/run-workflow.py --image your-local-tools:tag --output /tmp/workflow-native.log
```

容器退出成功且 Node 报告 `# fail 0`、`# skipped 0` 才通过。默认注册全部子场景及顶层，实际计数以本轮原始输出为准。可用 `--case direct`、`--case controlled` 或 `--case delivery` 定位路径，不把未选场景统计为通过。组件样本必须带 ordinary unified 版本，持久化 context hash/input hash；每次 claim 前用实际进程 inventory 刷新节点心跳，不放宽生产的30秒心跳门限。

同一入口也支持原 `managed-run-recovery.pg.test.ts`：

```sh
python3 tests/worker-barrier/run-workflow.py --suite managed-recovery --image your-local-tools:tag --output /tmp/managed-recovery-native.log
```

该模式使用原 `task-cgroup-database-fixture.mjs`，不替换其业务断言，保留原受保护 argv、真实 `BB_SYNTHETIC_TASK_CGROUP_CONTEXT` 及 independent PG/cgroup，可与 workflow suite 独立运行。不要用普通 `node --test` 缺少 native context 的 skip 结果替代此验收。

候选保全的三条 runtime 回归使用独立进程，执行器身份不在同一进程内切换或重置：

```sh
python3 tests/worker-barrier/run-workflow.py --suite retention --image your-local-tools:tag --output /tmp/retention-native.log
```

入口固定运行 pending、unreadable、admission 三个 case，各取得新的真实 broker 容器和原生上下文、初始化 task 边界；每个 case 必须恰好一条 Node 测试且无失败或跳过。总计三条原断言，分别覆盖候选阻止安全停机、未知库存阻止 ready、心跳尚未刷新时本地阻止领取。`BB_RETENTION_NATIVE_CASE` 由 fixture 提供，未知值拒绝；普通 PostgreSQL 模式不能代替此验证。

需要排除 Windows `/mnt/c` 文件读取开销时，可将 PostgreSQL 测试复制到 Linux 临时目录再运行：

```sh
python3 tests/worker-barrier/run-workflow.py --suite demand --image your-local-tools:tag --output /tmp/demand-native.log
python3 tests/worker-barrier/run-workflow.py --suite postgres --test-file apps/api/dist/queue-renewal-locks.pg.test.js --test-file db/restore-safety.pg.test.mjs --image your-local-tools:tag --output /tmp/postgres-native.log
```

`demand` 原样运行 `execution-capacity-demand.pg.test.ts` 编译结果，保留原30秒子例预算，要求恰好一个测试且无失败/跳过。`postgres` 显式枚举文件；只接受仓库内 `apps/api/dist/`、`apps/worker/dist/` 的 `*.test.js` 和 `db/*.pg.test.mjs`，拒绝绝对路径、`..`、重复项及不存在的文件。API/worker/package 输出、Python、所需 fixture/模板、数据库与部署校验脚本复制到 Linux 私有临时目录；镜像中的 Node 依赖保持原样。

这两种模式使用真实 `node --test --test-concurrency=1`，保留各原测试自己的超时；使用同样的一次性内部 PostgreSQL，但不注册执行器、不设置 enrollment 或伪造 `NODE_TEST_CONTEXT`。需要 native cgroup 的测试仍使用 `workflow` / `managed-recovery` 模式。`postgres` 必须无失败、无跳过，文件与实际 Node 测试计数在验收报告中单独记录。
