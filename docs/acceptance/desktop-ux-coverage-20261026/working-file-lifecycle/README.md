# 私有原始工作文件生命周期

2026-10-26；基于 `a35034b3` 的本地增量，未创建 PR、未推送、未部署。追加迁移 `0122_run_working_file_lifecycle.sql` 及 `0123_run_working_file_result_claims.sql`，保留已经应用的 `0122` 历史。完整 UX goal / G03 保持 **active、未完成**：本轮处理准确工作文件的登记、读取与清理，没有采用补料、后继执行、新计价或补料新版 Word 验收。

隔离模板已分别实际应用 `0122`、`0123`。API 采用“完整集合保留一次失败＋准确 fixture 修正后定向复验”的复合证据，未重跑完整集合，不能称为一轮完整 API 全通过。[verification-summary.json](records/verification-summary.json)已汇总实际采用轮次、独立计数、源码 hash 和本轮清理结果。此前[来源与文件读取专项](../supplement-source-files/README.md)及其他验收目录的日志、失败和通过结果保持原样，不将本轮代码倒记为此前已经验证。

## 写入前登记与准确来源

`@bondbuddy/api/run-working-files` 的 `writeRunWorkingFile()` 接入九个实际 writer 模块，替换原十处直接 Blob put；浏览器证据原有 PNG/TXT 两处写入，其余各一处。这里统计源码写入位置，不表示每次任务只产出十个文件。

| writer 模块 | 来源与准确文件布局 |
| --- | --- |
| `file-authoring-stage.ts` | provider；`file-authoring/<attempt>/<sha>/{tracked.docx,clean.docx,baseline.docx,delivery.md}` |
| `m4-document-stage.ts` | provider；`m4-documents/<attempt>/<sha>/{document.docx,preparation-note.docx}` |
| `review-file-stage.ts` | provider；`review-files/<attempt>/<sha>/` 下明确列举的报告、Markdown、批注和 annotations 文件 |
| `review-revision-cli-stage.ts` | provider；`review-revision-cli/<attempt>/<sha>/` 下明确列举的双稿、基线、handling/summary/proposal JSON |
| `review-correction-stage.ts` | local correction；`review-files/correction/<sha>/` 下六份明确文件；可以与准确 provider 结果共同引用同一物理对象 |
| `project-file-stage.ts` | local project-file；`project-files/<sha>/` 下检查报告或 revision/clean/baseline 三稿 |
| `project-qa-stage.ts` | local QA；`qa/<sha>/document.docx` |
| `integrity-stage.ts` | local integrity；`integrity/<sha>/{company.docx,person.docx}` |
| `integrity-browser-stage.ts` | local integrity browser；`integrity/browser/<sha>.png` 和 `<sha>.txt`；登记 filename 分别为 `capture.png`、`capture.txt` |

以上布局都位于准确的 `owners/<owner>/projects/<project>/runs/<run>/` 下。文件名、路径、hash、大小、MIME 和实际业务来源逐项核验，不能以宽泛目录前缀取得读写权限；browser 空 TXT 仅沿既有明确例外处理。局部测试允许的 writer 注入不代表生产绕过共同 writer。

迁移把物理对象、来源与状态分开：

- `bb_run_working_objects` 以准确 object key 为主键，保存不可变 owner/project/run、filename、SHA-256、byte_size、media_type、created_at。
- `bb_run_working_sources` 追加准确 job、V1 execution/input、source kind、结果 schema 和真实 producer attempt；实际旧结果发现还绑定准确 `discovered_result_id`。一个物理对象可以有多个准确声明，不能把单个 producer 当作物理文件的唯一所有者。
- `bb_run_working_object_state` 保存单调 `stored_at / purge_started_at / purged_at` 及清理原因、政策版本。`stored_at` 可来自新写入读回或当下的有效 legacy 字节观察；都不能回填虚构的历史生产时间。清理回执只关联物理对象，不在内容锁后新增 run/project/attempt 外键锁。

共同 writer 先核验关系范围和实际来源，在登记事务中取得 run/file 内容锁并提交对象与来源登记；随后另一个事务重新取得 run/file 内容锁，重验范围，写字节、bounded 读回校验长度/hash，记录 `stored_at`。登记在 Blob IO 前持久化；文件写成功而结果 JSON 未保存、结果验证失败或进程崩溃时，准确地址仍在。writer 复制输入 Buffer 后计算 hash，避免调用方在异步等待期间修改被写内容。

每个实际写入 hash 都登记，最终 JSON 选择了后写的报告，也不抹除前一个 report hash 的地址。共享 correction 文件保留真实本地和 provider 声明，不伪造第二份物理字节、模型调用或供应商用量。登记或文件缺失不构成模型重发授权，也不改变补料准备保存的免费边界。

`0123` 在原 source 唯一键上追加 `COALESCE(discovered_result_id,'')`，保留预写 claim 和同一 attempt 各个真实不可变结果候选各自的来源时间。它不修改旧 rows、时间或 `0122`，也不把冲突候选合并成唯一成功结果；清理登记不负责选择业务结果或消解调用冲突。

## 留存、父内容与失败恢复

原始工作文件沿用现有日志内容窗口 `BB_LOG_CONTENT_RETENTION_DAYS`，默认 180 天；年龄清理仅适用于终态 run，并核对物理对象及全部来源声明的时间。活跃和暂停任务继续保留。账号关闭沿既有关闭规则，项目删除沿现有 `deletedProjectPurgeDays` 所承接的 storage 删除窗口；本轮没有另设产品留存时长，也没有把补料草稿变成永久保留 pin。

到期后先在 run/file 锁下持久化 `purge_started_at`，再进行 Blob 删除并记录完成 `purged_at`。开始标记一旦提交就永久拒绝迟到存储和新来源声明，读取也拒绝以残留字节越过标记。删除失败、完成回执失败或删除后崩溃都保留准确重试地址；重试执行 delete-if-exists，不改写物理身份、已有来源、清理原因或历史完成边界。未存成功的登记也可到期清理，不需要先补造 result 或 stored 回执。

`purgeLogContent()` 在父 prompt/provider JSON 删除前，先处理准确来源：

1. 对已知文件 collector 的仍存旧 JSON，核验准确 execution/input、schema、长度/hash 和每份声明文件的路径，再登记实际发现的来源。
2. 对已登记 raw 但尚未形成任何 result 的 provider 写入，通过真实 attempt/input/prompt 绑定找到清理范围。
3. 完成该范围中到期附件的清理；失败或仍有到期未完成对象时保留父内容，不能把错误来源或损坏 JSON 解释成零附件。
4. 父内容按原日志策略、内容锁和 tombstone 删除。未到期且由较新准确声明保留的对象继续依靠持久清单，不因旧父内容消失而失去地址。

后续复核发现一个生产窗口：如果只发现正在清理的旧父内容，可能遗漏同 run 较新 legacy 结果对同一 correction 文件的引用；原 source 唯一键还会把同一 attempt 的多个不可变结果候选合并，丢掉较新的准确来源时间。修正后，尚未持久化清理标记的年龄候选先在 W/F 锁外发现该 run 全部已知 provider collector 结果，逐项在关系→prompt→result→run 工作→文件顺序下核验。mark 事务先持 run `NO KEY UPDATE` 锁，再比较发现前后的准确 result ID 集合；集合变化则保守失败，留给后续轮次重新发现，不沿用过期清单。集合不变才取得 W/F 并重新判断对象及全部来源是否到期。

已持久化的 marker 重试与账号/项目删除不依赖这次年龄发现，所以父内容在上次尝试后消失，也不会阻断准确地址的删除重试。`0123` 保证不同 prompt/attempt 和同一 attempt 冲突候选的较新来源都可保留；不是通过把对象永久 pin 住来回避清理。

首次 legacy 登记后，在准确文件锁下 bounded 读取 raw，只有长度/hash 均正确才记录 `stored_at=now()`，代表当下观察。有效文件被新登记后仍可供准确 reader 读取；缺失或损坏 raw 仍保留准确地址和来源，`stored_at` 为空，实际 reader 继续拒绝。观察不伪造历史预写入意图、不复活已开始/完成清理的文件，也不重置按对象和来源时间计算的留存窗口。损坏的已知父 JSON 仍按来源失败处理，不能解释成零附件。

独立工作文件清理还覆盖 local correction/project-file/QA/诚信文书及 browser 证据，以及最终 envelope 未选择的已登记 hash。独立 retention CLI 与用户删除 lifecycle 都经共享边界处理，不能只在其中一个入口保证附件先于父内容。普通账号关闭和项目删除继续先拒绝活跃任务并撤销访问，清理是后续私有字节生命周期，未新增业务删除入口。

## 读取、锁与存储扫描

关系范围锁在内容锁前取得。需要组合内容锁时，遵守 `prompt_snapshot → provider_result → run_work_files → run_file_object` 的相对顺序；路径可省略无需取得的锁，多个文件按准确 key 排序。不能持有文件锁后反向请求 prompt/result 或 run/project 行锁。Blob IO 和异步校验期间保持相应内容锁，清理开始与完成使用同一边界串行。

内服 captured-result/file reader 仍从准确补料 revision 的不可变 checkpoint 和真实已完成结果派生 pin，重算 execution/input/source/hash、核验归属，再 bounded 读取原字节。公开 readable-review 报告也把 provider JSON 与 `report.md` 放在 prompt→result→file 锁下读取，等待后重新检查账号/项目可见性、父内容 tombstone 和物理登记状态。已登记文件未存成功、开始/完成清理或元数据错配时，即使 Blob 残留也不可读取。有效 legacy 文件缺 registry 时继续核验准确旧来源，不为读取伪造历史预写入登记；读取没有新增公开 artifact、下载 grant、调用或收费。

`storage-inventory.ts` 新增 `owners/` 扫描和上表明确路径。已登记且 stored 的对象为 `referenced`，未完成写入为 `intent_pending`；未知文件、清理中和已清理后的残留归入独立保守诊断 `unregistered_working_file`。未知 owners 布局仍可诊断，但不能靠目录前缀删除。报告保留分类计数、大小、最早时间和有限 key hash；旧自动删除模式仍仅处理有迁移时间与 ETag 依据的 pre-0042 snapshot，绝不将它扩展为 owners 前缀删除。

准确旧 JSON 可核验时，登记的是发现事实和实际 immutable result 关系，不是“当年已有写入前 intent”。如果父内容早已被清理、原始文件又没有登记，当前清单可能只报告未知历史 raw，不能承诺已恢复完整来源或清除所有遗留对象。

## 验证状态与证据范围

| 检查 | 本文冻结时的状态 |
| --- | --- |
| 隔离 PostgreSQL 迁移 | `0122`、`0123` 分别实际应用；`migrate` 与 `migrate-1` 均退出 0，分别见对应 JSON/log。后一次日志只列新应用的 `0123`，不冒充重跑 `0122` |
| API 早期构建历史 | 退出 0，保留 `records/api-build.json` / `.log`；最终采用修正后的 `api-build-7` |
| 最终 contracts/API/worker/web 类型、构建与契约 | `contracts-build`、`api-build-7`、`worker-build-2`、`web-tsc`、`web-build` 均退出 0；`contracts-check` 退出 0，186 个合成示例、12 个内部库示例 |
| 工作文件专项 | `working-files-test-2`：31 pass、0 fail、0 skip；绑定保留的 `verification-freeze-2.json` |
| worker 集合 | `worker-test-1`：108 pass、0 fail、12 skip；绑定同一保留冻结 |
| API 完整集合 | `api-test-1`：295 tests，264 pass、1 fail、30 skip；唯一失败为 readable-retention 的准确清理用例，原失败保留 |
| API fixture 定向修正 | `readable-retention-test`：9 pass、0 fail、0 skip；新冻结后重测该组，原失败标题实际通过。未重跑整个 API 集合，不相加成一个全通过总数 |
| 真实 main、桌面组件及在途浏览器回归 | 本轮未运行，summary 均为 `not_run`；不借用旧轮次通过数 |
| 最终源码/构建 hash | 新 before/after 2052 项逐项一致，summary 重算当前文件匹配；旧冻结至新冻结只该测试源文件及编译 JS 两处改变 |
| 数据库与专用 PostgreSQL 清理 | 最终 schema 含 `0122`/`0123`，0 runs、0 executions、0 clones；专用 cluster PID 16128、15526 端口，空模板且无其他客户端；本轮 stop 退出 0、后续 status 3 |

本轮验证源码包括 `run-working-files.pg.test.ts`、`review-readable-retention.pg.test.ts`、既有 saved-work/输入/queue/provider/log/deletion 回归、inventory/readable-report 单元与相关实际 writer 回归。真实 PG 用例检查关系约束和内容锁等待、登记后无 result、多个来源/被替换 hash、暂停保留、终态到期、关闭/删除、单调清理标记、失败重试，以及读取等待后拒绝父 tombstone 或残留文件。修正新增跨 prompt/attempt 与同 attempt 冲突候选、raw/parent 清理入口的四组合，均检查较新共享来源保留、全部来源到期后再删除；跨 prompt/attempt 两组合还通过实际 captured reader 读取保留文件，同 attempt 冲突候选保持冲突事实。另测坏/缺 raw、坏较新父 JSON 和 marker 后丢失父内容的重试。测试源码存在不等于已经运行通过；真实 PG 锁证据与纯单元模拟分开采用。

此前来源与文件专项的 194 pass / 1 skip、main 8 条、组件 22 条仍仅支持其原轮范围，不与本轮数量相加，不用重复执行提升用户旅程覆盖率。合成私有字节和合成 Word delivery setup 不证明 Word 内容、修订、供应商或专业质量。

本轮首个完整 API 集合记录为 291 tests：234 pass、27 fail、30 skip，原始 `records/api-test.json` / `.log` 保留。失败包含新工作文件测试的 fixture 元数据问题，以及五个既有 Windows NDJSON 文件 sink 用例的 `Unsafe NDJSON lock permissions`；不将这些故障合并归因为一种生产问题。fixture 修正后 `working-files-test-1` 的 22/22 发生在后续 legacy 共享文件生产缺陷发现之前，只是中间结果，不能替代该修正后的最终复验。

`api-test-1` 的五个准确文件 sink 标题由 Node 名称模式排除，**不包含在该次 30 skip 内，也不增加成 35 skip**；准确模式保留在命令 args。它们没有通过。[sink-scope.json](records/sink-scope.json)记录 `a35034b3` 至本轮 `lockedNdjsonWrite`→`ndjsonFileSink` 实现及整份 `zz_log_ops.test.ts` 的规范化源码 hash 未变，且 `acceptance:false`。范围核对及排除均不构成 Windows sink 验收。

生产修正后的 `api-test-1` 唯一失败标题为 `real working-file purge waits for readable report validation and denies the next raw read`：合成的成功 `codex-review-file-v1` fixture 只提供 raw `report.md`，遗漏必要的准确 raw `report.docx`，由生产校验正确拒绝。随后只补该测试 fixture 的 Word 原始字节及准确引用，并增加有界清理首批 pending、后续批次完成的断言；公开 artifact 仍是独立对象。这次没有生产源码变动。`readable-retention-test` 在新冻结后运行 9/9，通过原失败标题；保留完整集合的 264/1/30，不能把定向通过加进去声称一个完整集合零失败。

所有首轮失败、编译错误、fixture 问题、真实生产缺陷、修正和复验日志都保留，由最终 summary 指向实际采用轮次；失败后不覆盖原文件，不将尚未运行写成运行失败，也不把后续修正倒记成首轮通过。API summary 状态为 `full_run_with_targeted_fixture_correction`，完整集合与纠正组分别列数，合计通过数为空。

## 复现、源码绑定与归档

验证驱动工作目录为仓库根，原工作文件位于 `.local/working-file-lifecycle/`；收集后使用 `reproduce/` 中的实际归档驱动。先核对本任务专用 PostgreSQL 16.14、`127.0.0.1:15526`、空模板 `bb_g03_template_20261026` 和 `0122`、`0123` 迁移，测试使用独立 clone，不连接真实用户库。迁移证明从本轮各次成功日志分别取证，最终数据库 schema 也须同时包含两条；不能只查看最新日志并丢弃先前真实应用记录。驱动清除继承的 BB_/数据库/Azure/OpenAI/DeepSeek 配置后只注入专用测试配置。

驱动提供 `migrate`、`contracts-build`、`api-build`、`worker-build`、`web-tsc`、`web-build`、`contracts-check`、`working-files-test`、`readable-retention-test`、`api-test`、`worker-test`、`browser-real`、`browser-ui`、`inflight-test`、`source-before`、`source-after` 和 `database-final`。实际参数、cwd、开始/结束时间、退出码和完整输出以各模式的 JSON/log 为准。可选真实 main 使用 5198，桌面组件使用独立 Vite 5199，不操作共享 5173；可选在途调用测试使用受控本地 adapter，不冒充真实供应商。驱动具有这些模式不代表本轮已运行浏览器。

冻结记录包含创建时间、快照原字节 SHA-256 和文件条数。31 项工作文件、worker 108/12 skip 及 API 完整集合 264/1/30 均在保留的 `verification-freeze-2.json` 之后开始、最终新冻结之前结束，并绑定 `source-before-2.json`。该快照与新 `source-before.json` 都是 2052 项，实际差异仅为 `review-readable-retention.pg.test.ts` 及其编译 `.js`；summary 自动限制全部增删改只能属于这份测试及准确编译产物，拒绝任何生产文件变化。初始 2051 项快照仍保存在 `source-before-1.json`，不冒充后来的数量。

`readable-retention-test` 在新 `verification-freeze.json` 之后开始，原失败标题出现在实际通过日志。最终 `source-after.json` 与新 before 2052 项逐项一致，summary 已重算当前实际文件，收集器还会再次核验。构建和契约示例检查可以先于冻结，不把每个 receipt 误称为自带源码 hash。这里验证两次冻结之间的准确 fixture 修正及复合采用范围，不声称所有测试都在最后冻结后完整重跑。

本轮 [database-final.json](records/database-final.json)确认 schema 为 `0123`/`0122`、模板 0 runs、0 executions、无测试 clones；[database-cleanup-audit.json](records/database-cleanup-audit.json)在实际专用 cluster/端口 15526 核验仅保留空模板、无其他客户端。随后 [postgres-stop.json](records/postgres-stop.json)记录同一 PID 16128：停止退出 0、停止后 status 3。这些是本轮实查记录，不借用旧轮 PostgreSQL 停止结论。

`records/` 保存实际命令、各轮 JSON/log、源 hash、测试报告、迁移和清理记录；`browser/` 保存实际运行截图/断言；`reproduce/` 保存驱动；[manifest.json](manifest.json) 记录归档相对路径、大小和 SHA-256。收集器排除私有原字节目录及生成 Word/PDF，不提交客户原件或真实账号。合成 key/hash、截图和 seed 信息属于内部验收证据，不能当作公共 API 的披露许可。

## 仍未覆盖的边界

- 父内容已清理且未登记的历史 raw 不能由新登记机制补造完整历史；未知清单只诊断，人工处置仍需准确来源依据。
- `bb_review_editors.snapshot` 等不可变数据库 editor 正文的生命周期没有在本轮修复，不能宣称账号/项目的全部数据库正文已清除。
- provider JSON 自身的一般 durable pre-write intent 窗口没有由 raw 文件登记补齐；既有 prompt intent 继续独立工作。
- 当前数据库和 reader 仍只允许初始 V1。没有新材料采用/CAS 回执、后继业务快照、增量模型处理、新输入授权或补料新版 Word 的完整链。
- 用户已选择 B“必要重做另行报价，确认追加金额后继续”，具体定价公式仍待确定，本轮没有新增价格或费用确认。

G03 与完整 UX goal 不关闭，不依据本轮测试数宣称整体至少 90% 或主要功能 100%；没有 PR、推送、部署、真实供应商或 Azure 验收。
