# #1415 细粒度性能日志验证

日期：2026-11-15。环境：Windows Node 22、本地 PostgreSQL 16 专用容器 `bb-perf-1415-pg`；模型相关 Linux 验证单独记录。全部任务、账号、材料、模型响应均为 synthetic，未访问生产数据库或调用真实模型。

## 已验证的范围

| 验证 | 结果 |
| --- | --- |
| contracts/domain/rule-pack-registry/rule-applicability-context/API/worker 构建 | 通过；以包实际 tsconfig 顺序构建 |
| 合同已有测试（outcome-pricing / integrity-presentation / workpapers / naming / OCR v2 / issuer binding） | 72/72；0 skip |
| 合同示例 | 179 synthetic + 12 library + 4 data lifecycle，全通过 |
| 新性能 helper / 路由权限 / 属性隐私 / 有界采集 / 缺测单测 | 9/9 |
| 真实 PostgreSQL 性能链路 | 通过：归属隔离、1002 run 全范围聚合、稳定分页、并发未提交 INSERT 的 COMMIT 竞态、访问审计、幂等、legal hold、清理凭据、迟到记录不能复活 |
| 原有三类 batch dispatch / automatic billing 回归 | 10/10 |
| 原有 issuer resume queue 机制回归 | 通过：重复 resume 不修改 cursor/attempt，不新增模型调用，越权拒绝、冲突及可恢复暂停保持原行为 |
| 新 storage / pipeline 回归 | 4/4；真实 PG/队列/Word promotion/readback/登记/finish、重试与检查点复用；storage 使用内存适配器，模型调用为 0 |
| 既有 Word 检查与授权下载测试 | 4/4 |
| 管理后台相关单测 | 59/59，性能定向复验 17/17 |
| 管理后台浏览器回归 | 23/23，含新增性能用例 |
| 真实登录 → API → PG → 页面/导出 | 通过：旧快照 1000/1002，性能汇总完整 1002；214 span 按 200+14 翻页、3 次读取 audit 均存在；普通账号 404 |

源码与复现入口见 `apps/api/src/performance*.test.ts`、`apps/worker/src/performance*.test.ts`、`apps/web/tests/admin-performance*.{ts,mjs}` 和 [后台验收记录](admin-performance-20261115.md)。

## 迁移与测试样本修正

专用空库从首个迁移完整执行至 `0185_performance_spans.sql`，未跳过 SQL 断言。Windows CRLF 首次初始化在既有 `0180_batch_four_way.sql` 的函数文本比对处失败；新建干净模板后按 Linux checkout 的规范 LF SQL 重新全量执行，通过。没有修改既有迁移。

最终模板为 `bb_perf_template_v3`，测试按 `isolatedTestDatabase` 逐文件克隆；页面使用独立 `bb_perf_ui`。0185 的规范 LF SHA-256 为 `20f7e159dca10fc86137f03e93d79a073c1787b4e6455693314a4f0d83dc347b`。本批无第三方依赖新增。

首次性能 PG 样本 username 不符合既有格式限制，已修为合法的合成用户名后通过。旧 queue 机制样本锁定 legacy 输入，默认商业报价新门禁会拒绝该样本；该测试显式使用已有 `historicalBillingFixture/enablePaidAuthoring/enableOutcomePricing` 测试配置，服务默认值与门禁未变。Azurite 依赖的旧 queue 大型用例没有在这组 Windows 检查中执行，不能算通过。

## 采集开销

复现脚本：`node scripts/performance-timing-benchmark.mjs`，要求 `BB_TEST_DATABASE_URL` 指向可克隆的本地已迁移模板。对同一合成工作负载交替启停性能追踪，并使用真实 PG sink。

Windows 并发测试期间的 5 对结果受计时器调度噪声影响，出现负差值；6 个 session 均完整落库、0 drop / 0 flush error，但这不能证明日志提速，也不能据此确认约 1%–2% 的开销目标。Linux 补测结果另行补入本记录。

## 发布与验收状态

代码交付和自动化验证不等于用户已验收或已部署。新 API/worker/web 需要同批集成，先应用新增迁移，再更新应用。该批仍待统一发布；真实模型金样、用户验收和生产验证没有在这里冒充完成，也不继承上一批日志补丁的例外。更细资源采样、逐页 OCR、逐 SQL 和规模分桶等后续范围见 [实施说明](../FINE-STEP-PERFORMANCE.md)。
