# 托管任务收尾与安全重试（#1459 / #1462）

日期：2026-11-16。开发基线：`652d4b86`。代码完成，尚未部署，待统一发布。

## 根因与修复边界

正式受限执行角色有 `bb_jobs.state` 的更新权限，但没有终态触发器隐式使用的 `bb_error_recovery_events` 写权限。0070 的函数原为 SECURITY INVOKER，连没有历史错误记录的终态更新也会报 42501，整个事务回滚。权限清单只列直接访问的表，遗漏了触发器依赖。

异常处理随后调用 `releaseLease`，只把租约设为过期；托管领取为了防止旧进程仍执行，排除仍带节点和 token 的任务。消费者正常返回 retry 后没有安全交接步骤，因此任务一直保留 running，可能继续占用项目互斥。时间过去不会解除这个条件。余额不是这条故障链的原因。

本次修复：

- 追加 `0189_terminal_recovery_audit.sql`。保留函数 owner、原审计语义与唯一约束；函数以 SECURITY DEFINER 执行，固定 `pg_catalog` 搜索路径、显式 `public` 表引用，限定只能用于原任务更新触发器，撤销 PUBLIC EXECUTE。消费者仍不能直接写审计表或挂接该函数到自建表。
- pipeline 返回 retry 前停止并等待最后一次续约。运行循环记录当前 lease 的完成回执，阻止新工作进入，等待所有执行槽、助手和探针完成，并扫描整个消费者 PID namespace。活跃或被 init 收养的浏览器进程、读取失败、当前 session 的模型 holder/waiter 均阻止交接。
- 交接按 node → run → job 锁序检查原 node/epoch/session/token，再清除该 token 并原子记录 queued 事件。用户暂停、积分暂停和未知供应商结果进入原有暂停状态；不会自动重投未知调用。检查点、输入和调用日志保留，旧 token 失效。
- 诚信浏览器私有批次增加阶段、错误类别、已知 errno、允许的代码帧和指纹。不保存原始错误消息、路径、网址、命令、查询文本或凭据。既有公开错误码和 DTO 不变。

没有移除领取防重条件，没有增加按 TTL 清锁的扫描器。新进程不能继承旧 session 的本地完成回执；崩溃、未知原生进程、数据库持续不可写等情况仍须保留隔离和既有节点恢复流程。本次不证明所有网站都可查询；早先 CDP 异常由 #1449 跟踪，之后通用浏览器错误的细分原因不能从缺失日志中补推。

## 自动化验证

Linux Docker、Node 22.23.2、TypeScript 5.9.3、PostgreSQL 16。数据库独立、只连本地回环，无生产数据或供应商调用。迁移副本规范化为 LF，以满足既有 0180/0186 的精确函数文本检查；未修改仓库历史迁移。

构建：contracts、domain、rule-pack-registry、rule-applicability-context、worker、API 均通过 TypeScript 编译。API 与 worker 测试互相导入声明，验证时 worker 生成声明，API 输出到临时目录再回填，避免对输入声明的 TS5055 覆写。

定向回归：**34 pass / 0 fail / 0 skip**。

共享契约检查：**72 pass / 0 fail / 0 skip**（32 个基础用例、29 个 OCR v2 用例、11 个主体绑定用例），另通过 179 个公开合成示例、12 个内部参考库示例及 4 个生命周期示例。首次运行因测试镜像未复制原型 `project-fields.js` 停在示例检查；补齐同基线原型源码后，从该步骤继续完成全部剩余检查。

```sh
node --test --test-concurrency=1 \
  apps/worker/dist/managed-run-recovery.pg.test.js \
  apps/worker/dist/managed-run-retries.test.js \
  apps/worker/dist/run-lease-heartbeat.test.js \
  apps/worker/dist/integrity-collection.test.js \
  apps/worker/dist/integrity-browser-boundary.test.js \
  apps/api/dist/queue-renewal-locks.pg.test.js
```

这组测试须以 Node 作为独立测试容器的入口运行，不能在有额外 `sleep infinity` 进程的容器内 exec 后冒充“没有其他进程”。实际运行了双槽 WorkerRuntime、真实 PG 领取/收尾、孤儿进程检查、异步 CDP rejection，以及持锁超过租约期限的续约竞争。两槽测试证明同进程尚有工作时不交接，随后重试三次进入失败终态。

受限角色使用 `apps/worker/src/fixtures/managed-runtime-acl.json`，为生产只读导出的表/列权限结构，已去除角色身份及业务数据；不是新的角色初始化策略。覆盖空历史的五种终态、三种恢复审计结果、重复终态、临时表搜索路径干扰、直接伪造被拒、未知供应商调用、并发领取唯一 token、旧 token 失效、holder/waiter 阻止释放、用户暂停保留。成功类 SQL 状态测试不冒充真实 Word 交付验收。

当前完整 develop 已包含 0182 的模型等待计时，而旧部署 overlay 的权限清单没有该表。测试保留旧 ACL 原样，并显式应用 `deploy/m1/security/managed-model-activity-grants.sql` 的最小差额：该表 SELECT/DELETE、六个 INSERT 列及两个 UPDATE 列。没有用 owner 运行被测消费者，也没有授予审计表写权限。

扩展回归（queue-renewal-locks、execution-node-capacity、execution-node-drain-runtime、runtime-isolation、runtime-entry）：修复版和恢复为未修改 `652d4b86` 源码的对照版均为 **14 pass / 5 fail / 1 skip**，同一隔离测试环境、同一迁移模板。失败发生在既有前置：镜像缺 `/etc/machine-id`、旧云节点 fixture 没有 Run acceptance/creation proof、旧隔离 fixture 提交空项目材料触发 INPUT_REQUIRED；runtime-entry 的 Azurite 场景未配置而跳过。对照替换了本次修改的原有运行模块，数据库保留新增审计函数（这些旧测试用数据库 owner，失败发生在审计路径之前）。这些结果不能写成全仓库通过，也不构成生产发布凭据。

## 统一发布依赖及最终验收待办

1. 在获授权发布窗口按固定集成版本执行新增迁移 0189。既有审计函数的 owner 必须保持可信并有表权限；运行身份不改为 owner。代码回滚可保留新审计函数，勿重新引入 INVOKER 缺权。
2. 如果使用完整 develop worker，0182 的表与上述最小差额授权也必须到位；发布人员逐一核对实际编制/复核角色后传入 `runtime_role`。脚本本轮只在隔离测试库执行。
3. 同一固定版本完整构建 API 和 worker。worker 包内必须同时包含 `managed-run-retries.js`、`runtime.js`、`execution-node-runtime.js`、`run-pipeline.js`、`run-lease-heartbeat.js`，以及其使用的 API `queue.js`、`execution-capacity.js` 和浏览器三个模块。正式 Dockerfile 完整复制编译包；现有腾讯业务 overlay 的固定文件清单不包含新模块，且不允许覆盖 queue，不能只替换 runtime.js 或修改旧不可变包的 hash。
4. 在准确待发布镜像、实际角色和完整依赖下复验领取、失败/成功收尾、恢复、审计和排队推进；完成统一真实模型/成果门禁及用户验收。浏览器新私有诊断须验证实际持久化且不进入公开 DTO。
5. 已卡住的旧任务不能按租约过期直接清锁。由发布/运维流程核对旧节点 epoch 停止证明、供应商调用及持久化结果后安全恢复或收尾，并确认原任务进展和其后排队工作实际启动。本开发任务未恢复/取消生产任务，也未更改账户或账务。

状态分别为：开发与定向自测完成；尚未提供统一本地用户验收版；用户未验收；未部署。外部网站可用性、准确生产镜像与原任务恢复属于最终统一验收待办。
