# #1045 管理日志 int64 协议回归

## 问题与已核实协议

这是测试维护任务。基线 develop `8a7dc38a9546831346805d8cb36ce88aae456da3` 的两个测试文件仍按迁移前格式断言；未确认生产响应存在类型缺陷。

- 已合并 [#814](https://github.com/ITSophiaXu/BondBuddy/pull/814)、[迁移审计](../product-decisions/2026-10-29-billing-int64-migration-audit.md) 和提交 `172b6a4f44ebef1389ccd0d5bea205c92bbbc397` 明确将日志累计次数/token 纳入精确 DTO。
- 默认及显式 `x-bb-billing-format: int64-decimal-v1` 返回规范十进制字符串；显式 `number-v1` 只对可精确表示的读取返回数字，超范围为 503 `DATA_UNAVAILABLE`。
- `admin-logs.ts` 的基础 schema 保留用于原领域/legacy 语义。实际 HTTP schema 经 `installBillingWire` 转换；OpenAPI 使用独立 `BillingInt64_` 组件。因此不能只看基础 schema 就断言公开 HTTP 契约冲突。
- direct `adminJobTimeline` 的 consumption 是字符串；direct `adminMetrics.jobs` 来自 SQL `::text`，`metrics.attempts.total` 仍是内部数字，HTTP hook 再统一编码。原 PG/ledger 的数字用量断言保留。

## 验证环境与范围

2026-11-12，Linux Node 22.23.3、独立 PostgreSQL 16 与 Azurite 3.35.0；internal Docker network，无主机端口。迁移仅应用于新建 `bb_int64_template`，每个 PG 测试文件再克隆独立库。未连接其他集成库、生产库或真实模型。平台探针继续使用 fake-codex 合成 JSONL。

复用本地缓存镜像的依赖，源码来自当前 worktree；镜像及 develop 的 `package-lock.json` SHA-256 均为 `69ce90eb0ff8cb11578c419ad3c5a1221da099fdb5fce17c190aef2052255701`。先复制未修改基线源码并编译，取得 red，再复制测试修改重新编译。

| 检查 | 结果 |
| --- | --- |
| 未修改基线 logical-job + platform-probe | 3 用例：1 pass / 2 fail / 0 skip；严格重现 `'0' !== 0`、`'8418' !== 8418` |
| contracts/domain/registry/context/api/worker TypeScript 构建 | 通过；修改后 api/worker 再构建通过 |
| 修订后的 5 文件定向验证 | 18 用例：18 pass / 0 fail / 0 skip，耗时 15.740 秒 |

新覆盖同时验证：

- 默认、显式现代、显式 legacy 的完整响应 schema、响应头及严格类型；现代 schema 拒绝数字、前导零、小数、负数和 int64 溢出。
- `MAX_SAFE_INTEGER` 可精确 legacy 读取；`9007199254740991 + 2` 精确累计为 `"9007199254740993"`；`INT64_MAX` 保真；后两者 legacy 均拒绝；累计超 int64 拒绝。
- 无尝试及未知用量保留 null，已测得零为 `"0"`/legacy `0`；版本、尝试序号、时长、成功率维持数字。
- 两个实际 PostgreSQL 测试继续执行权限、原子记录、幂等、归属、probe 持久化、kill switch、Blob 补偿与清理断言。新增合成完整 DTO 测试连接实际 accumulator、HTTP hook/serializer 与发布的 OpenAPI schema，不声称其替代真实数据库链路。

构建：依次执行 `npm run build -w`，workspace 为 contracts、domain、rule-pack-registry、rule-applicability-context、api、worker（均带 `@bondbuddy/` 前缀）。定向命令：

```sh
node --test --test-concurrency=1 \
  packages/contracts/dist/billing-wire.test.js \
  apps/api/dist/billing-wire.test.js \
  apps/api/dist/admin-log-billing-wire.test.js \
  apps/api/dist/logical-job.test.js \
  apps/worker/dist/platform-probe.test.js
```

需将 `BB_TEST_DATABASE_URL` 和 `BB_TEST_AZURITE_CONNECTION_STRING` 指向专用合成环境；缺失环境时 PG 测试会 skip，不能当作完成上述验收。

本机原始执行日志保存在 `BondDraftAI/work/admin-log-int64-contract-20261112/red-baseline.tap`、`green-targeted.tap` 和 `migrate.log`。任务专用容器、临时数据库/Blob 和网络已清理；日志留存供复核。red/green SHA-256 分别为 `e1be2bdb198b4732c0387ab927dc0e1127b028a44cbb9338bceba1776181ec6f`、`df66848303e1365a227692495274c4bf9640fe8ede12132ee239fbb3202d9adf`。

## 分诊更正与交付边界

#1013 本地分诊报告及生成脚本已将 C 类两文件更正为“int64 协议测试预期缺口”，追加更正审计记录并撤回“公开 schema 冲突”的原判断。原始日志、8 份原分片分析及 failed 回执保持原样；原文件级计数仍为 **749 = 580 passed + 127 failed + 42 skip 阻断**。本次定向结果不改写或替代该完整 gate 回执，也没有重新运行全量 gate。

本 PR 仅修改测试与验证记录，无产品逻辑、数据库迁移、公共协议或模型配置变更。不扩大到其他 fixture 准入失败。代码完成后提交 develop PR，由集成/发布任务接续；不合并、不部署，不将合成测试说成真实模型质量或用户验收。
