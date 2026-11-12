# 年度订阅持久拒绝测试维护（#1115）

固定源码 `f4c1cef06993d1bcc7f580e7d500fe7a844b7afe`（tree `a37c2f5a837a5723034aa7060674fd50ead564bf`，基线 `867dbb22988a450cda05a004cdc2589ff68a7f9c`）完整年度订阅文件 **9 pass / 0 fail / 0 skip**，5.445 秒；未修改的 subscriptions.pg 文件 **13 pass / 0 fail / 0 skip**，3.384 秒。四个依赖包和定向 API 严格构建、独立迁移通过。

本任务是原全量 gate 的 S 类旧契约测试维护（type:task），不计新增产品 Bug。代码完成，尚未部署，待统一发布；用户未验收。本次没有执行全量门禁、真实模型、浏览器、实际支付或生产环境；原 749 文件 gate 仍 failed。

## 改动与契约

旧第六子测试期待 PAYMENT_INVALID，并在取消自动续费授权后复用已永久拒绝的 annual.request_id。现行 checkoutRejected、迁移 0164 与 FIX06/#1006 已明确返回 SUBSCRIPTION_CHECKOUT_REJECTED（409），原 request_id/hash 的拒绝收据持久不变，不创建订单；取消授权后必须使用新 request_id。

仅修改该子测试：首次拒绝使用当前错误码；取消前、取消后重放同一原 key 都精确拒绝，原 key 订单数为 0、owner 总订单数不变，拒绝 request_hash/message/created_at 不变。正常取消授权后，新 key 可创建年度订单且总订单仅增加 1，旧 key 仍无订单且拒绝收据不变。

原 monthly omitted/explicit hash、monthly key 转 annual 的 IDEMPOTENCY_CONFLICT，以及年付周期、关闭自动续费、214920 分金额断言全部保留。87 条原 assert 中 **86 条逐字同序保留，仅 1 条作上述错误码变更**，新增 13 条边界检查。第六子测试外源码全文不变：其余 7 子测试、8 子测试名称和父测试、原 skip 与 180000 ms timeout 均保留。未修改 subscriptions.pg（原 120000 ms）、生产代码、定价、迁移、门禁配置或性能阈值。

## 验证与证据

原门禁 `1794418350450-38278111` / `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2` 的 [原失败 TAP](subscription-annual-checkout-fixture-20261112/original-annual.tap) 为 9 tests / 7 pass / 2 fail / 0 skip：第六子测试失败连带父测试失败，其他 7 子测试通过。原文件 Git blob 与本轮基线一致；该记录是原 gate 历史证据，不是本轮重新执行 red。

[年度完整 TAP](subscription-annual-checkout-fixture-20261112/annual.tap)、[未改订阅边界 TAP](subscription-annual-checkout-fixture-20261112/subscriptions-boundaries.tap) 和 [proof.json](subscription-annual-checkout-fixture-20261112/proof.json) 对应同一固定源码。未改订阅边界继续覆盖历史 wire、原受理订单重放、stale tab 永久拒绝、pending/active/cancel_pending 授权三态、取消后新请求、续费、余额与退款。已有开放 PR 按目标文件核对无重叠。

proof 记录原始/展示日志 SHA-256、完整阶段命令与耗时、AST 对照、6430 个 raw Git blob、依赖 lock、镜像和清理证明。展示日志只移除行尾空白和末尾多余空行；原始字节保留在本地证据目录。

## 环境与复现

- 缓存 runner 与 PostgreSQL 16 Alpine 按不可变镜像 ID 启动，--pull never；未安装或升级依赖。
- Node v22.23.3、TypeScript 5.9.3、pg 8.23.0、Fastify 5.12.5；LANG/LC_ALL 为 C.UTF-8；依赖 lock 只允许明确 LF/CRLF 等价。
- 定向 API 继承原严格 tsconfig，包含两个完整测试文件及动态 upload-inspection-worker 入口。
- 私有 internal 网络，无发布端口；PG 1 CPU/512 MiB、runner 2 CPU/2304 MiB，总 3 CPU/2816 MiB。PG 是独立 tmpfs 合成数据库；年度交付夹具使用原内存 Blob；支付使用原 authenticated synthetic adapter。没有 Azurite 或真实支付渠道。
- runner --init，各阶段流式日志与独立进程组；外部 300000 ms 上限及 TERM→KILL 不改变原测试内部 timeout。完成后 clone 0、runner 仅剩 init/sleep；按精确 ID 删除两容器及 internal 网络，回查不存在。

```sh
node db/migrate.mjs
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/subscriptions-annual.pg.test.js
node --test --test-reporter=tap --test-concurrency=1 apps/api/dist/subscriptions.pg.test.js
```
