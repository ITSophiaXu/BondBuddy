# 执行键与项目列表回归夹具（#1109）

## 结果与边界

固定源码 `e7cd7f5724d036d61ee4ac29f8ef3e73c4a24de3`（tree `d7901f9384f10c09e88c272124595f1050527344`，基线 `867dbb22988a450cda05a004cdc2589ff68a7f9c`）的两个完整 API 文件 **3 pass / 0 fail / 0 skip**，12.809 秒；未修改的 billing-int64 / billing-wire **11 pass / 0 fail / 0 skip**，1.446 秒。4 个依赖包和定向 API 严格构建、独立迁移通过。

本任务是 type:task 回归夹具维护，不计为新增产品功能 Bug。代码完成，尚未部署，待统一发布；未进行用户验收。没有执行全量门禁、真实模型、浏览器、实际支付或生产环境。原 749 文件 gate 仍为 failed，不能由本次定向通过推断全量通过。

| 文件 | pass / fail / skip | 保留的目标 |
|---|---|---|
| execution-key.test.ts | 1 / 0 / 0 | 原 JS opaque / NUL / lone-surrogate 键、legacy 无报价 hash 重放、5 并发幂等、owner 隔离、outbox 原子回滚 |
| project-list.test.ts | 2 / 0 / 0 | 原列表搜索、游标分页、归档事务，以及真实运行状态、后续失败后保留之前 Word 与下载 |
| billing-int64.test.ts | 5 / 0 / 0 | 未改动的精确积分、冻结分配、null 与测量零 |
| billing-wire.test.ts | 6 / 0 / 0 | 未改动的当前 HTTP 字符串、非法数字拒绝、number-v1 重放与 schema |

## 夹具修复

共享 helper 与 #1084 / #1099 / #1105 的 Git blob 相同（`ae31c871b79d2f89467dffe3a49c769f795cfc36`）。通过真实合成 DOCX 上传、完成、采用、来源声明、锁输入和实际 credit-quote 准备现行前提，只补精确短缺的合成积分。没有默认开启历史计费，没有改生产定价、准入、迁移或测试 exclusions。

execution-key 使用拥有实际原稿字节的内存 Blob；legacy run 的初次重放仍使用原无 quote request_hash。普通新执行取得当前 quote。NUL、lone surrogate、replacement、rollback 各自通过正常 PATCH 项目名、重新锁同一源材料获得独立当前 scope 与 quote；同一 NUL 键 5 并发、读取与冲突请求保持同一原输入，普通键精确重放不换 quote。若 Unicode 键被错误混同，第二请求会因 hash 冲突而被原 202 断言捕获。跨 owner 请求明确使用该 owner 自己的输入版号与 quote。回滚场景在安装原 outbox trigger、读取 outboxBefore 之前完成所有范围/资金准备，失败重试复用同一请求。

此范围准备保留现代“同一已受理范围不可重复收费”的保护。静态初稿 d175abca 只反复取 quote，不适合当前规则；在任何运行之前发现并修正，未通过修改预期或计费规则放行。

project-list 第一个测试全文不变。第二个继续使用真实 Azurite 与原 skip，原 Word 仍为 primary/latest_artifact 和下载字节依据；另实际 promote 第二份 clean Word，二者通过实际持久化和回读后，经 checkpointStage 保存 pair 并正常 finish。完成后产品自动采用新稿，因此第二次真实 API execute 重新锁当前输入与报价，再用原失败结算和下载断言核对旧成果保留。

原 **81 条 assert 全部逐字、同序保留**；新增 12 条前提检查。3 个原测试名称、options/skip/timeout 不变；没有改变失败条件或性能阈值。双 Word 与重新锁输入的新增检查只确认场景确实到达目标前提。

## 证据来源与已有 PR

原门禁 `1794418350450-38278111` / `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2` 的 [execution-key 失败 TAP](api-admission-compatibility-20261112/original-execution-key.tap) 与 [project-list 失败 TAP](api-admission-compatibility-20261112/original-project-list.tap) 保留。两原文件在本轮基线中的 Git blob 与原 gate 相同；旧失败不是本轮重跑 red。

对 60 个开放 PR 按文件核对：#756 重叠 project-list 的旧终态 / accepted delivery 夹具，但没有补当前 source / quote，未采用其可选内存 Blob 或 skip 改动。#770 涉及其他 scope quotation 老功能，不覆盖本轮两文件。

[最终原 3 项 TAP](api-admission-compatibility-20261112/final-test.tap)、[未改 11 项协议边界 TAP](api-admission-compatibility-20261112/wire-boundaries.tap) 和 [proof.json](api-admission-compatibility-20261112/proof.json) 来自相同固定源码。proof 包含完整命令/耗时、原始与展示 TAP SHA-256、逐项 AST 对照、raw Git、依赖 lock、镜像及清理证明。展示日志仅去行尾空白和末尾多余空行；原始字节保留于本地证据目录。

## 环境与复现

- 缓存 runner、PostgreSQL 16 Alpine、Azurite 3.35.0 按不可变镜像 ID 启动，--pull never；未安装或升级依赖。
- Node v22.23.3、TypeScript 5.9.3、pg 8.23.0、Fastify 5.12.5；LANG / LC_ALL 均为 C.UTF-8。依赖 lock 只允许明确 LF / CRLF 等价，SHA-256 已记录。
- 6430 个跟踪文件全部逐一核对 raw Git blob。API 继承原严格 tsconfig，定向包含 4 测试、helper 和动态 upload-inspection-worker 入口。
- internal 网络，无发布端口；runner 2 CPU / 2304 MiB、PG 1 CPU / 512 MiB、Azurite 0.5 CPU / 256 MiB，总 3.5 CPU / 3 GiB。PG/Blob 为独立合成数据 tmpfs，不连接生产。
- runner --init，各阶段流式日志与独立进程组；外层有界 TERM→KILL 不改变原测试 timeout。完成后 clone 0、runner 只剩 init/sleep，按精确 ID 删除本任务三个容器与 internal 网络并复查不存在。

```sh
node db/migrate.mjs
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/billing-int64.test.js apps/api/dist/billing-wire.test.js
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/execution-key.test.js apps/api/dist/project-list.test.js
```

A54 在本轮交付后的证据计数为 11 文件精确源码定向通过 + 2 文件 #1053 候选覆盖证据 + 41 文件未纳入上述证据 = 54。issuer-identity-input-lock、non-production-test、project-kind-conversion 涉及明确旧输入/缺料/转换竞态契约，仍单独排查，不能用本次通用有效原稿夹具替换其原目标。
