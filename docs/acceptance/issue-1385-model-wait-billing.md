# #1385 模型名额等待期间停止动态计费

用户于2026-11-15确认：等待平台处理名额不收费，恢复后继续计费；本次修复不追溯改动历史账本。关联 #684 的有效工作时间规则。

## 实现

新增迁移 `0182_model_wait_billing.sql`，`bb_run_model_activity` 按每次请求 UUID、owner/run/job 和当前 lease token 保存 waiting/active/abandoned。这是计费活动投影，不替代共享模型许可，不变更任务状态或执行阶段。

`CodexDurableJournal` 在调用容量预算前登记 waiting，因此覆盖本进程 enter 队列与共享 PostgreSQL 队列。取得名额后登记 active；进程退出及结果处理结束后释放。即使账务记录失败也仍尝试释放真实许可；已有结果直接复用时不会创建新的等待请求。

状态转换和原有计费函数共用 run→job 锁，先采样旧区间，再更新活动，最后开启或冻结新时钟。有 waiting/abandoned 且没有 active 时将计费 lease_until 置空；恢复时从新的数据库时间开始，不追补排队时间。同一任务有任一 active 时继续原有效时间计费，不因其他并行请求等待而整单免费。

等待失败/取消后保留 abandoned 冻结标记，避免异常处理尚未完成就重开计时；其他 active 请求不能删除它。明确开始新执行阶段才清理该标记，新 claim 清理旧租约记录，终态清理全部活动记录。迟到旧租约回调无权修改新租约。

原计费公式、检查点比例、上限、暂停/取消/失败/交付结算政策保持。固定报价不因排队增加价格，未改共享四路或0181托管执行容量策略。

## 界面与契约

`AuthoringProgress` 在 `packages/contracts` 中新增可选 `model_waiting`；服务端仅对当前有效租约、无活动调用且确实在等待时返回true。页面显示“正在等待模型处理名额”“等待期间积分不增加”，原暂停、余额耗尽与终态优先。未改 run.state/stage 或复用初始队列的 queue_ahead。

原型 `product-prototype/public/authoring-live-progress.html`，实现 `apps/web/src/authoring-progress.ts`，基线 `1c35cc25`。本轮用户已确认上述等待体验；仅增加该状态，不变更布局或导航。

## 验证与交付

固定应用代码：`025508a263fa457f93359f2d32c89380babd962d`，基于 develop `1c35cc257163ce0f822966a00d36cf2840e78751`。最终补充仅涉及测试夹具和本验收记录；运行代码及依赖不变。PR #1388。

| 验证 | 最终结果 | 范围与证据 |
| --- | --- | --- |
| 全工作区构建 | 通过 | contracts/domain/rule-pack-registry/rule-applicability-context/API/worker 的 TypeScript 与 web 的 tsc/vite；`build.log`，最终 API/worker 重编译 `build-final-api-worker.log` |
| 测试类型检查 | 通过 | 全 worker 测试及最终两份 PG 回归测试文件与依赖；`final-test-types.log`、`final-regression-types.log` |
| 公共契约 | 72/72 | 179 公共、12 内部、4 生命周期示例；`contracts.log` |
| 前端状态单元 | 11/11，0 fail/skip | `node --test --test-reporter=tap dist-test/authoring-progress.test.js` |
| Chromium 浏览器 | 6/6，0 fail/skip/retry | 模型等待、暂停结算、余额耗尽及恢复，1440/390 两种宽度；`apps/web/test-evidence/model-wait-billing-20261115/README.md` |
| 新容量计费 PG 回归 | 11/11，0 fail/skip | `node --test --test-concurrency=1 apps/worker/dist/model-capacity-billing.pg.test.js`；`capacity-billing-regression-verified.log` |
| 既有 PG 回归 | 41/41，0 fail/skip（按有效最终用例去重） | 原组有效 33 项与 budget/parallel-QA 补跑 8 项；`existing-pg-regression.log`、`budget-and-parallel-qa-retest.log` |
| 原库迁移兼容 | 通过 | 专用克隆的 285 张原业务表原列摘要保持，排除迁移登记及正常心跳；旧 API 读取原两项成功任务、旧 worker 获取/续租/释放许可通过；`old-db-migration-compat.json` |

PG 使用 Linux Docker / Node 22.23.2 和独立模板 `bb_model_wait_20261115_template`，真实 API、PostgreSQL、任务租约、模型容量和账本，材料及积分为 synthetic；模型调用 0。前端浏览器是合成 HTTP 夹具，只证明页面及交互。本轮不改生成内容算法，不将此前 8a8f 的真实 Copilot 单题问答证据视为本版本重新执行。

新 11 项覆盖更新/生成/复核等待冻结及恢复不追补、本进程 enter 队列（尚无 PG waiter）、任一 active 并行调用继续计费、暂停/取消、旧 lease 迟到回调、SIGKILL 后新 lease 恢复、等待失败的清理间隙，以及 abandoned→另一路 active→finished 后继续冻结。

既有 41 项涵盖 `queue-renewal-locks.pg.test.js`、三类 `authoring/m4/review-dynamic-balance.pg.test.js`、`billing-safety-integration.pg.test.js`、`parallel-state-locks.pg.test.js`、`authoring-progress.pg.test.js`、`execution-node-capacity.pg.test.js`、`model-call-budget.pg.test.js`、`parallel-qa-journal.pg.test.js`。同样通过 `node --test --test-concurrency=1` 执行；完整参数、源码 hash、日志与运行脚本位于本机共享证据目录 `work/model-wait-billing-20261115`，不含私有数据库连接。

初轮失败均保留，不能称首轮全绿：新测试先后为 8/11、9/11、10/11，通过补合成价格种子、每例结束时真实 API 取消遗留任务、把子进程冷导入与业务租约等待分离后，最终 11/11。冷导入 IPC 就绪前不创建任务；导入最多 180 秒，业务登记等待仍为 15 秒，SIGKILL 本身未被模拟。旧模型预算夹具直接改 parent_start 被 0181 不可变身份约束拒绝，并因旧测试缺 finally 泄漏许可；保留拒绝断言，以合成旧父身份 INSERT 夹具覆盖真实子进程存活/退出回收并完善清理，budget 6 + parallel-QA 2 最终全部通过。未为测试放宽运行时约束。

迁移兼容首次 restore 因旧 SQL 函数依赖 search_path 失败，随后受控恢复显式设置 public,pg_catalog，约束仍全部执行；CRLF 工作区临时证明单独保留。最终兼容证明使用固定 Git blob 的 LF 字节，0181 SHA-256 `d102fc7b1a1c620d28610c608aafbc134c9fc3336d7834baea62272746f8e838`，0182 SHA-256 `f9f7cf78cae4d8d6e4e89cafa35e75d4bff9fbf865f1d6f5dcca6aaa056b5279`。

GitHub 托管 CI 未启动：已读取 check annotation，原因是 recent account payments failed / spending limit；见 `hosted-ci.json`。本地通过不等于托管 CI 通过。

最终统一验收待办：5295 固定版本切换后的实际环境核验、用户本地操作验收及未来统一发布后的功能核验分别登记。版本构建不等于环境已切换，环境可用不等于用户已验收；本次未部署生产。

追加表不重写旧任务、价格或账本。迁移后旧二进制可读取原表，但旧 worker 不执行本修复，不能把混用新旧 worker 称为修复已生效。集成环境须协调 API、worker 和 web；本批未部署生产，最终统一验收待办。
