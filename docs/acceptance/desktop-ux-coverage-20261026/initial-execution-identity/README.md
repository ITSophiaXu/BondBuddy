# 原执行身份贯通与调用中暂停验证

日期：2026-10-26；起点 `7e516600`；分支 `codex/desktop-ux-coverage-20261026`。这是 G03 / UX-A03“暂停、补料、继续同一任务”的必要内部前提。**完整 UX goal 仍为 active，G03 未闭合。**

## 实际变更

新增 append-only 迁移 0119，为已有和新建 run 保存独立、不可变的初始执行身份，包含归属、项目、run、执行版本、固定输入 revision/hash。当前数据库 CHECK 和执行器都只允许 V1；V1 指初始执行版本，原输入 revision 可以大于 1。没有活动版本指针、V2 执行、补料采用或计价公式。

真实 claim 将三个身份字段放入必填 Lease；worker 的 runPipelineOnce 与平台探针用 resolver 读取同一身份。队列写入、恢复和重入、供应商 intent/observation/runtime/result reuse、正式 OCR、提示词登记和独立 worker 写入均检查它。缺失、不一致或多份执行记录拒绝处理，不回退原 run 字段。用户暂停和取消保持可用。完整材料/manifest 及业务输入校验仍由既有输入门执行，身份表不替代它们。

迁移先按 input → run 顺序取锁，避免与现有任务创建相互等待。提示词登记按 project → run → intent 取锁，保留 intent 补偿；runless 提示词不增加执行身份查询。正式 OCR 中断批次只允许当前 run 的合法身份结算；预检不能结算正式任务批次。

## 本轮验证

| 检查 | 结果及范围 |
| --- | --- |
| API build、worker build、web TypeScript | 全部通过；没有新增公共协议或产品 UI 修改 |
| [API 定向回归](api-final.log) | **79 pass / 0 fail / 1 skip**，104.676 秒；新执行身份、提示词锁竞争、OCR purpose/执行边界及原准备专项全部执行 |
| [worker 定向回归](worker-final.log) | **55 pass / 0 fail / 2 skip**，102.195 秒；真实 resolver、独立写入、暂停、OCR 和相关既有合成阶段 |
| [调用中暂停完整主页面](inflight-final.log) / [报告](inflight-report.json) | **1/1**，27.1 秒；受控子进程在途暂停、真实持久化和原任务结果复用 |
| [原完整主页面回归](regression-final.log) / [报告](regression-report.json) | **6/6**，38.9 秒；M1、M3、M4、复核成果续改、准确丢失回执恢复与两个独立 context 的 CAS |
| [迁移旧历史回填](backfill-summary.json) | 6 个历史 run；原输入、任务、检查点、提示词、调用、事件和 outbox 完全不变，包含旧 run/input hash 不一致的历史原样保留。未把旧损坏修饰为可执行输入 |
| [真实迁移并发](migration-lock-result.json) | 实测迁移等待 input 时未持冲突 run 锁，既有事务可创建 run 并提交，迁移准确回填它；新 run 的 V1 与原任务同事务可见、回滚和提交 |
| [源码与构建一致性](source-check.json) | **1,988 文件前后相同**，覆盖 API/worker/web source 与 dist、web tests、contracts 和迁移 |
| [隔离库最终状态](database-final.json) | 模板迁移至 0119；run/execution 都为 0，无本轮残留克隆；专用 PostgreSQL 随后停止，见 [停止日志](postgres-final.log) |

Node test 统计包含父子测试，不能当作独立用户场景数。API 的历史 Azurite queue 用例、worker 的历史 Azurite M4 端到端用例及 Windows symlink 用例未执行，不计为通过；本轮新执行身份、锁竞争及 OCR 边界用例须全部执行。没有重跑全仓库测试或累加历史通过数。

所有数据为 synthetic；真实 PostgreSQL 16.14、HTTP/session/CSRF、完整 main bundle、Playwright/Edge 和私有本地字节。没有 principal override、API response fixture 或合成页面壳，浏览器外网请求会失败。worker adapter 使用受控本地 Node 子进程与真实 durable journal，非真实供应商。

页面连续流程为：实际 worker 启动受控 adapter → 用户请求暂停 → run/job 在结果保存期间仍 running、持原租约，补料不可保存 → adapter 完成，结果字节、调用记录和 checkpoint 持久化 → 下一阶段尚未执行，进入 user_paused 并释放租约 → 实际上传、保存补料、刷新恢复 → 明确选择原材料继续 → 同一 run/job 被重新领取，复用一次原结果，下一阶段仅执行一次。断言只有一次 adapter 启动、一次调用、一次 runtime 和一个结果引用，原输入和非空 10,000 积分账本不变；保存只新增准确的补料 outbox。摘要见 [调用中断言](inflight-assertions-summary.json)，原始 synthetic 数据库快照仅留本地 `.local/initial-execution/`，摘要固定其哈希。

## 画面和复验

视口为 1440×960，全页为 1440×2519，均已实际查看。完整主页面无产品 UI 修改；补料来源、保存回执、尚未采用和原材料继续可读可达，页面无水平溢出。分别查看 [等待当前工作保存](m1-inflight-pause-pending-viewport.png)、[补料保存后视口](m1-inflight-saved-viewport.png)及[全页](m1-inflight-saved-full.png)。既有原型对照和产品决定仍沿用前次记录，不把本轮截图当作完整新输入续做或产品负责人签认。

复验时将本目录的 [verify.mjs](verify.mjs) 和 [migration-lock.mjs](migration-lock.mjs) 复制到 `.local/initial-execution/`，从仓库根执行。驱动清除继承的 BB_/DATABASE/AZURE/OPENAI/DEEPSEEK 配置，仅使用本机专用 15526 模板和 5198 主页面服务；配置 bundled Python 供现有合成 Word/OCR 测试使用。先在 0118 模板运行 `node .local/initial-execution/verify.mjs migration-backfill` 和 `node .local/initial-execution/migration-lock.mjs`，再以 `verify.mjs migrate` 将空模板迁移一次至 0119；之后依次用 verify 的 `api-build`、`worker-build`、`web-tsc`、`source-before`、`api-test`、`worker-test`、`inflight-test`、`regression-test`、`source-after`、`snapshot` 模式验证。两个浏览器 spec 必须使用独立 Playwright 进程，避免复用已清理的数据库 clone。所有服务/clone 关闭后停止专用 PostgreSQL。

保留 [首次失败说明](initial-failures.md)、[首次 worker 输出](worker-first.log)、[首次页面输出](inflight-first.log)和[首次 web 类型输出](web-tsc-first.log)。首次 API build 的原始输出只在工具记录，未事后伪造日志。首次 worker 测试误把既有 retry 返回写成必须抛异常，首次页面测试只领取一次而遇到 SKIP LOCKED；分别修正测试预期及实际 runtime 使用的有界 idle 重试，保留诊断和无写入断言。没有为通过测试放松生产身份或锁约束。

文本副本只统一行末及行末空白，截图字节不变；本轮证据独立保存，不改写历史验收记录。

## 仍需完成

用户已选 B：必要重做另行报价，明确确认追加金额后继续。B1/B2 具体定价基准仍待决定，不能自行选用。本轮没有新输入采用、后继执行版本、M3/M4 版本化业务快照、重做范围/旧工作复用、追加账务、材料/成果授权与生命周期闭合，也没有真实供应商、Azure 或最终新 Word 全旅程验收。G03 继续保持 functional_gap / design_gap，新输入续做仍为 not_run。

仅本地提交；未推送、创建 PR 或部署。
