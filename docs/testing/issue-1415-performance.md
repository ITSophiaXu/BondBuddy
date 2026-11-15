# #1415 细粒度性能日志验证

日期：2026-11-15。环境：Windows 后端 Node 22.14.0、页面 Node 24.22.1、本地 PostgreSQL 16 专用容器 `bb-perf-1415-pg`；模型相关 Linux 验证单独记录。全部任务、账号、材料、模型响应均为 synthetic，未访问生产数据库或调用真实模型。

## 已验证的范围

| 验证 | 结果 |
| --- | --- |
| contracts/domain/rule-pack-registry/rule-applicability-context/API/worker 构建 | 通过；以包实际 tsconfig 顺序构建 |
| 合同已有测试（outcome-pricing / integrity-presentation / workpapers / naming / OCR v2 / issuer binding） | 72/72；0 skip |
| 合同示例 | 179 synthetic + 12 library + 4 data lifecycle，全通过 |
| 新性能 helper / 路由权限 / 属性隐私 / 有界采集 / 缺测单测 | 9/9 |
| 性能最终补修复验 | 12/12，0 fail/skip/cancel，exit 0；含 9 项单测及 3 项真实 PG，覆盖断线隔离/重连、工具缺边界/超限与实测 exec 分位数保留 |
| 真实 PostgreSQL 性能链路 | 通过：归属隔离、1002 run 全范围聚合、稳定分页、并发未提交 INSERT 的 COMMIT 竞态、访问审计、幂等、legal hold、清理凭据、迟到记录不能复活 |
| 原有三类 batch dispatch / automatic billing 回归 | 10/10 |
| 原有 issuer resume queue 机制回归 | 通过：重复 resume 不修改 cursor/attempt，不新增模型调用，越权拒绝、冲突及可恢复暂停保持原行为 |
| 新 storage / pipeline 回归 | 4/4；真实 PG/队列/Word promotion/readback/登记/finish、重试与检查点复用；storage 使用内存适配器，模型调用为 0 |
| 既有 Word 检查与授权下载测试 | 4/4 |
| Linux 模型目录与原生 named sandbox 补测 | 6/6；应用沙箱保持启用 |
| Linux historical-model-stage | 64 pass / 2 原有显式 skip / 0 fail |
| Linux progressive 底稿 PG/Python 链路 | 12/12（含共用 fixture 校验） |
| Linux legacy shared 底稿 PG/Python 链路 | 12/12（含共用 fixture 校验） |
| Linux model-call-budget PG | 5/5；0 fail/skip/cancel |
| Linux 完整 group PG/Python 回归 | 1/1（含 6 个业务场景），0 fail/skip，容器及测试文件 exit 0，teardown 无未处理连接错误 |
| 管理后台相关单测 | 59/59；最终性能定向单测 19/19，含 2 类工具缺测 |
| 管理后台浏览器回归 | 23/23，含新增性能用例 |
| 真实登录 → API → PG → 页面/导出 | 通过：旧快照 1000/1002，性能汇总完整 1002；214 span 按 200+14 翻页、3 次读取 audit 均存在；普通账号 404 |

源码与复现入口见 `apps/api/src/performance*.test.ts`、`apps/worker/src/performance*.test.ts`、`apps/web/tests/admin-performance*.{ts,mjs}` 和 [后台验收记录](admin-performance-20261115.md)。

## 迁移与测试样本修正

专用空库从首个迁移完整执行至 `0185_performance_spans.sql`，未跳过 SQL 断言。Windows CRLF 首次初始化在既有 `0180_batch_four_way.sql` 的函数文本比对处失败；新建干净模板后按 Linux checkout 的规范 LF SQL 重新全量执行，通过。没有修改既有迁移。

最终模板为 `bb_perf_template_v3`，测试按 `isolatedTestDatabase` 逐文件克隆；页面使用独立 `bb_perf_ui`。0185 的规范 LF SHA-256 为 `20f7e159dca10fc86137f03e93d79a073c1787b4e6455693314a4f0d83dc347b`。本批无第三方依赖新增。

首次性能 PG 样本 username 不符合既有格式限制，已修为合法的合成用户名后通过。旧 queue 机制样本锁定 legacy 输入，默认商业报价新门禁会拒绝该样本；该测试显式使用已有 `historicalBillingFixture/enablePaidAuthoring/enableOutcomePricing` 测试配置，服务默认值与门禁未变。Azurite 依赖的旧 queue 大型用例没有在这组 Windows 检查中执行，不能算通过。

## Linux 环境与定向补测

使用独立临时容器、只读工作区挂载、synthetic 执行 host ID 和本地 PG 克隆库。首次容器缺少模型目录、历史测试 fixture 和执行 host ID，已补齐后仅重跑受影响范围。Docker 外层默认 seccomp 阻止 bwrap 创建 namespace；专用测试容器只放开外层 seccomp，应用 named sandbox / network=false 仍启用，未使用 privileged 或禁用应用沙箱。

容量测试原来在短轮询事务的瞬时采样上断言零事务，可能误中正常短事务；失败后又未释放 permits，导致后续级联超时。只修测试为有界等待短事务结束，并在 finally 清理 waiter/permits/pool，随后 5/5 通过；容量实现与权限行为不变。

首次 21 文件 Linux 广跑在 group 用例超时后中止，没有完整汇总，不能报成全套通过。已有模型性能 5 项、group 性能 4 项、schema 重问/usage/replay/sink 故障 2 项在该次运行中逐项观察通过；上表其余 Linux 结果来自独立补测，不相加成一个完整测试总数。

## 日志连接中断回归（#1421）

候选版本 b7f0da74 的完整 group 业务子测试已在 232.7 秒完成，随后克隆库清理触发 pg Client 未处理 error，文件 exit 1。此前 300 秒超时没有在独立运行中复现；90 秒基线观察仍在正常推进，不能据此声称旧版通过或存在既有死锁。

在真实隔离 PG 锁住性能表并仅终止 checked-out 性能写入连接，可以稳定复现同类进程退出。修复仅为独立性能池每个新 Client 保留连接生命周期 error listener；query rejection 继续上交给日志失败计数，业务连接池与事务不变。API 重新构建通过；`node --test apps/api/dist/performance.test.js apps/api/dist/performance.pg.test.js` 在 Windows Node 22.14.0 + PG16 上 11/11 通过（0 fail/skip，exit 0），其中新连接故障注入用例 348.98 ms。修复版 `node --test --test-concurrency=1 apps/worker/dist/workpaper-progressive-groups.pg.test.js` 在隔离 Linux 容器通过：1/1，0 fail/skip；业务子测 227.297 秒，文件总 233.582 秒，容器与监控均 exit 0，teardown 无未处理错误。[最终 TAP](evidence/issue-1415/group-fixed.log)。该容器使用 b7f0da74 加性能连接错误隔离补丁冻结的运行源码；后续 #1422 只修改读取统计与页面，不影响该 worker 执行回归。

合成模型的首份文件从提交计 16.277 秒，混合批次及失败项重试 52.508 秒；source_extractions=1，model_calls=3（group=1、single=2），renewal_interleavings=1。实际使用 API/PG/Python/私有存储；这些时长是测试场景证据，不能宣称生产优化幅度。

## 工具缺测完整度回归（#1422）

工具仅有 completed 事件、或超过每次 exec 的 128 条明细上限时，没有对应缺边界子 span。此前 API 和页面只检查 timing_complete，漏看 model.exec 的 tool_timing_complete=false，会误报完整。现 API 将此类步骤计入“未结束或计时缺测”，前端保留实际 exec 总时长、显示工具计时缺测，并将精确未解释时间保持未知。summary 的 exec 时长分位数仍使用实际已测区间。

最终完整性能定向组 `node --test apps/api/dist/performance.test.js apps/api/dist/performance.pg.test.js` 为 12/12、0 fail/skip/cancel、exit 0（Windows Node 22.14.0，真实隔离 PG16）；包含旧综合/断线/新缺测的全部三个 PG 用例。[最终输出](evidence/issue-1415/performance-final.log)。新 PG 用例覆盖 completed-only 和 128 个已测工具后另有省略两种场景。新样本首次设 succeeded 被既有已验证 Word 约束拒绝，改用 queued 合成 run 后通过，没有修改门禁。

前端定向单测 19/19；新增两类浏览器缺测回归 2/2。只读模型总时长、未知未解释值、警示文案和原型的对应状态均验证，截图见 [后台验收记录](admin-performance-20261115.md)。

## 采集开销

复现脚本：`node scripts/performance-timing-benchmark.mjs`，要求 `BB_TEST_DATABASE_URL` 指向可克隆的本地已迁移模板。对同一合成工作负载交替启停性能追踪，并使用真实 PG sink。

Windows 并发测试期间的 5 对结果受计时器调度噪声影响，出现负差值，不能证明日志提速。

Linux 在其他大测试结束后独立执行 5 对交替开关测量：每次 50 个顺序 20 ms 异步等待，使用真实隔离 PG sink。中位差为 -3.433 ms / -0.325%，范围为 -6.548 至 +36.029 ms / -0.620% 至 +3.458%；6/6 session 完整落库，0 drop、0 flush error，exit 0。[原始合成测量 JSON](evidence/issue-1415/linux-benchmark.json)。

负值反映调度噪声，不是提速证据；其中一对超过 2%，不能确认稳定满足 1%–2% 开销目标。计时只包括工作回调及 trace 包装，显式 flush 在计时区间外，因此没有测量后台持久化的全部 CPU/数据库成本，也不能代表生产模型性能。

## 发布与验收状态

代码交付和自动化验证不等于用户已验收或已部署。新 API/worker/web 需要同批集成，先应用新增迁移，再更新应用。该批仍待统一发布；真实模型金样、用户验收和生产验证没有在这里冒充完成，也不继承上一批日志补丁的例外。更细资源采样、逐页 OCR、逐 SQL 和规模分桶等后续范围见 [实施说明](../FINE-STEP-PERFORMANCE.md)。

## GitHub CI 状态

PR #1420 的 GitHub jobs 没有启动。已核对 Desktop UX integration 和 Prospectus mechanical quality 的 annotation：`The job was not started because recent account payments have failed or your spending limit needs to be increased.` 因此 GitHub CI 未验证，不能记为通过；本记录中的通过项均来自明确列出的本地/隔离 Linux 检查。

- https://github.com/ITSophiaXu/BondBuddy/actions/runs/43725668850
- https://github.com/ITSophiaXu/BondBuddy/actions/runs/43725668932
