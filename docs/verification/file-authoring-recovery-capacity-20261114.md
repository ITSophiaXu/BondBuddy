# 文件编制恢复文件数容量（#1342）

## 发现与范围

2026-11-14 13:28（北京时间）对冻结候选 dc7a836 的本地真实任务进行只读容量核对：input.json、scratch/ 和 output/ 共1271个普通文件，总198,808,977字节，最大单文件12,106,698字节；链接/非普通文件为0。文件数量超过旧1024上限，字节量仍低于总256 MiB、单文件100 MiB限制。这是容量不兼容的确定证据，当时未触发应用快照保存；不能称为已经观察到真实保存失败。

基于 #1341 的28adbdd3独立补修。在 packages/contracts 的 worker-runtime 唯一定义 FILE_AUTHORING_RECOVERY_LIMITS，文件数提高到4096；API元数据核验、worker保存和恢复均使用同一常量。单文件100 MiB、总256 MiB、路径/链接/完整性/身份/只读材料/租约检查不变，目录遍历仍受文件数关联预算限制，不使用无限量或部分快照恢复。

超数保存仍在写入新Blob前拒绝，不能发布部分检查点。已有有效快照和账务、原输入、unknown用量与恢复预算不因扩大容量重置。无迁移或依赖；API、worker与contracts需要同时集成。没有复制真实客户文件、回灌诊断副本或操作真实任务。

## 验证

合成规模回归生成1271个真实小文件，保存、回读、API元数据核验、授权恢复并逐个比对字节；再扩充到4096文件验证完整保存与恢复，4097时验证拒绝且不新增Blob或检查点。API直接验证4096接受、4097拒绝；单文件恰好100 MiB、总量恰好256 MiB接受，总量再增加1字节拒绝。4097元数据在恢复输入和恢复文件入口均被拒绝，不读取Blob或写入目标目录。既有路径、链接、大小、总量和损坏对象测试继续执行。该规模回归验证文件数量与完整性，不冒充198 MB真实工作区性能验收。

2026-11-14 完成最终代码自测：

- Windows / Node 22.14.0 顺序执行 `npm run build -w @bondbuddy/contracts`、`npm run build -w @bondbuddy/api`、`npm run build -w @bondbuddy/worker`，全部通过；API新增精确字节断言后再次编译通过，并确认最终编译产物含所有新增断言。
- `npm run check:contracts`：72 tests / 0 fail / 0 skip；179个synthetic样例、12个内部库样例和4个数据生命周期样例通过。
- Linux `NODE_ENV=test node --test --test-concurrency=1 apps/worker/dist/file-authoring-recovery.test.js apps/worker/dist/file-authoring-payload-recovery.pg.test.js apps/api/dist/file-authoring-recovery.test.js`：11 pass / 0 fail / 0 skip，2026-11-14 06:02:29 UTC完成。包含1271/4096/4097完整文件测试、恢复安全测试、两组实际PostgreSQL自动/手动恢复矩阵及API元数据边界。
- 使用独立PostgreSQL 16临时库、Docker内部网络、只读挂载最终编译文件；worker镜像固定 `sha256:2a1bbe5398f0c204cfedbf43789be0b04ba6093be67240d27e86c2a708a66741`，测试容器1.5CPU/2GiB、PG0.5CPU/768MiB，未连接真实数据库或任务。结束后清理专用容器和网络。测试使用synthetic数据，零真实模型调用。
- 原始manifest、最终测试hash、日志和结果保留于未提交的 `work/bb-timeout-1342-04509c1a-3ae`；构建与contracts日志保留于 `work/limits-*.log`。没有提交客户材料或运行目录。
- 独立代理只读审查无剩余可操作发现；`git diff --check`通过。没有重复渲染/Word或真实模型验收，此项只证明容量与恢复实现。

代码完成后交给主代理整合 #1302、#1339、#1341、#1342；冻结真实任务仍由主代理独立观察。开发和自测、真实任务终态、用户验收、部署分别记录。尚未部署，待统一发布。
