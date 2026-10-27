# 补料原稿声明与私有旧工作文件读取

2026-10-26；基于 `0f506703` 的本地增量，未推送、未部署。完整 UX goal / G03 保持 **active、未完成**。本切片只完善补料准备和内服文件读取；最终验证轮次及结果以 [verification-summary.json](records/verification-summary.json) 为准。

## 原稿声明与候选输入

M1 unified 暂停任务可在补料草稿中，为新增或替换的 historical/reference 原稿填写企业关系、原发行市场、原品种和原稿最新报告期。声明采用共享 `SourceProspectusSchema`，必须绑定该份新材料准确的 `material_id / material_version / sha256`；不从旧稿、同 ID 的其他版本、当前项目声明或目标报告期推断新稿信息。

声明仍缺信息时可以免费保存，但预览为 `needs_information / source_information_required`，不返回候选 hash。原冻结输入已有 `previous_output` 或 `edit_baseline` 时，每份变更的原稿还必须明确提交 `discard_previous_output:true`；未选择时显示 `source_baseline_choice_required`。该选择只从候选副本移除旧成果关联，并同步候选的 `authoring.source_prospectuses` 和 `update_details.source_prospectuses`；原输入、项目可编辑草稿、原 run/job 和旧成果文件保持不变。没有关联时不接受无意义的 discard；M3/M4 和普通材料也不能借这些字段改写来源。

字段沿原请求 hash、幂等回执、revision CAS、本机恢复、未知保存结果与冲突处理保存。共享原稿控件使用独立 scope 隔离临时年份/期末及 radio group；补料内原稿 change 事件停止向上冒泡，避免被其他页面的共享处理器误收。浏览器验收同时检查原稿字段、准确 PUT/CSRF/PG 回执、刷新保留、事件 capture/bubble 和项目 PATCH；经过主页面 800 ms 自动保存窗口，仍要求项目草稿、冻结输入和非空账本不变。

`prepared` 只表示候选输入能够完整编译。候选未被采用或持久化为新输入，没有新增执行、报价确认或扣费；“采用补料并继续”仍禁用。用户已选 **B：必要重做另行报价，确认追加金额后继续**，具体计价规则尚未确定，本切片没有自行补定公式。

## 准确文件来源与读取

`run-file-reference.ts` 对 `codex-file-word-v1`、`codex-m4-document-v1`、`codex-review-file-v1`、`review-revision-cli-v1` 和 `project-file-output-v1` 定义准确 collector envelope、文件名、路径、hash、大小上限和媒体类型。所有已声明文件均检查，包括可选文件与错误结果中的文件；宽泛目录前缀和递归发现的任意对象不构成授权。provider attempt 路径与本地 correction 路径有各自来源约束。

`listCapturedSupplementFiles()` 从准确补料 revision 的不可变保存工作派生内部 pin，绑定 owner/project/run、V1 execution/input、checkpoint/source hash、准确 provider result/schema 或 checkpoint 字段及文件元数据。`readCapturedSupplementFile()` 每次重算完整 pin，再按登记大小 bounded 读取并验证长度和 SHA-256；改动任何字段、跨 revision、业务来源错配、缺失或损坏字节均拒绝。

provider 路径通过原已捕获 result reader，在 prompt/result 内容锁下核验准确调用和结果、所属项目与账号可见性及内容 tombstone，锁覆盖嵌套文件读取。本地 correction 没有 provider result：必须匹配准确 `review_v1` execution 的版本、operation、input/origin、源材料 pin，以及合法 `review-correction-v2` export、非本 run 的来源和 `export_only:true` 快照。PG+HTTP 正例沿 claim→checkpointStage→人工暂停→免费保存，`result_count:0` 仍可对应六份准确 correction 文件；没有为它虚构模型调用或结果 JSON。

列出 pin 只表示冻结来源准确，不承诺字节现存或已经得到保留。缺少私有旧文件不阻塞免费保存补料；读取失败不触发重试模型、reconciliation、账本写入、公开 artifact 或下载 grant。公共回执继续只披露已保存工作的状态与计数，不返回这些内部文件地址。

项目文件底层分支还要求合法业务 manifest 和准确 operation 记录，但当前 project-file 任务没有 HTTP 补料准备支持。本轮没有伪造该用户路径；底层格式校验不能算作项目文件补料流程交付。也没有把暂停工作写入只接受既定成功成果的公开 `previous_output` 或放宽既有下载门。

原始 `owners/...` 工作附件仍缺完整写入 intent、inventory 和清理 tombstone；结果 JSON 的保留或清理不能证明附件生命周期已闭合。Blob 已写入而结果保存失败的孤儿窗口、附件先于 JSON 的清理、账号/项目删除和长期保留授权仍待补齐。当前锁及 reader 校验不替代这些设施。

## 验证口径

最终采用轮次见 [verification-summary.json](records/verification-summary.json)，重复轮次与纯函数子集不累计成新的业务旅程或覆盖率。

| 最终验证 | 结果 |
| --- | --- |
| contracts / API / worker / web 构建与 web TypeScript | 通过 |
| 契约样例 | 186 synthetic + 12 internal library |
| API / PostgreSQL | 194 pass、0 fail、1 既有 skip，共 195 项 |
| 真实 main / 合成 HTTP 桌面组件 | 8 / 22 通过，无失败、flaky 或跳过 |
| 候选编译 / 共享原稿 helper 预检查 | 19 / 2 通过；前者已包含在 API 计数内 |
| 准确文件提取独立 strict tsc / 纯测试 | 通过 / 10 通过；测试已包含在 API 计数内 |

最终 main 采用 `browser-real-1`、组件采用 `browser-ui-1`，API 采用 `api-test-2`。查看修正后的 [桌面截图](browser/browser-real-evidence-1/m1-source-declaration-isolated-viewport.png) 后确认 checkbox 紧凑、文字横向可读；真实几何为 checkbox 18×18、文字宽 903 px、整行高约 21.4 px，见 [视觉核对](records/visual-review.json)。Vite 保留既有大 chunk 提示。

API 范围包括纯候选编译、准确文件提取、真实 PG/session/CSRF/HTTP、安全暂停及保存、provider 和本地 correction 来源、pin 篡改、错误 scope/schema/checkpoint、缺字节/hash/大小、prompt/result tombstone，并比较输入、执行、调用、账本、捕获、outbox、artifact/grant 和私有存储副作用。既有 Azurite queue 环境用例的 skip 不能记作通过。没有新增数据库迁移，数据库和 reader 仍只允许 V1。

真实 main 使用真实 bundle、API、session、私有本地字节和隔离 PG；原 queued run/input 是明确标记的合成 seed，不声称通过真实模型执行创建。新增 M1 case 的 `edit_baseline` 是合法冻结元数据，没有伪造旧成果 artifact；先保存完整声明并确认仍需 explicit discard，再选择后保存 prepared、刷新并验证未采用。组件旅程另外覆盖同材料新版本不继承旧声明、原稿字段独立编辑、未知回执和 CAS 保留本页选择。截图采用桌面 1440×960，并检查水平溢出；手机端不在本轮范围。

这些证据不包含新材料采用后的业务 worker 执行、增量重做、真实供应商、Azure 或最终补料新版 Word 的正确性验收。合成 DOCX 输入和私有 byte identity 测试不能替代 Word 内容、修订和最终交付质量验收。

## 失败记录与修正

保留所有首轮日志和错误上下文，不覆盖为成功：

- **预检查编译**：新文件提取器、reader 及负例测试中的 `unknown`、symbol key 和 manifest 类型收窄导致 API TypeScript 错误。修正运行时检查后的类型边界和测试强制转换，保留准确路径及 schema 校验。原记录在 `records/source-precheck/api-build-1.log`。
- **预检查 fixture**：候选纯测试首轮 15 pass / 4 fail。新声明 fixture 的报告期为 `scope:null` 却标 `user_asserted`，违反既有确认规则，改为 `needs_confirmation`；另一个断言错误地假设新增原稿缺项必在第一条，实际原冻结旧稿也缺报告期，改为检查对应材料的 issue 确实存在，继续保留旧稿缺项。生产验证没有为 fixture 放宽。见 `records/source-precheck/compiler-unit-tests-1.log` 及后续轮次。
- **本地 correction PG 断言 SQL**：扩展后的 API 轮为 193 pass / 1 fail / 1 skip，共 195 项。测试误对只有 `job_id` 的 `bb_model_call_attempts` 按 `run_id` 查询；改为通过原 job 按 owner、job、run 准确联查，附近结果/快照/保存记录查询也补齐作用域。见 `records/api-test-1.log`；修正后的最终轮以 summary 为准。
- **隐藏 radio 的测试点击目标**：组件首轮 21 pass / 1 fail。原生 quarter radio 被可见 label 覆盖，直接 `.check()` 超时；改为点击用户实际可见的期末 label，并继续验证真实 radio 的 checked 状态、保存 payload 和恢复结果，没有强制绕过交互。见 `records/browser-ui.log` 和 `records/first-ui-failure/`。
- **真实 checkbox 视觉问题**：首轮 real-main 的 8 条功能断言通过后，截图检查仍发现 explicit discard checkbox 受通用输入布局影响，被拉大且文字挤窄。随后限定约 18×18 的 checkbox、独立可换行文字 span，并补组件与 main 的尺寸、间距和边界断言及可见文字点击验证。初轮截图只保留为缺陷证据，不能当修正后视觉验收；重新构建、截图和最终结果以 summary 所选轮次为准。

首次 `source-before` 快照包含 **2,041** 个源码、构建、测试及迁移文件。其后上述 SQL、测试点击和 checkbox CSS/几何断言发生修正，初始快照与最终源码存在有意差异，不能声称最初 2,041 文件全程未变。保留初始备份 `source-before-1.json`；修正并重建后重新冻结的 `source-before.json` 与最终 `source-after.json` 的 **2,041 项完全一致**。初始到最终的修改/新增/删除项见 summary 的 `source_binding`，不抹除首次基线及其失败证据。

## 复现、记录与隐私

在仓库根使用本机登记的 Node/Python 及依赖，按 `reproduce/` 脚本执行。驱动清除继承的 BB_/数据库/Azure/OpenAI/DeepSeek 配置，仅指向专用 PostgreSQL 16.14 `127.0.0.1:15526` 的 `bb_g03_template_20261026`；操作者须先核对并启动专用集群及已迁移到 0121 的空模板。PG 测试使用自己的 clone，不接真实用户库。main 自启 5198；组件验证自启独立 Vite 5199，结束后关闭自身进程，不操作共享 5173。

预检查驱动为 `reproduce/source-precheck-verify.mjs`，支持 contracts/API 构建、web TypeScript/单元构建、候选编译和原稿控件单元测试及契约样例。主驱动 `reproduce/verify.mjs` 支持 `api-build`、`worker-build`、`web-tsc`、`web-build`、`api-test`、`browser-real`、`browser-ui`、`source-before`、`source-after` 和 `database-final`。先完成依赖构建和所有修正，再冻结最终源码基线、运行验收并比较 source-after；不能在最终比较期间继续改源码。`reproduce/audit-stop.mjs` 核验准确 cluster 路径、端口、PID、模板和连接后停止专用 PG，`reproduce/summarize.mjs` 核对最终编号轮次和清理记录，`reproduce/collect-evidence.mjs` 收集归档。

最终模板 0 run / 0 execution，所有 `bb_g03_*` 数据库仅剩原专用模板，没有其他客户端连接；确认 cluster 为本任务 `.local/g03-postgres/data`、端口 15526、PID 41400 后停止。`pg_ctl stop` 退出 0，随后 status 退出 3，见 [清理核对](records/database-cleanup-audit.json) 与 [停止记录](records/postgres-stop.json)。

`records/` 保存命令、时间、退出码、编号失败/最终日志、Playwright 报告和 source hash；`browser/` 保存各轮截图及合成断言；[manifest.json](manifest.json) 登记文件路径、大小与 SHA-256。收集器排除 `private-bytes-*` 私有原字节目录和生成 Word/PDF，不提交客户原件或真实账号。JSON/截图仍可能含合成发行人、实验 object key 和 hash，应作为内部验收记录处理。公共 HTTP 的披露边界与这些内部合成证据不同。

正式采用的 CAS/幂等回执、后继业务快照和执行、版本化 checkpoint/模型工作单元、实际旧工作复用与增量处理、新输入授权、材料与附件生命周期、追加报价确认、累计账务及正确新版 Word 仍未闭环。G03 不关闭，也不据本轮测试数声称整体 ≥90% 或主要功能 100%。
