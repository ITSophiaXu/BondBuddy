# Worker 队列与 provider 回归前提修复（#1125）

原四文件在创建 authoring run 时被现行 INPUT_REQUIRED 提前拒绝，尚未进入 provider journal、reconciliation 或队列隔离检查。本次只补齐正常来源文件、锁定输入及当前真实报价；原机制断言继续执行。

基线：`867dbb22988a450cda05a004cdc2589ff68a7f9c`。受测源码：`aaf4acd89f9a7a86f5111b66656c955891fdf30d`；tree：`2b232a52fa11bfab6a260afcedc4b4b58b68c120`。实测后只增加本验收材料，无源码变化。

## 改动范围

- 仅四个 worker 测试与共享 test-authoring-source.ts；helper 精确复用既有已验证 blob `ae31c871b79d2f89467dffe3a49c769f795cfc36`，没有增加 helper 行为。
- 原 157 条 assert 逐字、同序保留，新增 4 条只确认每个夹具仍使用第一个锁定输入版本。7 项原名称、skip、timeout 不变；两个 runtime 配置测试与 readiness 测试全文不变。
- Codex durable 保留真实 Azurite、原 fake Codex CLI、400 ms 模型超时及恢复语义。reconcile 旧 Azure 对象原本不读写 Blob，为新上传前提提供自有内存字节。两个调度夹具同样给 API 提供自有 Blob，WorkerRuntime 原 options 与 synthetic stages 不变。
- 仅为这四个机制测试按实际 quote 补合成缺口；没有修改生产入口、计价、迁移，未推广至刻意空材料、身份 pin、无计费事件或旧价格测试。

## 完整原测试结果

| 文件 | 原 gate | 本次通过 | 本次耗时 |
|---|---|---|---|
| codex-durable.test.ts | 0 pass / 1 fail | 1/1，0 fail / 0 skip | 7.797 秒 |
| reconcile-run.test.ts | 0 pass / 1 fail | 1/1，0 fail / 0 skip | 6.453 秒 |
| runtime-interactive-slots.pg.test.ts | 1 pass / 1 fail | 2/2，0 fail / 0 skip | 6.014 秒 |
| runtime-isolation.test.ts | 2 pass / 1 fail | 3/3，0 fail / 0 skip | 6.950 秒 |

合计 **7 pass / 0 fail / 0 skip**，四次完整文件进程耗时合计 27.214 秒。未使用 test-name-pattern；原租约、幂等、调度隔离、零模型调用、durable attempts 与 outbox 断言保留。

## 验证与边界

1. 容器核验 6,430 个 raw Git 文件；依赖锁仅允许换行差异；本地与容器 AST 审计一致。
2. 严格构建 contracts、domain、rule-pack-registry、rule-applicability-context。API 构建全部生产源码并排除无关测试；worker 构建四目标测试及其传递依赖，继承 strict，noEmitOnError=true。
3. 专属 PostgreSQL 迁移与按文件 clone，真实 Azurite；完整运行四个 node --test 文件。fake CLI 不调用真实模型，调度场景使用原 synthetic stages；不代表真实模型输出质量验证。
4. 使用内部子网，无发布端口；runner 2 CPU / 2304 MiB，PG 1 CPU / 512 MiB，Azurite 0.5 CPU / 256 MiB。首个网络创建因 Docker 默认池耗尽失败，未创建容器或执行测试；核实无冲突后使用显式 10.238.112.0/24，未改动其他网络。
5. 最终数据库 clone 为 0；runner 仅剩 init/sleep 后按精确 ID 删除三个容器与本次网络，并回查不存在。

原 gate 失败日志与本次完整 TAP 均保留；显示副本仅处理换行和行尾空白，raw hash 见 proof.json。本次只提供这四文件的精确源码定向证据。A54 现为 15 文件精确通过 + 2 文件 #1053 候选覆盖证据 + 37 文件未纳入上述证据 = 54；原 749 文件 gate 仍 failed。

这是 type:task 测试维护，不计新增产品 Bug。代码和定向验证完成，未合并、未部署，用户未验收。
