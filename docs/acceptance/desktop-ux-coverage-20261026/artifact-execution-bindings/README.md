# 成果绑定准确执行来源（2026-10-26）

起点 `64e41994`；分支 `codex/desktop-ux-coverage-20261026`。本增量为 G03 / UX-A03 同任务补料续做建立成果来源边界。**完整 goal 仍 active，G03 未完成。** 用户已选必要重做单独报价并确认，具体公式仍未确定；本次未实施费用规则、V2 采用或后继调用。

## 改动与实际验证

- 新增迁移 `0125_artifact_execution_bindings.sql`：全部 artifact 状态及业务版本绑定完整 owner/project/run/execution/input 身份和原创建时间；历史不静默漏行，真实 Word/PDF/M4 文本 INSERT 同事务桥接。绑定和核心文件身份不可变，交付/质量/证据仍可推进与撤销。
- 严格 V1 view 接入历史、下载、项目文件/募集书、复核、助手、M4 及 Worker 原成果读取。共享字节门和 Word/PDF promoter 核对准确身份；结算保留原 artifact 行锁，通过 EXISTS 验证来源。上传与离线回存的独立 runless 文件版本沿用原行为。
- 实际 PG 测试验证多业务版本、全部状态、真实 promoter、完整身份/时间/V2 拒绝、原写入原子回滚、历史回填和实际锁竞争。HTTP 测试核对可下载字节；私有 clone 中人为移除来源后，旧 grant/新 grant/history 均拒绝且不读取 Blob。Worker 真实 unifiedInputGate 也验证准确 previous_output 可用、错误 pin/缺失来源拒绝，旧任务、积分和字节保留。

## 采用的运行结果

每项为独立调用，互有重叠，**不相加为全量通过数或 UX 覆盖率**。准确命令、环境、时间、退出码和跳过标题见 [summary.json](summary.json) 及原始 receipts/logs。

| 集合 | pass | fail | skip | 采用记录 |
| --- | ---: | ---: | ---: | --- |
| API 成果来源/准确执行身份 | 26 | 0 | 0 | api-focused-1 |
| API 实际消费者 | 89 | 0 | 2 | api-consumers-1 |
| API 交付及既有计费 | 13 | 0 | 1 | api-delivery-1 |
| Worker 定向单元 | 62 | 0 | 2 | worker-unit-1 |
| Worker PG / 登记 / 恢复 | 38 | 0 | 4 | worker-pg-1 |
| 新 Worker 来源测试最终修正复验 | 1 | 0 | 0 | worker-source |

API/Worker 构建及契约检查通过。空库实际回放迁移 0001..0125。环境为 Windows、Node 24.22.1、PostgreSQL 16.14；测试进程清除继承 BB/provider/Azure/数据库配置，未全局开启 runtime，receipt 中 BB_RUN_RUNTIME_ENABLED 为 null。review dynamic 测试显式开启已有 synthetic queue。

9 个跳过分别是 7 个需要未配置 Azurite 的 API/Worker 集合和 2 个 Windows symlink 用例；具体标题逐条保留，不计通过。没有运行本增量的浏览器旅程、真实模型、Azure、支付或 Word/WPS 排版验收。所用材料/Word 为 synthetic，私有字节替身与真实 PG、生产 promoter/reader 区分记录。上一增量失败的完整 API 探索仍保留在原目录，本次定向回归不将其改写为通过。

## 失败、修正和源码绑定

初轮 API 消费者为 88 pass/1 fail/2 skip：历史回调未携带 owner/project/run，新的共享来源门正确拒绝了缺身份对象；已修正生产回调，整组复验通过。API delivery 为 11 pass/2 fail/1 skip：Word SQL mock 只识别旧表；review dynamic 测试未显式开启合成队列，环境默认 runtime 关闭导致 pause 被拒。修正测试前提，生产 gate 和计价保持；整组复验通过。Worker 单元初轮 61 pass/1 fail/2 skip，原因也是旧表名 mock，整组复验通过。初轮日志、非零退出码及空 sandbox initdb 失败均原样保留；随后 elevated initdb 成功，不将初始部分回执当最终完成证据。

广测前后 1,670 个 src/dist/contracts/migration/package 文件哈希相同。新 Worker PG 测试产生单连接并发 query 的 pg 弃用提示，随后仅将该测试的 evidence 读取改为顺序查询；只改变该测试 src/编译 JS 两项，生产代码、断言和其他测试字节均未变化。最终再次构建 Worker、独立完整复跑该测试，before/after 1,670 项一致。首次冻结、广测冻结、最终冻结及每段差异全部保留，不能据最后 1/1 声称重跑所有组。

专用 PG 位于本轮私有 cluster、端口15527。最终模板 runs/executions/业务快照/artifacts/bindings 均为0，无测试 clone、无其他连接；按启动记录的准确 PID15772 停止，pg_ctl 返回已停且无 postmaster.pid。详见 records/pg-stop.json、pg-stop-command.json、pg-stopped-status.json。

原始日志按字节复制，目录 .gitattributes 禁止换行转换；manifest 对除自身外的全部文件记录长度和 SHA-256。归档含本轮 verify/collector 复现脚本，不含 PostgreSQL 数据目录或生成的客户文件；路径是当时本机复现环境。

## 复现与剩余边界

构建 contracts/API/Worker，并在空的已迁移私有模板上设置 BB_TEST_DATABASE_URL。准确测试文件列表在每个 receipt 的 args 中；新来源证明可单独运行 `node --test apps/worker/dist/artifact-execution-source.pg.test.js`。隔离 helper 每个集合创建并删除独立 clone，故障注入仅在这些 clone；migration replay/锁测试同样私有隔离。本机脚本见 [reproduce/verify.mjs](reproduce/verify.mjs)，原始证据核验见 [reproduce/collect.mjs](reproduce/collect.mjs)。

当前只允许 V1。按 run 唯一的报告/业务成果登记、输出 ID、stage/pair 当前投影仍须追加执行版本关系，之后才能受控采用新材料、增量复用旧工作、报价确认与账务、新版 Word 和完整桌面旅程。没有 push、PR、部署；该增量不能关闭 G03 或完整 UX goal。
