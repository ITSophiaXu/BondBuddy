# Worker 的原任务输入与本次执行输入

日期：2026-10-27。基准 `16bcb5b4`，本地工作分支 `codex/desktop-ux-coverage-20261026`。没有推送、PR 或部署。G03 / UX-A03 与完整 UX goal 仍 active。

## 修复范围

原 resolver 同时返回数据库原任务的 `input_revision/input_hash` 和执行身份的 `inputRevision/inputHash`，pipeline 又将返回值强转为旧 `RunRow`。V1 两者相同，掩盖了 stage 将来继续读取原输入的问题。本轮把真实 worker 路径改为明确的执行投影：

- `bb_runs` 原输入、请求、报价、grant 和账务语义保留；原输入单独保存为只读 `originInput`。
- `resolveRunExecution()` 显式返回强类型投影；camelCase 身份和供既有 stage 使用的 snake_case 输入都取已解析执行。factory 是纯映射，不授予执行或收费权限。
- 投影及原输入元组冻结。拒绝把投影直接再次投影为原任务，以及序列化或带冲突字段的伪装。数据库断言必须显式提取原任务身份；数据库 head/count/V1 限制保留。
- 实际 pipeline 不再使用 `as RunRow` 丢弃身份。M1、M3 和 M4 loader 在读取材料前比较完整上下文与租约；M3/M4 gate 区分原输入断言与当前执行检查。
- 独立 writer 重新按 run → job 加锁，以 raw run 断言耐久执行，再核对上下文原输入和执行身份，返回重新读取的投影。M4 进度、复核报告及其他共用 writer 都走该路径。
- 原有测试 fixture 使用真实 resolver 或明确的 synthetic factory；故意错误的上下文以新对象构造，不能修改冻结的有效身份。

## 验证

Windows、Node 24.22.1、真实隔离 PostgreSQL 16.14 和本地 Python。verifier 清除供应商、云数据库和云存储环境；材料、模型结果、规则发布、余额和账务 fixture 均为 synthetic，没有真实供应商调用。最终采用集以 [summary.json](summary.json) 和 [selection.json](selection.json) 为准：

| 最终选集 | pass | fail | skip |
| --- | ---: | ---: | ---: |
| API 投影、准确输入、V1/租约与 prompt | 40 | 0 | 0 |
| Worker 投影、真实 loader、独立 writer 与报告 | 28 | 0 | 0 |
| M1/M3/M4 输入、阶段、暂停与报告回归 | 68 | 0 | 2 |
| 已适配历史编制、规则和修订 fixture 回归 | 132 | 0 | 4 |
| 契约检查 | 40 | 0 | 0 |
| 合计 | **308** | **0** | **6** |

共 314 项。3 项需要未配置的 Azurite，1 项是仅 Linux 的符号链接测试，2 项未开启获授权样本的显式 opt-in；没有将这些跳过项记为通过。样例与数据生命周期检查另行通过，不计入测试数；API 和 Worker 编译通过。

实际 PG 测试覆盖：项目另存不同的最新输入后，真实 pipeline 仍消费本次执行的准确输入，原请求保持不变；三类真实 loader 保留业务 snapshot/材料/要求；错误 lease、原输入、执行版本和 aliases 不得写进度或报告。纯映射和 mock DB 测试分别标明范围，不冒充 V2 或真实 PG 并发。

28 次 controlled invocation 的原件、命令、失败、编译、环境和停止记录均保留。4 次失败分别是初始 API 元数据类型缺项、Worker 旧 fixture 的只读/身份类型错误，以及下列两个 fixture 回归，均与最终采用集分开：

- 规则发布 fixture 用 UTC ISO 生成日期，而 PG 会话为 `Asia/Shanghai`，跨日时被正确的发布日期校验拒绝。仅在两个测试事务的 `BEGIN` 后设置 `SET LOCAL TIME ZONE 'UTC'`；生产规则、服务时区及负向来源/审核断言不变，`ROLLBACK` 恢复会话。
- M4 模板 fixture 原先在函数第三个参数 `refresh()` 中替换投影，第二个参数已先捕获旧对象，导致准确输入检查拒绝。现 wrapper 先刷新，再读取新投影；broker/hash/准确成果登记的负向断言保留。

## 精确记录

- before：`2026-10-26T22-56-17-333Z-source-before-3048-75077538`。
- after：`2026-10-26T22-58-10-205Z-source-after-49084-0ee09267`。
- 两端 **2,453** 项 source/build/配置逐项相同，SHA-256 `f3bf7deb9093a3d2e3a4ee8a1b3a30e1f026c9ec12bec48e20ae539d3313245a`；具体 roots 和文件明细在压缩快照中，不声称覆盖整台机器或所有依赖目录。
- stop：`2026-10-26T22-58-20-482Z-pg-stop-33276-718261a3`，在全部测试及最终文件比对完成后执行。专用端口 15540，实际 postmaster PID **48136**，启动时间 `2026-10-26T22:43:10.588Z`。停止审计只有原 `0027` 种子，没有 clone 或其他客户端，停后没有 PID 文件。

[manifest.json](manifest.json) 和 [raw-files.json](raw-files.json) 保存归档及解压原件 hash；[sources.json](sources.json) 将最终冻结源码与实际 Git 过滤后的暂存字节对应。独立复审的 [6 项 gate 记录](independent-g03-gate-recheck.txt.gz) 单独保留，不加进上述测试数；该记录先于最终 `stage: string | null` 类型对齐，保留其原源码 hash，不能冒称最终源码逐字一致。此类型修正没有改变 runtime JS；最终源码另经编译、正式测试及冻结核对。

## 边界

纯映射测试故意使用不同的原输入与执行输入，不代表数据库允许或授权 V2。真实 PG 验证仍要求原 V1，并检查项目最新草稿变化不影响固定输入，错误上下文不改变历史、模型调用或账务。

本轮没有采用补料、切换活动执行、追加报价或收费、执行后继模型调用或生成补料后的新 Word。必要重做采用用户已选的 B“另行报价，确认追加金额后继续”，具体 B1/B2 公式仍待确定。后续需要协调采用回执、准确历史工作读取、三类真实 stage、后继授权及 SQL 成果/交付边界；不依据本轮测试数提高用户旅程覆盖率或关闭完整目标。
