# 文件编制恢复总字节容量（Refs #1345）

## 发现与修改范围

2026-11-14 17:41:36（北京时间），固定 ae6dd0255ca38f7c2cff033b4bbd1c7da91786d1 本地 Copilot 真实任务的只读元数据核对显示：恢复选择器 `input.json + scratch/** + output/**` 共 929 文件、272,333,666 字节，最大单文件 5,634,998 字节；两遍统计稳定，unsafe/missing/inaccessible 均为 0。总量超过旧 256 MiB 上限 3,898,210 字节。当时 run 仍为 `running/provider_call`，没有执行快照保存；这证明容量条件不满足，不是已经观察到保存失败。

在 #1302 整合基点 071042de108b893138debc652a9a905332fee3fb 上评估 512 MiB 有限总量。只修改 `packages/contracts` 的 `FILE_AUTHORING_RECOVERY_LIMITS.totalBytes`；API 元数据核验、worker 保存和恢复继续使用该唯一常量。4096 文件、100 MiB 单文件、目录遍历预算、路径/链接/hash/输入与任务归属、完整快照/授权恢复、预算及用量边界不变。质量与正文/实际页数 70% 门槛不变。

没有排除或猜删工作文件，没有发布部分快照，没有将诊断副本回灌为检查点，也没有修改任何正在运行的任务、镜像或配置。无迁移或新增依赖，contracts、API 与 worker 必须同批集成。

## 资源与存储边界

保存每次只读取一个不超过 100 MiB 的文件，再顺序上传和回读；当前文件核验后才处理下一文件。恢复也顺序回读、核验及写入，不将整个目录拼入一个 Buffer。`regularBytes` 的读取 chunks 与拼接 Buffer、Blob 回读 chunks 与拼接 Buffer 可能短时共存；因此单文件仍需内存余量，512 MiB 总量不能当作 RSS 的绝对上限。

本机活动 worker 的只读资源观察：6 GiB 内存、4 CPU；当时 cgroup memory.current 为 582,905,856 字节。实际 parse 工作卷所在 `/dev/sdd` 可用 791,901,268 KiB。该读数只说明当时空闲量，既不是卷配额也不是容量保证。file-authoring 将 HOME/TMPDIR 指向 scratch，故 `/tmp` 的 4 GiB tmpfs 不能作为 scratch 磁盘配额。

仅根据仓库配置核对（未读取生产）：`deploy/m1/compose.yaml` 基础 authoring worker 为 768M / 1 CPU；`compose.prod.yaml` 与 `compose.execution.yaml` 为 2G / 0.75 CPU、`NODE_OPTIONS=--max-old-space-size=768`、并发 1；本地 prelaunch 为 4096M / 4 CPU。`file-authoring-stage.ts` 优先使用配置的磁盘 `BB_PARSE_STAGING_DIR/file-authoring`。本次 helper 的 2 GiB 内存与 prod/execution 上限一致，但使用 1.5 CPU、未设置该 NODE_OPTIONS；不是整个生产 worker 的资源验收，也未证明基础 768M 配置支持该峰值。最终组合验证宜使用 prod/execution 的资源参数，并计入正常 worker、SDK 与其他进程的余量；本补丁没有更改部署配置。

尚未证实恢复 Blob 的累计配额、TTL 或 orphan 清理。保存每个 attempt 使用独立键；失败前已上传对象以及旧 attempt 快照可能持续占用存储。512 MiB 是单个完整快照的有限上限，不是项目/用户/存储账户累计上限。本补丁不建立 GC 平台，也不声称已有存储回收保障。#1343 的全量预检/保存结果记录独立减少已知超额产生的无用上传；实际上传中失败仍需独立生命周期方案。发布环境仍需按并发数、重试和保留期核算磁盘及 Blob 容量。

## 可复现的合成资源验证

`scripts/verify-file-authoring-recovery-capacity.mjs --verify /capacity /evidence/result.json` 必须在独立 Linux helper 中显式运行，先编译 contracts/API/worker。脚本使用完全生成的字节与虚构身份，不读取客户材料、模型、凭据或业务数据库。

Blob 为磁盘持久化的 synthetic 接口，回读按生产 `getIfExistsBounded` 的分块/拼接形状实现；它不是 Azure SDK、Azurite、网络带宽或远端可靠性验收。每个文件均真实写满，未用稀疏文件规避 I/O；摘要校验以 64 KiB 流顺序读取。每轮同时保留源、Blob、恢复目录，然后仅清理 helper 自建的大 fixture。

两轮均为 929 文件并包含 `input.json`：

- 272,333,666 字节 / 最大 5,634,998 字节的合成规模，匹配发现时的数量、总量及最大文件统计；内容不是原任务副本。
- 恰好 512 MiB / 最大 100 MiB，完整保存、回读、API 核验、授权后重建 input 并恢复，逐文件 SHA-256 与源和快照一致。

第二轮额外验证总量 +1 字节（包括 input）、单文件 100 MiB +1 拒绝；超额元数据在恢复前拒绝，零 Blob 读取且目标为空。超额保存不能发布新/部分快照。既有定向回归覆盖 4096 全量保存恢复、4097 拒绝及路径/链接/hash/归属防护。

2026-11-14 09:57:17–10:00:05 UTC，固定本地已有 worker 镜像 `sha256:e1565d1d423a9216578950137434ced32652b67ca42484602a5a26ff4ebb8410`，挂载本分支编译的 contracts/API/worker 及依赖包 dist，Linux x64 / Node 22.23.2，`--network none --read-only --memory 2g --memory-swap 2g --cpus 1.5 --pids-limit 128 --cap-drop ALL --security-opt no-new-privileges`，`env -i` 清空继承环境，仅传 PATH 和 NODE_ENV。只读源代码挂载、新建 synthetic 容量卷和证据目录，未挂载凭据或任何业务卷。

| 合成规模 | 保存＋逐对象回读 | 授权恢复 | 独立逐文件 SHA 核验 | Node maxRSS |
|---|---:|---:|---:|---:|
| 929 文件 / 272,333,666 字节 / 最大 5,634,998 字节 | 19.763 s | 19.184 s | 7.654 s | 145,116 KiB |
| 929 文件 / 536,870,912 字节 / 最大 104,857,600 字节 | 33.613 s | 24.297 s | 13.907 s | 453,084 KiB |

两轮均 929 次 put、1858 次 get（含保存回读与恢复）、只发布 1 个完整 checkpoint，最大同时进行的 Blob 操作为 1。整体采样 RSS 最大 463,958,016 字节，Node maxRSS 453,084 KiB（约 442.5 MiB）。**cgroup memory.peak 为 2,060,206,080 字节（约 1.919 GiB）**，包含同一 helper 的源文件、synthetic Blob、恢复目录三份文件页缓存；`memory.events` 的 max/oom/oom_kill 均为 0。不能只使用较低的进程 RSS 作为容器内存需求。helper 初始可用盘 810,904,608,768 字节，最大完整三副本时读数 809,285,750,784 字节；共享宿主盘也有其他任务写入，这些差值不是该 fixture 的精确磁盘配额。容量卷在 fixture 清理后核为空、核对专用标签并移除，结果/日志保留。

总量 536,870,913 字节拒绝；API/恢复元数据拒绝发生在读 Blob 前，未写目标。单文件 104,857,601 字节拒绝且 0 put。此分支尚未包含 #1343 的保存全量预检，故总量 +1 保存前进行了 928 次 put，但没有发布新/部分快照；这是原保存逻辑的明确限制，不得写成已修为 0 put。主代理整合 #1343 后需复用该 helper 验证总量 +1 为 0 put，且完整 512 MiB 路径仍通过。

其他定向验证：

- Windows / Node 22.14.0 对 contracts、domain、rule-pack-registry、rule-applicability-context、API、worker 顺序执行各自 `tsc -p tsconfig.json`，全部通过。复用本机既有依赖，无联网安装。
- Linux `node --test --test-concurrency=1 apps/worker/dist/file-authoring-recovery.test.js apps/api/dist/file-authoring-recovery.test.js`：9 pass / 0 fail / 0 skip，包含 1271/4096 全量往返、4097 拒绝及既有安全门。
- Linux contracts 规定的 outcome-pricing、integrity-presentation、workpapers、workpaper-naming、ocr-v2、generation-issuer-binding 测试：72 pass / 0 fail / 0 skip。179 个 synthetic 样例、12 个内部库样例及 4 个生命周期样例通过。首轮样例因 helper 未挂载 `product-prototype/public/project-fields.js` 而失败；补足此只读代码挂载后只重跑样例并通过，原始失败日志保留，没有重复已通过的 72 项。
- `git diff --check` 通过。未运行模型、业务数据库或整套 Word 质量验收；这些仍由真实任务和统一集成验收覆盖。

本地证据目录为本子工作区的未提交 `work/capacity-validation/`。关键 SHA-256：脚本 `f146a5880ccafcd2adef88edb262104fda4c3e34e656df1b57d1cac763bc72ac`；`result.json` 为 `3032dc4e886c4e8534dcf90b694c4245c5b581ab6dbfcd850fe7330cfefe820f`；`recovery-unit.log` 为 `7804ac66e814eb7f3555a099542c79bbe9df9db4884b3a45658ebbed5f26850b`。没有提交客户材料或大 fixture。

512 MiB 在该隔离资源实验中通过，因此交付有限容量候选供组合验证；这不承诺任意工作规模、并发、网络或累计存储都可恢复。代码完成后由主代理整合；尚未部署，待统一发布。真实任务终态、真实恢复及用户验收仍分别跟踪。
