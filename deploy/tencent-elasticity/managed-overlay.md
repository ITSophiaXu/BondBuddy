# Managed 双组件候选

Refs #1361。此入口只生成基础设施 overlay，不执行生产迁移、容器切换或自动池激活。

`managed-overlay.lock.json` 固定正式 post-1414 manifest 摘要、两个不可变父镜像和完整业务源码版本。编制底座为 `a0a051111dc583db9b39459a5f215e63a8c522e5`，复核底座为 `9c6ab2c2d995774af48a537cdf0a087959165d10`。两者保留正式五模块的 permit 链路，诊断与连接修复只应用已审 patch 的对应 hunk，并核对正式派生 TS 摘要。`codex-adapter.js` 必须与正式 emit 的 `dc68153bef393c54580a625c64bba4a501d58e60e471358894227d83fac3622c` 相同。

新增代码来自 `e277c27a1102d4d78a0f635343a8eb96278ecfbb` 的 managed runtime、登记、transport、预算、助手准入和控制模块。queue 基于原 timing overlay，仅加入 claim gate、禁止抢占有节点归属的旧租约、stopped-epoch fence 和 reconciliation 导出。durable journal 只为原 acquire 增加 job/lease 准入参数；不接入模型活动计时或新的收费实现。渐进分组只补缺失的辅助导出和 `2|4` 类型兼容，旧默认常量及业务逻辑保留。现有 ops tick 复用当前控制模块，包括 #1412 的可信数据库绑定，不增加调度器。

生成入口（输出目录必须尚不存在）：

```sh
node deploy/tencent-elasticity/managed-overlay.mjs authoring "$AUTHORING_OUTPUT" --build
node deploy/tencent-elasticity/managed-overlay.mjs review "$REVIEW_OUTPUT" --build
gzip -n -c "$AUTHORING_OUTPUT/managed-overlay.tar" > "$AUTHORING_PACKAGE"
gzip -n -c "$REVIEW_OUTPUT/managed-overlay.tar" > "$REVIEW_PACKAGE"
```

每个输出包含完整源码、逐文件 source/patch 摘要、未变业务文件清单与汇总摘要、编译文件清单及 `managed-overlay.tar`。tar 只携带明确列出的固定模块和基础设施增量，不携带认证、私有运行配置或完整新业务版本；固定时间、排序、权限及所有者使其可重复生成。应用前必须绑定 manifest 中相应父镜像，不能把它用于任意旧镜像。

本次公共包在 `managed-overlay-artifacts/authoring.tar.gz` 和 `review.tar.gz`；同目录 `manifest.json` 提供每个 payload 文件的路径、字节数和 SHA256。解压后的相对路径对应应用根目录，构建可使用 `COPY overlay/ /app/`，仅以 manifest 中准确 post-1414 父镜像为基础。没有新增 npm 依赖；Linux、Node.js 22、原业务原生工具和既有登记/transport 初始化依赖保持。issuer 使用已有 OpenSSL，bootstrap 使用既有 systemd/Docker 路径。两份公开 queue/journal patch 为零上下文机械 diff，独立应用时使用 `git apply --unidiff-zero`；生成器已经按固定前像和准确锚点实施同一增量。

隔离 PostgreSQL 模板先使用现有迁移到 0177，再安装已经正式存在的 0179，以及候选硬依赖 0181、0183、0184。不安装 0180 或 0182。随后运行：

```sh
BB_TEST_DATABASE_URL="$ISOLATED_TEMPLATE_URL" \
BB_MANAGED_TEST_SCRATCH="$ISOLATED_SCRATCH" \
node deploy/tencent-elasticity/managed-overlay-check.mjs "$AUTHORING_OUTPUT" "$REVIEW_OUTPUT"
```

复用现有容量、跨进程及排空测试，仅更新 RunInstances 的合成 acceptance/creation 夹具以符合 0183，并在同一容量路径验证两个节点共八个许可、第九个等待。两角色另用合成供应商实际进程验证旧输入、原 journal、结果持久化和复用；未将这些测试计作真实供应商、云节点或募集书财务验收。正式固定四路的既有独立调用和控制链路证据另行复用。

生产准备仍需正式数据库备份、按角色最小 ACL/受限连接、准确镜像和 launch manifest 绑定、逐节点独立材料及实机接线。当前默认 global4 保留；最终吞吐阶段需要显式授权的 provider limit8、全群8和对应政策摘要，才能在首机四槽占满时增加吞吐。最多两个节点、单节点四槽及现有小时/日费用界限不变。本产物不会设置这些生产值，也不会复用固定四路例外放行 managed。

回退输入是两个 post-1414 不可变父镜像及现有正式配置/绑定前像。先禁止新领取，正向排空并取得进程结束、结果持久化和节点停止证明，按现有锁及 fresh CAS 恢复两个固定组件；保留 0179/0181/0183/0184 和 unknown 账本，不降库或重投未决调用。仅关闭扩容开关不等于已经排空。#1361 的生产激活、跨机并发大于四且不超过八、停费及最终验收仍待后续步骤。
