# 复核成果登记绑定准确执行（0129，本地）

新增按 run、执行版本、kind 登记的成果位置，以完整执行/输入关系和准确 artifact 来源约束。最终交付前保留真实重试替换行为；交付回执或成功终态后只允许精确重放。新旧 V1 写入原子镜像，旧历史 gap/未就绪候选保留来源，不新增交付权限。API、Worker、结算 readiness 和交付成员/命名读取准确登记，无 legacy 兜底。

| 独立集合 | pass | fail | skip |
| --- | ---: | ---: | ---: |
| api-registry | 10 | 0 | 0 |
| api-editor-migration | 8 | 0 | 0 |
| api-regression | 94 | 0 | 0 |
| worker-regression | 81 | 0 | 1 |

构建覆盖 contracts/API/Worker 和 web 类型检查；contracts 样例/生命周期及原有定向测试通过。各集合/轮次不相加，不代表 UX 场景覆盖率。Worker 的 Windows symlink 项仍跳过。

原始记录共 138 文件、23 次完整调用，失败调用 4 次；完整失败与重试日志保留。冻结共 2 对，最后一对 2297 文件，前后及封存时源码一致。包含 Python 源码，排除 __pycache__，外部运行时不在冻结范围。verify.mjs 调用保留原始命令参数、时间、退出结果和逐版 verifier；源码路径/大小/哈希见冻结记录。两次 api-profile 仅保存各自命令/结果/日志和原 hook 字节，helpers 的 launcher 为最终 file URL 版，首次 launcher 本体未逐版冻结。manifest 不包含自身。

## 失败与采用口径

- `2026-10-26T18-36-41-191Z-pg-start-direct-13976-e7bcc2f2`：connect ECONNREFUSED 127.0.0.1:15540
- `2026-10-26T18-43-27-861Z-api-regression-25448-76a7775a`：C:\Program Files\nodejs\node.exe exited 1; see C:\Users\lezhai\Downloads\Bondbuddy\ux-coverage-20261026\.local\execution-review-artifacts-20261027\runs\2026-10-26T18-43-27-861Z-api-regression-25448-76a7775a\run.log

1 !== 0

- `2026-10-26T18-45-59-946Z-api-artifact-probe-48080-118a8297`：C:\Program Files\nodejs\node.exe exited 1; see C:\Users\lezhai\Downloads\Bondbuddy\ux-coverage-20261026\.local\execution-review-artifacts-20261027\runs\2026-10-26T18-45-59-946Z-api-artifact-probe-48080-118a8297\run.log

1 !== 0

- `2026-10-26T18-48-37-518Z-api-profile-1932-e2f42370`：See raw result and log.

首轮 API 回归为 94 tests / 92 pass / 1 fail / 1 cancelled：0125 锁回放测试第二次清理时尝试恢复依赖已删除表类型的旧交付函数，修正 test-only helper 为仅在交付表存在时恢复。另一项绑定拒绝测试触发原 30 秒上限，单独 probe 也曾超时；逐条 SQL 诊断没有改产品或上限，随后 18.4 秒完成。首次诊断启动器使用 Windows 路径作模块 URL 而失败，改 file URL 后成功；两次诊断均保留，不计入完整 API 通过数。最终采用完整 API 重跑。

采用运行 ID、精确计数和冻结对见 summary.json，只有成功的完整重跑被采用。测试启动的数据库克隆已清理，原迁移 platform seed 保留，业务行为空、其他连接为空；专用测试 PG 按准确目录/端口/PID 停止，最终回执见 2026-10-26T18-58-19-366Z-pg-stop-13448-d63befe1。数据库升级是 0128→0129；新迁移另在私有克隆回放，不称重建全部历史迁移。首次启动的就绪探测失败后只核对同一个已启动 PID，不重启第二个实例。

各采用集合分别绑定其实际源码冻结窗口，不笼统归为同一源码版本。两对冻结之间的变化为：apps/api/dist/review-artifact-migration-test-fixture.js、apps/api/src/review-artifact-migration-test-fixture.ts。Worker 采用前一稳定窗口，完整 API 重跑验证修复后的 helper；没有把前轮失败记为通过。封存时重新枚举冻结 roots 的完整文件集合，并逐条核验字节/hash。

## 限制

材料与 DOCX 为合成字节；数据库、promoter/readback、finish、租约和并发锁是真实本地实现。未调用外部模型、生产系统，未新增浏览器验收。复制的 Playwright 配置仅为 verifier 依赖，未运行浏览器模式。迁移调用当时未记录 SQL 字节哈希；最终冻结只保留 SQL 路径/大小/哈希，正文在仓库 db/migrations/0129_review_execution_artifacts.sql。

全局 V1/current-input gate 保持，M4 成果登记、后继执行采用、阶段/调用身份、真正增量处理、B 追加报价/账务、材料/正文留存和完整桌面同任务续做仍未完成。B1/B2 尚待用户决定，未代入公式。G03 / UX-A03 和整体 goal 均保持 active；本轮没有推送、PR 或部署。
