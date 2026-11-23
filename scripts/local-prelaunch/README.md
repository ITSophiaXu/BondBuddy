# Persistent local prelaunch environment

## 本机使用

在本工作区执行 `node scripts/local-prelaunch/start.mjs`，然后打开
<http://localhost:18087>。可在页面注册独立测试账号、创建项目、上传材料，
并通过账号页的充值入口进入模拟收银台。模拟支付会走真实订单与积分账务；
可验证支付失败、支付结果待确认、到账查询和重复回调。它不会向真实商户付款。
解析、队列、模型生成和 Word 下载则执行实际产品代码。

开始募集书更新前，先上传并采用历史／参考募集书，填完整原稿信息。
错误输入、损坏文件、断网恢复和零余额后的继续操作可按正常页面流程测试。
自动化场景与已发现的问题记录在
[输入和文件测试](../../apps/web/tests/local-prelaunch-bad-cases.md)、
[支付与计费测试](../../apps/web/tests/local-prelaunch-billing.md)及
[全文质量验收](../local-quality/README.md)。

`node scripts/local-prelaunch/status.mjs` 检查实际服务状态；
`node scripts/local-prelaunch/stop.mjs` 停止本实例并保留账号、文件和账务。
更新产品代码后先提交，再执行 `build.mjs` 和 `start.mjs`；构建本身不替换正在运行的服务，
启动器会拒绝在有活动任务时升级。首次环境准备与隔离细节见下文。

This launcher runs the **current production Dockerfile and full product stack** in an isolated Docker Compose project. The API uses `createProductionServer` with the local synthetic payment provider; generation, parsing, reviewed-context loaders, task queues, immutable inputs and billing settlement remain product code. Synthetic payment is visibly labelled in the local browser. It does not connect to a merchant or production account.

The launcher also enables the `legacy-billing` profile: `/__legacy/api/v1/` reaches `api-legacy`, using the **same current API image**, database, authentication and loaders with subscription/outcome policy selection disabled and paid authoring/review enabled. This supports persisted `authoring_balance_v2` compatibility scenarios against the current production worker. It is a configuration of current code, not an old binary. This profile starts with the web service so its nginx upstream is always available.

From this checkout on Windows (WSL distribution `BondBuddyM3`) or Linux:

```sh
node scripts/local-prelaunch/build.mjs
node scripts/local-prelaunch/start.mjs
node scripts/local-prelaunch/status.mjs
node scripts/local-prelaunch/lifecycle-check.mjs
node scripts/local-prelaunch/stop.mjs
```

Open `http://localhost:18087`. Windows entry points delegate to WSL with this exact worktree directory. They start/reuse an owned hidden WSL keeper, recorded in ignored `host-wsl.json`, so WSL and its loopback forwarding remain available after the command exits. The keeper does not shut down the shared distro or manage other projects. Stopping this stack preserves the keeper and data; it stops only the owned Compose services. The local launcher supports Windows-managed Git worktree metadata without rewriting `.git`.

Run `lifecycle-check.mjs` before account/task acceptance while the environment is idle. It verifies a repeated start preserves container identities, an idle stop preserves named volumes, and restart preserves the database marker and data counts, then leaves the environment running. It makes no real model or merchant calls.

## Worker and model capacity

API admission limits and the shared model budget remain separate from Worker
slots. `BB_WORKER_CONCURRENCY=2` and `BB_REVIEW_WORKER_CONCURRENCY=2` give authoring
and review Workers two general task slots each. The dedicated authoring interactive
slot and review assistant slot remain enabled at one each; parsing stays at one.
`BB_MODEL_CALL_CONCURRENCY=6` permits up to six model calls globally, not six per
Worker. The model budget accepts integers 1 through 6 and defaults to 6. Existing
databases require migration `0182_model_call_capacity_six.sql` before Workers use
slots 5 and 6. Apply the same model budget to authoring and review Workers, and
deploy only after active work drains. A four-call override still queues the fifth
and sixth calls. Do not combine benchmark results collected under different model
budgets.

The first build creates an ignored `.local/local-prelaunch/config.json`, private `runtime.env`, and an optional operator-managed `model.env`. A new UUID derives a random `bb_billing_functional_<hex16>` database and Compose project. Private PostgreSQL/Blob keys are generated once. No database or Blob host ports are published. Every Docker container, network and named volume carries the instance label. Do not copy config between checkouts or edit its identity fields.

`build.mjs` archives tracked `HEAD` (never untracked local credentials, outputs or uncommitted files), hashes the archive, and builds production API, worker, web and egress targets. Commit intended new source scripts first: the archive includes them once they belong to `HEAD`; ignored `.local/` samples, credentials and outputs stay outside the archive. On a Windows-managed worktree, Git runs with `core.autocrlf=false` and `core.eol=lf`; the three executable Linux runtime scripts are compared with their tracked blob bytes before building. This avoids Windows Git's archive CRLF conversion breaking a Linux shebang. Every build uses a unique run ID for image tags, source archives, logs and a permanent receipt. The previous build receipt and its image tags remain valid even if a later rebuild fails; `build.json` is atomically replaced only after every image is built. Compose takes `BB_IMAGE_TAG` from that same published receipt, overriding stale values in the shell or local env files; building does not change `runtime.env`. Immutable image IDs, commit/tree, labels, commands, exit codes and logs are retained under `.local/local-prelaunch/receipts/`. Local scripts are mounted separately; their behavior must be identified separately from the production image commit. Buildx is required for the production Dockerfile.

`start.mjs` checks resource ownership, a free port/subnet, immutable images, migrations, the database marker, Blob readiness and fresh authoring/review/parse heartbeats. A repeated start of a healthy matching stack preserves resources. `status.mjs` probes the actual containers and database; a previously written ready flag is insufficient. It records source hashes for the mounted local boot, cashier, payment controls, nginx and model helper separately from the image's billing client sources. `stop.mjs` normally refuses queued/running work and leased messages. To test interruption/recovery, use `node scripts/local-prelaunch/stop.mjs --drain-active`: it stops product workers with their production grace periods, records before/after workload counts, then stops the other owned containers. Both modes **preserve all data volumes** and never change job/run state through SQL. The launcher never calls `down -v`, prunes Docker or removes another project.

After a completed build, old running or stopped containers appear as `pendingUpgrade` in status, with actual and expected image IDs and source revisions. Run `start.mjs` to apply the build. If the main API is running, start verifies its local identity and refuses queued/running jobs, active runs, pending Word-format diagnostics and every job/message lease, including expired leases, before replacing any containers. The ordinary idle probe reports `pendingFormatDiagnostics` because these diagnostics can still run after their business task has succeeded and released its lease. If the API is unavailable while workers or the legacy API still run, start refuses because it cannot verify in-flight work. A deliberately stopped stack can restart and resume retained queued/released work after `--drain-active`. No manual container removal is needed for an idle image upgrade; named volumes are preserved. Run lifecycle maintenance while no client is submitting new work; the read-only idle observation is not an API admission lock.

Static safety checks do not operate Docker or make model/payment calls:

```sh
node --test scripts/local-prelaunch/upgrade.test.mjs scripts/local-prelaunch/seccomp.test.mjs
node --check scripts/local-prelaunch/start.mjs
node --check scripts/local-prelaunch/status.mjs
node --check scripts/local-prelaunch/runtime.mjs
node --check scripts/local-prelaunch/build.mjs
```

Model credentials belong only in ignored local files. `model.env` overrides transport variables, and optional `.local/local-prelaunch/model.compose.yaml` supplies read-only mounts. A local direct model transport is an explicit test deviation from the production OAuth exchange, and must not be reported as production credential verification. Real provider/model acceptance requires an actual contained worker call, not readiness alone.

Local runtime differences: HTTP loopback instead of TLS; private Azurite instead of Azure; synthetic merchant; larger memory budgets; automatic storage purges disabled to preserve local evidence; WSL lacks AppArmor, so its absent profile is omitted. The authoring worker uses `deploy/local-prelaunch/security/codex-seccomp.json`, derived from the current production policy with only `mount` ALLOW rules constrained by flags argument 3 != 14 (`MS_NOSUID|MS_NODEV|MS_NOEXEC`). Mixed syscall rules are split so unrelated syscall conditions are unchanged. This keeps Codex's empty `/proc` fallback and leaves `filePermissionArgs` and `verifyFilePermissions` intact. Review and parse workers currently retain the production seccomp policy; status records each service's actual Docker-loaded profile content, matched source file and hash. The production AppArmor policy's broad `mount` allowance requires separate assessment; local verification does not prove that production boundary.

`node scripts/local-prelaunch/recreate-authoring.mjs` applies this authoring profile only after an actual read-only check finds no queued/running authoring jobs, active runs, any authoring lease (including expired leases), or pending Word-format sidecars. Parsing can continue in its separate service. It preserves existing red sandbox/model evidence and profile hashes, uses the production drain grace period, and verifies all other container identities are unchanged. It does not make model calls or modify SQL state. `node --test scripts/local-prelaunch/seccomp.test.mjs` verifies derivation and content-based loaded-profile identification.

OCR remains the production default (disabled unless explicitly configured). Unified uploads intentionally defer material inspection to a started business task; legacy project modes may enqueue standalone parsing. A healthy environment does not constitute document-quality or billing acceptance; run the relevant user-session bad-case and generation scenarios separately.
