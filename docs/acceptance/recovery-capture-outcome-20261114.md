# #1343 恢复快照保存结果

本补丁基于 `bbf7fb18212bf51ab02e9f4ac0335d04d5f6c813`。缺陷来自静态路径检查及 synthetic 复现；不表示当前真实募集书任务已经出现快照保存失败。本补丁未操作真实任务、材料、生产数据库或运行中的本地业务栈。

## 行为与边界

- 文件编制 intent 与 `prepared` 标记同事务保存，后续保存失败不能冒充历史无快照。结果绑定完整 owner/project/run/job/input/attempt。
- 模型原始错误、退出证据、unknown 用量保持。完整快照存在时可正常恢复，即使 `saved` 标记未写成。
- 保留 4096 文件、100 MiB 单文件、256 MiB 总量；完整 stat 检查后才写 Blob，已知超限零写入。不删除缓存、不发布部分快照。
- 仅现代首轮且无任何恢复快照/成果/完成调用时复用已确认的从材料重启入口；已有旧快照、后续修复阶段、身份错配与耗尽预算不能借此重算。
- user/credit pause 独立解除，仍停在 `provider_reconcile`；重新处理需要原有明确确认，不增加调用或重置预算。
- 页面保留五步状态卡与原按钮/弹窗，只替换准确原因。四种公开原因统一在 contracts；无新增迁移或依赖。

## 验证

环境：Windows Node 22.14.0；独立 PostgreSQL 16 Alpine、随机本机端口、测试文件按键克隆数据库；Linux 临时容器没有网络、凭据或业务卷，仅只读挂载本补丁各包 dist 和 synthetic fixtures。

| 验证 | 结果 |
| --- | --- |
| `npm run build` | 通过，保留既有前端包体积警告 |
| `npm run check:contracts` | 通过 |
| `node --test apps/web/dist-test/authoring-status.test.js` | 8/8 |
| `npm run test:unit -w @bondbuddy/web` | 1133/1134；既有 Docker context 未允许 authoring-status.css，一项失败；集成工作区独立提交 `071042de`（#1344）修复，父任务记录 2/2 asset 与单 CSS Docker COPY/hash 核验，不等于完整镜像构建 |
| Linux `codex-file-authoring.test.js` + `file-authoring-recovery.test.js` | 14/14，无跳过；真实本地子进程、synthetic 模型，四种实际 onFailure 分支，1271/4097 文件边界 |
| API `authoring-dynamic-balance.pg.test.js` + `review-dynamic-balance.pg.test.js` + `m4-dynamic-balance.pg.test.js` | 4/4，无跳过 |
| Worker `file-authoring-payload-recovery.pg.test.js` | 2/2，无跳过；输出超限组 328 秒，超时组 386 秒，总计 732 秒（含初始化/清理） |

PG 首轮在新测试查询不存在的 `bb_call_usage.total_tokens` 时失败；已改为实际不可变用量字段，重新执行完整套件通过，未更改业务逻辑以满足该测试。扩展后的单组矩阵采用 600 秒超时，未跳过原回归场景；所有测试克隆数据库正常清理。

PG 恢复矩阵包括现代 capacity/storage/integrity/prepared/outcome-write 失败；完整快照加 prepared；owner/lease/attempt/input 错配；自动与人工竞争、重复 POST、原预留与历史、预算上限；413、TURN_FAILED、输出超限/超时叠加 user/credit/both/manual-resume，及无积分到充值路径。

独立静态复核确认上述 user/credit 恢复死锁已解除，无新增可操作问题；复核前后核心源码 SHA-256 一致：queue `693889e494834fd4de028514b0b2af5f36199e1c95d4ac2d0c9dd9c9e0199b0e`，recovery `53e27354b005399c77b8d8ae9029e1399c22e5ec162871d00695885ddffbb1ac`，stage `ee916f5f57517785e107b47e85d2eedf5cdd48641ad780211f3fe6d0e32b8fb5`。静态审查不代替模型或最终用户验收。

## 可复现命令

先在独立 PostgreSQL 测试模板执行 `DATABASE_URL=... node db/migrate.mjs`，将同一模板连接设为 `BB_TEST_DATABASE_URL`。测试只向模板的临时克隆写入 synthetic 数据，不连接生产。

```text
npm run build
npm run check:contracts
node --test apps/web/dist-test/authoring-status.test.js
node --test apps/api/dist/authoring-dynamic-balance.pg.test.js apps/api/dist/review-dynamic-balance.pg.test.js apps/api/dist/m4-dynamic-balance.pg.test.js
node --test apps/worker/dist/file-authoring-payload-recovery.pg.test.js
```

Linux 使用固定 worker 镜像 `sha256:e1565d1d423a9216578950137434ced32652b67ca42484602a5a26ff4ebb8410`，命令为 `node --test apps/worker/dist/file-authoring-recovery.test.js apps/worker/dist/codex-file-authoring.test.js`。新建 `--rm --network none --read-only --user node --cap-drop ALL --security-opt no-new-privileges:true` 容器，使用仓库 `deploy/local-prelaunch/security/codex-seccomp.json`，2 GiB 内存、2 CPU、128 pids、768 MiB `/tmp` tmpfs；精确只读覆盖 contracts/domain/rule-pack-registry/rule-applicability-context/api/worker 各包 dist 与 worker/test-fixtures，保留镜像 Linux node_modules。不能向正在运行的业务容器注入测试文件。

截图可复用 `apps/web/tests/project-execution.spec.ts` 的原 fixture：`runStage='provider_reconcile'`、`runReason='file_authoring_payload_recovery_pending'`、`retryMode='restart_materials'`，分别设置四种 `checkpoint_*` 原因。页面确认仍用现有“使用原材料重新处理？”弹窗；截图与原型对照由集成工作区统一补充。

代码完成后仍需统一本地集成、截图对照及用户实际验收；尚未部署，待统一发布。synthetic 测试不代表真实模型生成成功或最终业务验收。
