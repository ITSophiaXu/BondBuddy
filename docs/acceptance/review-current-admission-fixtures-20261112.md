# 当前复核任务测试夹具维护（2026-11-12）

Refs #1051。两份复核用例直接提交新任务，仍假设无报价、无余额即可执行；当前新 HTTP 委托统一进入自动范围报价，因此在后续业务断言前返回 `QUOTE_REQUIRED`。本次只补齐合成账号、服务端报价和明确的合成额度，不修改产品代码、门禁、skip 或原有业务断言。

## 范围和准备步骤

- `apps/api/src/review-workspace.test.ts`：对完整执行 intent 取报价，按报价金额发放隔离测试额度，把 `quote_id` 放入原并发请求；草稿及项目信息变化后对第二个 intent 重新报价。继续验证并发幂等、项目互斥、锁定快照不可变、草稿版本冲突、历史失败结果、归属和修订建议采用。
- `apps/api/src/review-materials.test.ts`：对当前过滤后的复核输入取报价并准备相同额度。继续验证 QA／文件生成专属材料不进入复核、真实核查材料保留、锁定输入准确、旧草稿不被隐式改写、关联副本隔离。

准备路径使用当前 API 和 `transaction` / `grantCredits`；没有启用 `historicalBillingFixture`，没有直接写余额、价格或冻结记录。`existing_grant`、actor 和 reason 明确标为 synthetic，只存在于独立临时数据库。

## 固定测试版本和环境

- 生产代码基线：`f298bc80dabedb1b1b24cd97ecb813dcffbebc56`，tree `c13a761242d2f35c75ca2d301930d6179adab551`。
- 已有本机 worker 镜像：`bondbuddy-release-worker:f298bc80dabe`，镜像 ID `sha256:40b652514b67b34f983661a7a2bf63d216232e041e02060d42dc230e17019236`，revision label 与上述基线相同。复用其生产 dist，定向编译后的测试覆盖到相应 `.test.js`；未重新构建、修改或替换生产模块。
- Node `22.23.2`；TypeScript `5.9.3` 来自既有 `bondbuddy-pr1013-gate-runner:2eeea45c` 缓存，ID `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`。锁文件 SHA-256 `69ce90eb0ff8cb11578c419ad3c5a1221da099fdb5fce17c190aef2052255701`。
- PostgreSQL `16.13`：镜像 ID `sha256:20edbde7749f822887a1a022ad526fde0a47d6b2be9a8364433605cf65099416`；Azurite `3.35.0`：ID `sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37`。
- 独立 `bb-admission-fixture-*` 容器及内部网络，无宿主端口、Docker socket 或生产连接。数据库与 Blob 各 0.5 CPU / 512 MiB，runner 1 CPU / 1 GiB。等另一组定向 PG 测试完全清理后启动，本组文件串行执行。
- 材料、账户和额度为 synthetic。真实数据库/API 路由与账本参与；没有真实模型、支付、官网或用户验收。最终两份复核测试模型调用数为 0。

## 实际验证

原镜像分别运行原用例：`review-workspace` 和 `review-materials` 均在新复核提交处收到 `QUOTE_REQUIRED`。前者所在初次诊断执行还包含 `provider-reconciliation`，记录为 0 pass / 2 fail / 0 skip，18.66 秒；后者单独执行为 0 pass / 1 fail / 0 skip，TAP 13.98 秒。不是同一轮两文件红灯的合并计数。

严格定向类型检查（退出 0）：

```sh
node /tmp/bb-typescript/lib/tsc.js --noEmit --target es2022 \
  --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node \
  apps/api/dist/review-workspace.test.ts apps/api/dist/review-materials.test.ts
```

两份测试以相同编译选项定向转译，生产模块保持上述固定镜像版本。最终回归：

```sh
node --test --test-concurrency=1 \
  apps/api/dist/review-workspace.test.js apps/api/dist/review-materials.test.js
```

**2 pass / 0 fail / 0 skip / 0 cancelled / 0 todo**；TAP 21.58 秒，宿主命令耗时 22.87 秒。`git diff --check` 通过。数据库退出时仅剩初始模板库，测试 clone 已清理；本次四个容器及内部网络随后全部删除。

原始日志保存于独立工作区 `work/admission-fixtures/`，SHA-256：

| 日志 | SHA-256 |
| --- | --- |
| `before.tap` | `5e54a2a0351fa6b09492c9ea826567f6e016de7f50022b31c7cb2cb664c418ea` |
| `before-materials.tap` | `09cb5c6d6928264e8ff78bc275cfbbd904aab2bead330d2cd3eb2fafec7361f5` |
| `after-reviews.tap` | `fc19a440c5404079f4cb6f4fc4c2dd60218d7312c5e516d3ed5fd5248376e1f3` |
| `compile-reviews.json` | `2f7febaca9b76d5b8ad1ce570fc58b98ae090f3d8ec950da7001a7a85880eddd` |

最终测试源码字节哈希分别为 `fa5254b5fe35d8a61cff6ceda3782ca3ca869d23accc3b3881771b2ebe759beb`（workspace）和 `4b4a9a8ca53c9ec4e4d414cd3fb72e057ab1959a7020ff6236fa7f0819b8d39e`（materials）。

## 保留的失败及未解决范围

第一次迁移连接遇到 PostgreSQL 初始启动阶段的 TCP 拒绝，日志保留；待 TCP 就绪后使用原迁移入口成功。生产镜像没有 worker 声明文件，最初将 worker 测试放在 dist 做严格类型检查时报缺声明；补齐固定源码后类型检查通过，没有放宽类型参数。

`provider-reconciliation.test.ts` 的旧空输入初始报 `INPUT_REQUIRED`。一次仅补准入的诊断先暴露合成用户名格式问题，修正准备后到达缺用量断言：observation 为 `pending_reconcile`，但固定积分任务已有有效持久结果，run 保持 `running`，旧断言要求 `paused`。这是 `provider-results.ts:310–316` 已有分支，符合 2026-10-03 固定积分决定“不因缺用量长期冻结已有确定成果”。该测试还覆盖历史 platform_trial 计量语义，需另行区分历史合同和当前规则；本次撤回该文件的全部修改，未改变断言或生产行为。诊断 diff、源码、两次失败日志保留，其中 `after-2.tap` 为 1 pass / 1 fail / 0 skip，哈希 `bee8ee6d9fc7aba9fc3c6a7d98f8973bfc8ff3140a628c0279d41551c4406c6f`。

此结果只覆盖两份复核文件，不代表 54 份 A 类失败全部修复，也不代表全量 PR gate、五流程发布回归或专业质量验收通过。历史缺 issuer、旧计费合同和已退役 assessment 入口未处理。

## PR 基线与发布边界

测试基线是本地集成候选 f298，不把该候选的整批未合并 PR 推入 develop。本次纯夹具提交单独移到 `origin/develop` 的聚焦分支；交付前读取到的 develop 为 `8a7dc38a9546831346805d8cb36ce88aae456da3`。该 develop 与 f298 的两份原测试、`review-workspace.ts`、`billing.ts`、`server.ts` 一致，`data.ts` 存在批次差异，因此上述运行证据严格属于 f298 加本次测试改动，不冒称聚焦分支完整 SHA 已运行。

代码完成，尚未部署，待统一发布。最终统一验收待办：在最终候选重新完成全部必需发布用例、固定 commit/tree 的有效门禁及真实质量凭据；本次不签发发布通过状态。
