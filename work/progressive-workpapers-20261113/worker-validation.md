# 渐进底稿 worker 验证记录（2026-11-13）

## 版本与边界

- 工作区：`BondBuddy-workpaper-progressive-20261113`，基线 `92bbba8f`；本记录对应最终提交前的源码，18 个相关源码/技能/迁移文件的原始字节 SHA-256 见 `worker-source-sha256.json`。
- 编译：`node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json` 通过。
- 数据库：独立本地 PostgreSQL `bb_progressive_template_v3`，每个 PG 测试克隆自己的数据库；未连接生产。
- PG 测试走真实 API、queue、PostgreSQL、durable model journal、Python 内容校验及 Word 渲染、成果注册/哈希/回读和计费结算逻辑。`PrivateBlobs` 由测试专用内存 Map 实现，未验证 Azure Blob；计费显式采用 `historicalBillingFixture:true` 固定历史价格。
- 模型是 synthetic stage，不进行真实 Copilot/DeepSeek 调用。测试证明调度、缓存、失败隔离与交付链路；不能据此推断真实模型内容质量、生产耗时或实际提速倍数。

## 最终结果

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| 分组渐进 PG：确认屏障、组内失败隔离、失败单项重试、格式 fallback、作者 schema 失败/取消、全局 provider 失败恢复、未核验图片阻塞 | 1/1 通过，0 跳过 | `worker-v3-final-attempt1.log` 第 1 项 |
| 固定章节分组、最多 8 项及 typed fallback schema | 2/2 通过，0 跳过 | 同上第 2–3 项 |
| 原 `shared_batch_v1` PG 兼容与目录依赖测试 | 12/12 通过，0 跳过 | 同上第 16–27 项 |
| 单项渐进 PG 与目录依赖测试 | 修正测试调度同步后 12/12 通过，0 跳过 | `worker-v3-final-item-recheck.log` |
| Python progressive helper | 11/11 通过 | `python-progressive.log` |
| Python shared/source/template 回归 | 27/27 通过 | `python-workpaper-regression.log` |

初次四文件联跑实际结果是 26/27 通过；唯一失败发生在取消场景后的测试调度假设：新 API 会先同步前一已取消批次中的已接收任务，该轮没有启动下一场景，执行器正确返回 `idle`。测试补上取消后的显式同步；生产实现没有因该问题修改。随后仅重跑受影响的单项 PG 文件，12/12 通过。不要将首次日志表述为单次 27/27。

原 300 份底稿 PG 在同次开发的 v2 本地模板上已由主代理验证通过；本轮没有重复运行。证据为 `worker-pg.log` 中名为 `300 workpapers: real API, PostgreSQL queue, pinned inputs, failure isolation/retry, billing and 300 ZIP entries (synthetic content)` 的单个通过子项，耗时 372.660 秒。该历史合并日志整体为 35 通过、1 失败（当时 progressive 版本的失败，随后已由最终日志覆盖），因此仅引用 300 份子项，不将整份历史日志视为全部通过。`worker-compatibility.log` 是退役入口旧 fixture 失败的历史诊断，不作为通过证据。

## 首文件与整批计时

| 场景 | 首文件交付 | 主场景总耗时 | 原文提取 | 模型调用 |
| --- | --- | --- | --- | --- |
| 5 份、试样确认后固定章节分组 | 13.711 秒 | 47.726 秒（含注入的单项内容失败及用户重试） | 1 次 | 3 次：试样 1 + 分组 1 + 失败项重试 1 |
| 3 份单项路径、缓存崩溃重放及交付重试 | 9.836 秒 | 29.692 秒（含人为阻塞、注入失败及重试） | 1 次 | 4 次；Word 交付失败的再次重试复用合法 item plan |

以上首文件计时均从提交批次 API **之前**开始。单项场景在慢 sibling 尚未释放前已经成功下载第一份 ZIP。分组场景在用户确认前严格只有 1 次试样调用，0 个组 receipt；成功文件的原 run/成果在失败重试后保持。

这些是 synthetic 模型的本地测试数据，两场景并非基准对照实验。分组 PG 后续另外覆盖五个故障批次，总计 6 个 batch、6 次 source 提取；首文件/总耗时只统计第一个 5 份主场景。作者取消在 provider intent 之前；其测试计数代表 stage invocation，不能视为发生了真实 provider 调用。

## 并发、恢复与内容保护

- 两个 worker PG 均使用 `Pool max=2`。分组缓存提交与真实 queue lease renewal 发生 1 次确定交错并成功；不存在长期持有连接的 session advisory lock。缓存提交按 run → job → transaction advisory lock 顺序。
- 原文提取由持久 ordinal 第一项唯一负责；组规划由固定小组第一项唯一负责。其他项短查询缓存/作者状态并等待，遵守 abort；未观察到 pool 饥饿或死锁。
- 合法组 item plans 与 receipt 原子保存、不可变；完整原文只提取一次。计划持久化中断后通过 durable model result 重放，不重复模型调用。旧 shared plan 表及旧 Python/技能入口保持兼容。
- JSON/schema 错误保存 typed `fallback`，其 items 必须为空，然后逐项规划；不能把 fallback 当成已接受内容。组内内容错误仅影响对应文件；显式失败重试独立规划，避免永远重放 immutable 组错误。
- 源 SHA、权限、未核验/损坏图片、provider、余额、lease 与 reconciliation 不降为普通单项失败。源 SHA 收集错误保留 `INPUT_REVISION_CONFLICT`，不能被包装成内容 schema 错误。
- 已确定的全局终态作者失败使等待项安全终态失败且不再自动调用模型；API 可显式重试。paused、awaiting_input、pending reconciliation 继续阻塞；取消、旧 lease 或其他 item/run/job 不会误判为当前单项失败。
- Python 校验保留完整源阅读、表格明细、跨章上下文、footnotes、原 excluded 冲突与图片核验；组内投影不删除原冲突，不接受相同模板化说明作为不同文件的有效理由。

## 迁移与交付

- 依赖 `0175_workpaper_progressive_batches.sql`（API）、`0176_workpaper_progressive_plans.sql`、`0177_workpaper_progressive_groups.sql`；仅在独立本地测试数据库执行过。0176/0177 分别保存 immutable 单项计划及轻量组 receipt。
- 新 Python helper 固定 LF，以维持跨主机 method hash；新的 progressive method v2 固定两个技能、helper 和组大小，旧 shared 方法的 hash 输入未更改。
- `git diff --check` 通过；Git 提示现有少数 TS 文件将被本机策略转为 CRLF，不是 diff 错误。
- 开发和自测完成；尚未进行用户验收、真实模型质量验证或生产部署。代码完成，尚未部署，待统一发布。
