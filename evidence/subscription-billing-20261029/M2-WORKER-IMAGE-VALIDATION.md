# M2 Linux worker 与 API 入口补验

2026-10-29。本记录补充 [M2 本地验收](M2-CI-LOCAL-VALIDATION.md) 中的四个 worker 文件。仅验证固定 API 镜像中的已编译代码及合成依赖，不代表整套 GitHub Actions 或生产部署通过。

## 固定来源与执行环境

|项目|实测值|
|---|---|
|源码提交|`279f13a0f086ca1048b38058fcc94703763f8b5a`|
|API 镜像 ID|`sha256:1ecf1c3b12966ffa986716dfdde891d1d31b25f2bcdfa20fde4061c780d421d2`|
|镜像运行目录、用户|`/app`、`node`|
|镜像内 Node|`v22.23.4`|
|WSL 发行版|`BondBuddyM3`|
|PostgreSQL 镜像 ID|`sha256:21f6013073bc6b92830a2129570e2f5ec42a6c734b5a985a41e83aa58f54c3c1`|
|Azurite 镜像 ID|`sha256:647c63a91102a9d8e8000aab803436e1fc85fbb285e7ce830a82ee5d6661cf37`|
|数据库迁移|空库执行 156 个 migration，最新 `0155_file_check_batch_reuse.sql`|

API 镜像构建来源见 [RELEASE-API-LOCAL-VALIDATION.md](RELEASE-API-LOCAL-VALIDATION.md)。现有 Dockerfile 的 API target 含 worker JavaScript dist；本轮未重新构建、未构建完整 worker/OCR 镜像。

## 结果与范围

以 `node --test --test-reporter=tap --test-concurrency=1` 执行以下四个文件：

|编译后的测试文件|结果|
|---|---|
|`apps/worker/dist/m2-paid-worker.test.js`|通过|
|`apps/worker/dist/authoring-action-progress.test.js`|通过|
|`apps/worker/dist/authoring-pause.pg.test.js`|通过|
|`apps/worker/dist/provider-reconciliation.test.js`|通过|

合计 **4/4 通过、0 失败、0 跳过**，测试进程耗时 `9628.927687 ms`。覆盖收费任务成果复用与未知用量、进度事件脱敏、暂停恢复、供应商结果持久化对账；依赖和供应商响应均为 synthetic。

随后启动同一镜像的实际 `apps/api/dist/server.js` 入口，在容器内部请求 `/health`，得到 HTTP 200：

```json
{"status":"ok","service":"bondbuddy-m1-api-skeleton","implementation":"health-and-contract-only"}
```

该结果仅证明 API 进程与路由成功启动。`/health` 不验证数据库、模型、商户或完整部署；数据库迁移与 worker 用例是上面的独立证据。

## 隔离与可复现性

- 运行脚本仅接受不可变 `sha256:<64 hex>` 镜像 ID，并用 `docker create --pull never` 创建容器。
- PostgreSQL、Azurite、迁移、worker 测试与 API 使用本轮独立 Docker `--internal` 网络；未发布宿主端口。Node 版本探测使用 `--network none`。
- PostgreSQL/Azurite 数据及应用临时目录使用 tmpfs。worker 与 API 根文件系统只读，禁用额外权限提升。
- 唯一业务工作区挂载为只读合成 CLI 夹具目录 `apps/worker/test-fixtures/codex`。脚本启动前验证 `fake-codex.mjs` 与 `missing_usage.jsonl` 的固定 SHA-256；这两个文件与上述源码提交一致。
- 显式使用合成凭据，不加载实际 `.env`；微信、支付宝关闭。没有真实模型、支付供应商请求，也没有消费真实用户材料。
- 本轮仅新增验收脚本、日志和报告，未修改生产代码。

证据文件：

- [可复现脚本](completion/m2-worker-isolated.sh)：已通过 `bash -n` 语法检查。
- [完整运行日志](completion/m2-worker-isolated.log)：包含镜像、Node、迁移、4/4 用例、API health 及清理结果。
- [清理后资源清单](completion/m2-worker-resource-inventory-after.log)：保留当时的容器 ID、名称、状态与卷名。

复现时，在上述 WSL 发行版执行脚本并传入本记录 API 镜像 ID；脚本使用当前工作区绝对夹具路径及固定文件哈希。若迁移、镜像或夹具来源改变，应另记一次验收，不将其归为本次固定提交结果。

## 清理与既有资源证据边界

本轮标签为 `com.bondbuddy.synthetic.run=bb-m2-ci-20261029142338-574`。脚本只对本轮记录的资源 ID 操作，清理前核实标签；六个临时容器及一个 internal network 均逆序清理，最终输出：

```text
FINAL_EXIT=0 cleanup_failed=0
```

清理后按本轮标签查询容器与网络均为空，没有本轮待清理服务。脚本未挂载或操作既有卷，没有执行卷删除、prune 或全局停止。

清理后只读清单中，前置记录的 12 个容器名称全部仍在且全部为 `exited`，卷数量仍为 8。前一轮镜像 probe 在内存比较容器 ID/名称/状态与卷名，并将 `existingContainersAndVolumesUnchanged: true` 保存于 [RELEASE-API-PROXY-PROBE.json](RELEASE-API-PROXY-PROBE.json)，但未持久化完整历史原始清单。因此本轮不能宣称完成了与历史 baseline 的容器 ID、卷名逐项对比；可核实的是名称/状态、卷数量、本轮零残留及脚本操作范围。

GitHub Actions 当时因账户账单/支出限制未启动。本机补验补足对应测试证据，不将其标记为整套远端 CI 通过。
