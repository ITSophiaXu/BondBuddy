# 已删除项目的四份复核正文副本

日期：2026-10-27。本地切片，基准 `f0ac8fff`。没有推送或部署；G03 / UX-A03 和完整 goal 仍 active。

## 范围与实现

修复 `runDeletedContentPurge()` 只清成果 Blob、旧项目回执又会永久跳过正文的缺口。本切片仅清理以下四份 SQL 正文副本：`bb_review_editors`、`bb_review_execution_editors`、`bb_review_reports`、`bb_review_execution_reports`。其他项目正文不在该回执范围内。

- 活动项目和仅归档的项目继续保留业务正文；终态日志的普通保留期不构成删除依据。
- 仅用户已删除、且超过配置删除窗口的项目可被清理。候选及 DELETE guard 均使用数据库时间；调用方的未来 `policy.now` 不会缩短业务正文窗口。非有限删除时间不占用正常批次。
- 实际剩余正文决定候选，独立于历史 `bb_deleted_content_purges` 成果回执。因此旧回执不阻止补清，且不会被重写或重复计数。内部生命周期结果单独报告 `reviewBodies` 的项目数、正文行数及失败数，失败也进入原总失败数。
- `0134` 只替换四表自己的 DELETE 例外，原全局 `bb_reject_snapshot_change` 不变。UPDATE 永远拒绝；四表和回执表的 TRUNCATE 也拒绝。
- 精确事务策略、项目实际删除时间、配置窗口和完整执行来源共同约束 DELETE。AFTER DELETE 在同事务保存原身份/hash/微秒时间和政策，不保留正文；回执失败会回滚删除。直接伪造回执、改写或删除回执均拒绝。即时约束模式同样可工作，事务局部策略在提交后清除。
- 服务按 project → run → job 加锁。四表所有 INSERT 在原 exact/bridge 前取得项目 `SHARE NOWAIT` 并重新核对状态；这也覆盖 `ON CONFLICT DO NOTHING`。SHARE 阻止普通 `deleted_at` 更新越过在途写入；NOWAIT 使旧 run-first 写入安全失败，避免反向等待。不可逆项目删除也封住尚无正文的新 key，无需把空项目回执当作全项目完成。

迁移只追加。安装使用 NOWAIT 表锁，旧写入未排空时整次安装回滚，稍后重试；本切片不替代 `0133` 的[旧 storage worker 停止与排空要求](../material-retention-barrier/README.md)。

## 验证

真实隔离 PostgreSQL 16.14、Node 24.22.1；所有材料、正文、余额和账务数据均为 synthetic。测试通过私有 clone 运行，模板只保留原 `0027` 平台种子；供应商、云数据库及云存储环境由 verifier 清除。没有真实模型或云 Blob 调用。

最终采用结果以 [summary.json](summary.json) 的 `adopted` 为准；命令及完整输出见各 `runs/` 压缩原件，复跑不相加。专项覆盖：

| 最终选集 | pass | fail | skip |
| --- | ---: | ---: | ---: |
| 四表清理与并发 | 9 | 0 | 0 |
| 0133 → 0134 升级与安装竞争 | 2 | 0 | 0 |
| API 删除、editor、report、工作区与可读报告回归 | 37 | 0 | 1 |
| Worker 报告写入、登记和恢复回归 | 31 | 0 | 2 |
| 契约检查 | 40 | 0 | 0 |
| 合计 | **119** | **0** | **3** |

共 122 项。API 的 Azurite 删除旅程，以及 Worker 的两条 Linux/Azurite 文件交付旅程按其环境条件跳过，本机为 Windows 且未配置 Azurite。样例检查另外通过，不加到测试数。API、Worker 编译均通过。

1. 四表真实删除、旧成果回执回访、原 PostgreSQL 微秒时间、4 份无正文回执和幂等性。
2. 输入、初始执行/head、run/job、两份复核业务来源及非空 account/lot/event 前后逐行一致；另一个 owner 的已删除项目正文不受影响。
3. 活动/归档项目跨普通日志保留期继续保留；未到删除窗口及错误策略、归属、隔离等级均拒绝。
4. 第四张表失败时前面删除及回执全部回滚，重试正确完成；直接回执、改写、TRUNCATE、四表精确重放、新 key 和 legacy bridge 均不能恢复正文。
5. 两方向真实锁依赖：旧 run-first writer 不阻塞父级删除；在途 INSERT 确实阻塞普通项目删除，提交后的正文可被后续清理看到。
6. 原 0133 四表 schema 上的完整 0134 升级保留现存 live/deleted 正文及来源；旧 writer 占锁时安装 NOWAIT 失败并完整回滚，再安装成功。

已有“损坏 canonical 存储应拒绝读取”的测试会人为删除活动项目正文。新增审计正确拒绝了原夹具；现仅在私有 clone 的外层回滚事务中临时关闭该表 immutable 和删除 recorder，造出不可能的历史损坏，随即恢复两个保护再做读取断言。hash 损坏分支同样先恢复 immutable。其他 INSERT/来源/交付/回执保护始终保持，生产例外没有放宽。

原始失败独立保留：早期并发测试的局部 Promise 类型编译失败，以及上述旧损坏夹具的回归失败。最终采用只取修正后的明确冻结运行，不把失败改记成通过。

## 证据与边界

[selection.json](selection.json) 明确最终运行和暂存源码；[sources.json](sources.json) 将测试快照与实际 Git 过滤后的暂存字节对应；[manifest.json](manifest.json) 与 [raw-files.json](raw-files.json) 保存压缩及解压原件的大小/hash。专用 PG 的启动身份、数据库审计和停止回执均保留，未复用旧进程 PID。

- 最终 before：`2026-10-26T22-25-26-563Z-source-before-51000-217939ff`。
- 最终 after：`2026-10-26T22-28-11-230Z-source-after-7896-6b539b72`。
- 两端 2,448 项逐项相同，快照 SHA-256：`f7abe42149a06fd2f38d24c2f56400872da64efb21e53a9963cb0ac872c2423f`。
- 停止：`2026-10-26T22-28-22-704Z-pg-stop-34112-14edac8c`。本次启动 PID **38412**、启动时间 `2026-10-26T22:16:19.800Z`；停止审计无 clone/其他客户端，审计表只有原 `0027` 种子，停后无 PID 文件。
- 最终文件比对于 `22:28:11.239Z` 开始、`22:28:28.089Z` 完成；独立停止审计于 `22:28:22.711Z` 开始、`22:28:23.755Z` 完成，时间有重叠。开始时间取 `start.json` 而非目录 ID 生成时间。两者都在全部最终测试结束后；文件比对不访问 PG，数据簇不在文件快照范围内。原始时间不改写，归档明确记录该顺序。

这不是整个项目正文清理。input manifest、legacy/canonical business snapshot、delivery naming 全输入副本、M4 正文/预览、文本交付证据、job/saved-work checkpoint，以及项目草稿、消息、提案、QA/诚信与其他业务正文仍需各自闭合；其他 live 项目的正文不能因来源引用被跨项目清理。

没有补料采用、后继执行、追加报价/收费、模型续做或更新 Word，也没有新增桌面旅程通过数。B“必要重做另行报价并确认”已确定，B1/B2 计算公式尚待用户选择；本次通过数不转换成整体覆盖率，不据此关闭 G03 或完整 goal。
