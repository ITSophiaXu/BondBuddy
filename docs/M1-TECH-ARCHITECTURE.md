# M1 统一技术栈与四人协作基线

状态：供 M1 团队评审的技术方案。产品范围和验收以 `product-prototype/product-specs/`、GitHub M1 issue 为准；本文件固定实现方向和跨模块接口。若需改变选型或公共契约，先在同一个 PR 更新本文件及受影响的接口契约，再合并实现。

## #12 上传后续实现（2026-09-25）

新增迁移 `0018_m1_upload_reuse.sql`，通过 owner/project/role/hash/大小/MIME 和项目锁复用已保存材料版本；私有不可变完成凭证保存冗余 upload → 原材料精确版本关系。保留原 `MaterialResponse` 结构和材料事件格式，复用只写 `upload.reused` outbox，不重复写 `material.persisted`。冗余字节沿既有 received → deleting → purged 清理流程，完成凭证独立保留，清理后仍可重放；已删除材料不恢复、原对象缺失不报成功。公共 `M1_UPLOAD_LIMITS` 固定已保存版本 60 份 / 500 MiB，单份 100 MiB；临时上传空间由 #8 生命周期管理，尚不是预留配额。前端最多并行两份、真实字节进度、先核对旧 session 再续传。详见 [实现与验收记录](../apps/web/UPLOAD-ACCEPTANCE.md)；#8 生产存储/压测与 #76 消费识别闭环仍是交付条件。

## 1. 技术栈

| 层 | M1 选型 | 采用方式 |
| --- | --- | --- |
| 用户界面 | Node.js 22、Vite、原生 ES modules、现有 CSS | 以 `product-prototype/public/` 的交互为起点，逐页接真实 API。新模块用 TypeScript；旧 JS 用 JSDoc 和 `// @ts-check` 渐进检查。M1 不做 React 重写。 |
| Web API | Node.js 22、TypeScript、Fastify、JSON Schema/OpenAPI | 单个 API 服务处理身份、项目、材料、对话、任务查询和后台管理。所有公开接口统一 `/api/v1`。 |
| 持久化 | PostgreSQL 16、SQL migration、`pg` | 用户、项目、版本、任务、租约、参考库、审计和 outbox 存关系库。正式运行数据不再写到原型的 JSON 文件。 |
| 大文件 | Azure Blob Storage；本地开发使用 Azurite | 原件、OCR 派生文件、Word 成果和受控 prompt 正文使用私有容器。数据库只保存引用、hash、版本和授权范围。 |
| 后台执行 | 独立 Node.js worker 进程 + PostgreSQL 任务表/租约 | API 在事务中创建任务及事件；worker 用 `FOR UPDATE SKIP LOCKED` 领取，定期续租，崩溃后按检查点恢复。M1 不另引入 Redis/BullMQ。 |
| 文档处理 | Python 3.11+；`python-docx`、`pdfplumber`/`pypdf`、`openpyxl`、`pypdfium2`、Tesseract | 复用 `product-prototype/python/` 与 `backend/` 中可验证的解析、OCR 和 Word 逻辑，通过受控子进程传入文件引用/结构化清单，输出版本化 JSON；不让 Python 直接改业务数据库。 |
| AI 接入 | 隔离的 Codex 执行进程、DeepSeek 适配器 | 以 #16 的真实协议联调结果确定 Codex CLI / app-server 接口和准确模型 ID。适配器统一记录请求、重试、usage 与结构化输出；凭证只在服务端。联调未通过不启用真实更新。 |
| 部署 | Docker Compose、Nginx + TLS、Azure VM | 基于现有 `deploy/vm/` 演进为 web/api/worker/PostgreSQL/Azurite(仅开发) 的独立进程。生产 Blob 使用 Azure 服务；密钥由部署环境注入。先保持单区域部署，后续再按负载拆分。 |

版本号为兼容基线；具体补丁版本由 lockfile、容器镜像 digest 和部署清单锁定。DeepSeek 实际模型 ID、存储地域与保留期限必须在真实接入时记录，不在代码中猜测。

## 2. 一张图看边界

```mermaid
flowchart LR
    B[浏览器 Vite UI] -->|HTTPS /api/v1| A[Fastify API]
    A --> P[(PostgreSQL)]
    A --> O[(私有 Blob)]
    W[Node worker] -->|领取任务/续租/写事件| P
    W -->|读取材料/写成果| O
    W --> D[Python 文档子进程]
    W --> G[Codex + DeepSeek 适配器]
    G -->|服务端凭证| M[DeepSeek]
    A -->|授权下载| B
```

浏览器只负责输入、展示和显式操作。API 是身份、权限、版本和任务提交的权威入口。worker 不接受浏览器直接调用。Python 只处理文件和结构化文档数据。规则包和参考库在服务端选用；个人上传材料不会自动进入公共参考库。

现有 `product-prototype/server.mjs` 的内存队列、JSON 账号/项目、演示短信和模拟积分只能作为交互与算法参考；`backend/server.py` 是旧 Cowork 路线，不作为 M1 第二套线上 API。M1 是平台承担成本的受控试用，记录真实 token 和用量，但不创建模拟余额或扣费。

## 3. 首批必须固定的契约

四个人从同一份 OpenAPI 及数据库迁移工作。公共 DTO 的字段、枚举、错误码在 API 仓库目录定义并生成前端类型；不得在页面和 worker 各自复制枚举。实现目录建议如下：

```text
apps/web/            # 现有产品 UI 逐页迁移；唯一 API client
apps/api/            # Fastify 路由、鉴权、权限、OpenAPI
apps/worker/         # 领取任务、编排、检查点、模型调用
packages/contracts/  # JSON Schema/OpenAPI、枚举、错误码、事件格式
packages/domain/     # 与 HTTP/数据库无关的事实、适用性、规则判断
python/              # 文档解析、OCR、Word 生成与结构化输入输出
db/migrations/       # 单一顺序的 SQL migration
deploy/              # Compose、Nginx、部署与回滚
```

这是一条迁移目标路径，不要求先移动所有原型文件。新代码进入目标目录；移植原型逻辑时在 PR 中写明来源、覆盖边界和旧入口处理方式。

### 最小数据和 API 契约

| 契约 | 固定规则 |
| --- | --- |
| 身份 | `user_id` 为所有个人项目资源的 owner；Cookie 为 HttpOnly、Secure、SameSite，写操作校验 CSRF/Origin；服务端逐对象校验 owner。 |
| 项目输入 | `project_id`、`input_revision`、`input_hash`；每次提交执行锁定不可变输入清单。更新草稿用 revision 乐观锁，冲突返回 409。 |
| 材料 | `material_id` + `material_version` + SHA-256 + Blob 引用 + role；上传完成时服务端校验大小和 hash，才进入解析队列。 |
| 事实/证据 | 值与 `entity`、期间、口径、单位、材料版本、原文锚点、置信/确认状态绑定；OCR 不确定数字不能变成已核实事实。 |
| 任务 | `run_id`、`execution_request_id`、`input_revision/hash`、`state`、`stage`、租约和检查点。用户重复提交同一键只得到同一 run；不同输入返回 409。 |
| 事件 | 每条含 `event_id`、`schema_version`、`trace_id`、`run_id`、序号、时间、阶段、状态；数据库事务同时写业务变更与 outbox。UI 按事件游标恢复。 |
| 模型调用 | `logical_call_id`、`attempt_no`、供应商请求 ID、模型/规则/模板版本、prompt 引用、真实 usage 与来源。usage 缺失为 `unknown`，不得写 0 或按估值冒充实耗。 |
| 成果 | `artifact_id`、`run_id`、文件版本/hash、质量检查结果、授权下载引用；仅成果验证可获取后标记 `succeeded`。 |
| 规则/参考库 | `rule_pack_version`、`reference_version`、`index_release` 在 run 开始时锁定。只有审核发布且授权有效的参考稿可被选用，内部候选不下发普通用户。 |

第一批 OpenAPI 至少覆盖注册/会话、项目草稿、上传完成、预检、执行/取消/恢复、任务事件、成果下载和右侧对话。请求与响应按 `16-数据模型接口与状态机.md` 细化；分页、错误码、时间格式、空值含义在 schema 中写明。新接口不直接暴露现有原型的文件路径、运行目录或内部参考稿 ID。

### #6 首批契约与可运行骨架（2026-09-24）

仓库根目录用 npm workspaces 管理 `packages/contracts/` 与 `apps/api/`，不接管现有 `product-prototype/` 的独立包。`packages/contracts/src/index.ts` 以 TypeBox 定义可导入的值、TypeScript DTO、JSON Schema 和 OpenAPI 操作目录；`examples/synthetic.json` 与 `npm run check:contracts` 验证合成样例。`apps/api/` 的 Fastify 服务只实现 `/health` 和 `/openapi.json`，其余 `/api/v1` 路由在 OpenAPI 标为 `contract-only`，不能当作已实现或上线。Node 22 环境从干净检出运行 `npm ci && npm run build && npm run check:contracts && npm run test:api && npm run start:api`。

公开路径统一 `/api/v1`。产品规格 16 的 `/platform/v1` 是较早的前缀，按本架构与仓库协作约定采用 `/api/v1`；#8 依赖 CTO 对 #6 公共契约的技术验证与集成。Web 材料的账号隔离服务端副本、云端/模型处理、加密、保存/删除和备份清理文案草案及尚待发布决策见 `packages/contracts/WEB-DATA-LIFECYCLE.md`。生产期限、地区和供应商条款仍需发布前确定并实测，骨架不宣称已经做到。

此切片没有持久路由，因此本地 PostgreSQL/Azurite 尚不启动。#8 接入身份、owner、材料、事务/outbox 时再加入数据库迁移、本地对象存储与真实隔离/恢复集成测试；#79 完成日志持久化与检索，#16 确认真实模型标识和协议。关闭浏览器后同一 run 可查询的行为在契约样例中演示，并非已部署验收。Chris、Felix、Xuefeng、Maxy 的字段消费与待实现边界见 `packages/contracts/README.md`。

#6 契约修订采用规格 04 的七类普通材料格式及现有 `project-fields.js` 的 M1 更新材料分区；声明 MIME 不可信，服务端核对真实内容。历史稿识别响应逐字段保留来源、不确定性和报告期集合；公开的项目材料 `ProjectEvent`、运行 `RunEvent` 与仅供受信服务使用的 `InternalObservabilityEvent` 分开。草稿 PATCH 在服务端合并旧值后校验市场/发行方式组合，不能只校验局部 JSON。具体值、错误码与交接说明仍以 `packages/contracts/` 为唯一公共定义；#79 的日志持久化不因本次 DTO 定义而视为完成。

### #11 更新项目表单与草稿持久化切片（2026-09-24）

在 #10/#12 已有的 `apps/web/` 中扩展新建及编辑表单，保留同源 API client、登录/会话隔离、项目列表、串行自动保存和材料上传。新增历史稿有/没有、展开的选填信息、市场/发行方式联动、灵活债券与机构描述、多项资金用途和右侧补充说明。DFI 仅属于交易商协会下的发行方式，未定金额为 null；不增加注册模式问卷。409 保留本页输入，用户可自行复制后明确放弃并加载服务器新版；不自动覆盖。嵌套值比较忽略 JSONB 对象键顺序，资金用途数组顺序仍影响草稿变化。运行与测试说明见 `apps/web/README.md`。

`packages/contracts/src/update-project.ts` 补充规格 05 已确认的草稿输入，POST/PATCH/GET 的 `update_details` 为兼容旧客户端而可省略；PATCH 省略时保留，出现时完整替换，null 表示未知。`0013_m1_update_project_details.sql` 仅新增项目 JSONB 列，服务端合并默认值并校验真实日期和不同单位的金额比较。项目改动及 outbox 同事务；新 input manifest 包含完整用户输入，旧快照不重写。目标字段独立于原稿识别；补充输入未经模型处理/证据确认。表单数据与真实 PostgreSQL 16 联调，不代表材料事件恢复、真实多轮对话、模型调用或 Word 交付已打通。公共契约、迁移和 UI 随集成验证；本切片不解除 #8/#16/#18/#79 的剩余联调与上线门槛。

### #76 source-profile correction contract extension

`RecognitionPatchRequest` remains compatible with market/offering correction callers, while allowing either field to be omitted and adding an optional complete replacement `reporting_periods` list. Each corrected period carries its own `evidence_refs`; the top-level list retains its existing source-market/offering meaning. The schema requires at least one correction target. The worker checks all cited anchors against the exact owned material-version/parser snapshot, appends an immutable profile, and derives the latest cutoff only from valid period spans. Periods and the derived cutoff remain `user_asserted` with uncertainty even when anchors exist, so a correction cannot make the profile ready. No API route or UI is added by this contract/repository slice.

### #79 logging foundation slice (2026-09-24)

`0005_m1_observability.sql` adds append-only operation, snapshot reference, model usage observation, structured error and internal event records on top of #17 queue state/outbox. The internal event writer validates the shared `InternalObservabilityEvent` contract; each event is committed with an outbox reference. Trusted owner-scoped service queries record an access audit. Usage aggregation counts failed attempts but returns null token totals when measured observations conflict, until explicit reconciliation; unknown, pending and conflict remain unresolved. Cached and reasoning subsets are not added to totals. The database binds snapshot references to runs in the same owner's project. Snapshot metadata points to a verified private Blob object but the privileged prompt retrieval workflow, log forwarder, alarm sink, retention purge and real supplier adapter remain release gates. Production execute/cancel/resume stay 501; owned production execute rejections retain requested revision/hash without creating a run. Details and restore guidance are in `apps/api/README.md`.

## 4. 关键流程

### #17 queue implementation slice (2026-09-24)

`0004_m1_durable_jobs.sql` and `apps/api/src/queue.ts` implement PostgreSQL job leases, checkpoints, owner-bound run events and transactional outbox transitions. `apps/worker/` is a separate Node process with an injectable synthetic processor; its shipped CLI refuses production execution. The existing run and event DTOs remain the public contract. The API's real entry point still returns 501 for execute/cancel/resume until #16 provider verification, #79 operation/prompt/attempt/usage/error logs and a real checked Word generation path are integrated. A pending provider attempt pauses on recovery and requires supplier reconciliation before resume. This slice establishes queue mechanics and does not assert real update acceptance. The explicit test-only queue option is for local integration tests, and the existing prototype and Cowork applications are untouched.

`0007_m1_provider_result_reconciliation.sql` appends immutable owner/project/job/run/call/attempt bindings for provider result candidates and observations; it is independent of the concurrent #8 `0006` storage migration. A result is stored as JSON in the private Blob container by content hash; a single candidate with measured, non-conflicting #79 usage is added to the job checkpoint in the same transaction as its observation and outbox event. The worker must read and revalidate that checkpoint result before calling a provider, so a completed attempt is reused after restart. Missing/unknown/conflicting evidence remains paused; a second result hash is retained as a conflict rather than selected. A measured supplier failure ends the run as failed with no automatic retry. A verified `confirmed_not_sent` observation requires an explicit resume and a new attempt number before sending. These seams remain synthetic/internal only and do not enable the production routes or replace Word delivery checks.

### #13 native document parser slice (2026-09-24)

`python/bondbuddy_document_parser/` is the versioned Python subprocess boundary for native DOCX, PDF, XLSX, CSV and TXT parsing. The trusted worker stages an owner-authorized immutable material version, passes only the internal `document-parse-request-v1` request, and revalidates the `document-parse-response-v1` material ID/version/hash before accepting records. The parser also re-hashes staged bytes and never returns the local path. DOCX uses an effective view that includes insertions and excludes deletions without changing the source, with paragraph/table/cell anchors rather than invented page numbers. PDF records retain one-based pages and source coordinate boxes; XLSX/CSV/TXT retain native cell or line positions. Uncovered Word parts, image-only PDF pages, hidden sheets and uncached formulas remain explicit `needs_confirmation` conditions; encrypted, damaged, hash-mismatched or over-limit input fails without partial-success claims.

This slice does not add public HTTP DTOs, database persistence or production queue activation. OCR/image parsing remains #14, durable evidence/fact/cache persistence remains #15, and #8/#17 must connect private Blob staging, parse jobs, events/outbox and recovery before production use. The old Cowork service and prototype JSON storage remain untouched. Reproducible synthetic tests and the internal protocol are documented in `python/README.md`.

### #19 rule-pack domain and release gate (2026-09-24)

`packages/domain/` owns the HTTP/database-independent `rule-pack-v1` schema, validation, immutable content hashing, exact applicability gate, production publication, withdrawal and append-only rollback event. It imports market/offering values and combination validation from `packages/contracts/`; pages, workers and individual rule packs must not copy those enums. A pack is scoped to one exact market/offering pair, so `public_all` cannot cover `public` and an NAFMII pack cannot cover an exchange context. Runtime capability selection returns only eligibility/reason codes and applicable rule IDs, never a compliance conclusion or prompt text.

Production publication requires verified sources, source/pack validity, enabled non-research rules, authorized real positive/negative/boundary sample results, and separate industry/technical attestations completed before release. Draft, test-channel, withdrawn, expired, source-expired, mismatched or evidence-incomplete packs cannot advertise capability. Rule/source text remains data under a strict schema with no prompt/system/tool fields; any future model rendering is a separate versioned boundary. The checked-in example is explicitly synthetic, unverified, disabled and draft-only, and does not claim coverage for any product. `0018_m1_rule_pack_release_ledger.sql` and the internal worker seam persist only test-channel release/withdrawal/rollback history with exact hashes and transactional outbox events. Reviewer IDs and sample classifications in this seam are untrusted test metadata; no production publication or capability selection is enabled. Authenticated operator/industry review, signed production artifacts, real authorized sample evidence and a production selector remain release blockers for Felix/Maxy integration and #20–#30 acceptance.

### #17 Word delivery validator and promotion gate (2026-09-24)

`0010_m1_word_delivery_evidence.sql` is the append-only #17 Word quality/delivery gate after accepted account lifecycle migration 0009 (0008 is the #7 username/password migration). `inspectDocx` checks the actual ZIP package, CRC/decompression, XML, required OOXML parts, content types and relationship targets/references under fixed archive, part, XML, entry-count and compression-ratio bounds. The trusted worker seam validates candidate bytes before writing; it records immutable owner/run/hash-bound evidence and promotes only after a bounded private-Blob readback has the same size and SHA-256. Duplicate promotion and lease recovery reuse the same artifact/evidence identity. `queue.finish` repeats the bounded read, rechecking evidence and Blob bytes; a later missing/mismatched Blob read appends unavailable evidence and revokes the row. Owner-scoped metadata/download routes also use evidence-sized reads and compare the stored hash. Database triggers reject available artifacts or successful runs without matching evidence. The validator is structural only: it does not render, assess financial/legal content or substitute for professional review. No real Word generator is installed, so worker integration fixtures are synthetic and production execute/cancel/resume remain 501.

1. 用户完成用户名密码登录，API 建立会话；前端创建项目草稿并按 revision 保存。
2. 上传经 API 创建受限会话，Blob 接收字节；API 核对 hash 后登记不可变材料版本，worker 解析/OCR 并登记证据锚点。
3. 用户预检和执行时，API 校验 owner、材料、目标市场/品种、规则能力与输入版本；事务内写 run、首次 job event 和 outbox。M1 标记 `billing_mode=platform_trial`。
4. worker 领取任务，保存每阶段检查点；读取锁定的材料、规则、参考库版本；执行 Codex/DeepSeek；每次模型尝试写可追溯 usage 或 `unknown`。
5. Python 生成 Word 修订/清洁版，worker 检查文件完整性、来源和交付清单，再写成果版本与终态。浏览器关闭不改变 run；重开后用 `GET /runs/{id}` 和事件游标恢复。
6. 外部模型、存储或日志故障时，按同一 run 和检查点恢复。已经发出的模型请求先对账，不能直接重发；无法持久化关键事件时停止新的外部调用并告警。

## 5. 四人工作面与交接

### #10/#12 浏览器项目与材料上传切片（2026-09-24）

`apps/web/` 以 Vite、原生 TypeScript 和原型的视觉样式接入现有 `/api/v1`，复用 `packages/contracts` 类型。当前覆盖已有账号登录、会话刷新/退出、本人项目分页列表、已加载名称搜索、新建项目、名称/发行人自动保存，以及按公共固定分区上传文件。每个文件有独立上传会话、XHR 字节进度、服务端保存/核验阶段、失败重试和取消；只有 `complete` 返回材料版本才显示服务端确认成功。刷新恢复读取项目材料事件并按 owner-scoped material ID 拉取当前状态，不从浏览器存储恢复个人数据；#12 的初始 UI 切片缺少服务端事件读取，后续 #8 项目事件切片现已提供此恢复路径。409 保留输入且不覆盖服务端新版本；跨页账号切换清除旧页面内容。

项目材料恢复使用 0011 持久化的 owner-scoped `ProjectEvent` 项目序列；只有 Blob 内容核验并保存成功后才写终态 `material.upload_progress`，事件和材料/outbox 在同一事务提交。分页默认 50 条、上限 100 条；恢复时再通过 owner-scoped 当前材料读取排除已删除或 Blob 缺失记录。该切片不宣称完成 #10/#12：同内容去重、历史稿重复识别抑制、扫描/加密/缺页提示的完整验收仍待完成。默认 upload tests 使用合成 API fixture；独立的 project-events browser integration 运行本地 PostgreSQL/Azurite API 与 Blob，但不构成目标环境/TLS验收。全局搜索、类型/状态筛选、归档仍依赖后续接口；#11 已补齐业务字段，#18、#34 的完整工作区后续接入。不迁移旧原型认证/JSON/模拟账务，不开放真实执行。运行、测试与剩余交接见 `apps/web/README.md`。

| 负责人 | 主改动面 | 必须与谁对齐 |
| --- | --- | --- |
| Chris | `apps/web/`，上传/项目/对话/成果 UI；现有 `product-prototype/public/` 迁移 | Felix 提供 API/OpenAPI，Xuefeng 提供 OCR/解析状态，Maxy 确认业务表单枚举与文案 |
| Felix | `apps/api/`、`apps/worker/` 基础设施、`db/migrations/`、`deploy/`，认证/存储/队列/日志与生产接入 | 三人共同评审第一版契约；负责部署和回滚。PR 不需要 Felix review |
| Maxy | `packages/domain/` 的债券业务规则、品种能力、参考库准入与审核数据，历史稿/跨品种更新业务 | Xuefeng 对齐规则包输入输出和参考匹配；Felix 对齐持久化与后台接口 |
| Xuefeng | 解析/OCR/事实抽取、规则适用与匹配算法、无历史稿编制；复用 `python/` 与 worker 的算法模块 | Maxy 审核专业规则与样本；Felix 对齐 worker 协议；Chris 对齐待确认状态 |

共同约定：每项 issue 从 `develop` 建独立分支和工作区，日常 PR 的 base 为 `develop`；`master` 只接收经审核的 `develop` 发布 PR，生产修复从 `master` 分支并回灌 `develop`。具体操作规则见仓库根目录的 `AGENTS.md`。PR 只改自己负责的模块和必要契约。改 `packages/contracts/`、`db/migrations/`、运行状态机或公共规则枚举时，PR 写清迁移影响，并由受影响的负责人 review（不含 Felix；所有 PR 都不需要 Felix review）。迁移文件只追加，不修改已部署版本。以 OpenAPI/schema 样例和固定材料样本联调，避免口头约定字段。规则与模板数据带版本、来源、适用范围和审核状态；任何专业结论由 Maxy 或指定行业审核人确认。

## 6. 开工顺序与首个可集成切片

**第 0 批（并行启动）：** Felix 起 API/数据库/Blob/worker 骨架并提交公共契约；Chris 保留现有 UI 外观，接登录和项目草稿；Xuefeng 固定解析/OCR 的结构化输出与材料样本；Maxy 固定市场/发行方式矩阵、规则包格式和已核实来源。#79 的事件字典与 #16 的模型调用接口须同时定稿。

**首个集成切片：** 真实登录 → 新建项目 → 上传 DOCX/PDF → 保存材料版本 → 提交一个后台 run → 关闭并重开浏览器 → 看到同一状态和成果。先打通这一条链，再让规则/品种和无历史稿分支并行接入。这个切片的模型调用、prompt、attempt、token 和终态进入 #79 日志；其验收先于任何受控用户开放更新。

**PR 交付格式：** 写明关联 issue、改动的契约/迁移、对旧数据的处理、依赖的真实服务、可复现样本及剩余阻碍。前端不能以模拟成功代替服务端确认；模型返回文本不能代替 Word 成果可获取；业务规则不能以未审核资料宣称覆盖。M1 上线门槛仍以 #35 和各子任务的真实验收为准。

## 7. 仍需在真实接入时落定

- 用户名密码注册/登录的发布验证与找回流程；DeepSeek 准确模型 ID、Codex 接口能力和 usage 口径。
- Azure Blob 容器、部署地域、加密密钥、材料与 prompt 保存期限、备份和删除流程。
- 首批授权的募集书来源与行业审核人，以及大公募、PPN/MTN/CP/SCP、DFI 的真实规则版本和样本。

这些是对应 issue 的交付条件。具体值由接入证据填写到配置和运行手册，不能用演示值作为上线配置。

### #8 数据与 API 切片（2026-09-24）

`db/migrations/0001_m1_owner_data.sql` 和 `0002_artifact_download_grants.sql` 建立个人项目、上传会话、材料版本、不可变输入版本、run、事件、outbox、成果元数据及限时下载授权。`apps/api/` 在可信会话 seam 下实现 owner 限定的项目、材料、输入快照、run 查询与成果读取；Blob 存材料字节。`deploy/local/compose.yaml` 用 PostgreSQL 16 与 Azurite 做合成数据集成验证。实际身份由 #7 注入可信 principal 前，公开个人路由拒绝请求；真实 run 执行由 #17 队列和 #79 日志能力接入前返回 `CAPABILITY_NOT_READY`。测试专用 run staging 只保存 `paused` run/事件/outbox，不发起模型调用。尚未连接的识别、预检、对话、项目事件等能力明确返回 501。生产保存期限、物理清理、备份删除重放和供应商处理证据仍待发布决策，详见 `apps/api/README.md`。

### #8 私有存储生命周期跟进（2026-09-24）

追加迁移 `0006_m1_storage_lifecycle.sql` 在 #79 的 `0005` 后登记不可变材料删除墓碑和孤立上传清理状态。材料软删除、墓碑和 `material.deleted` outbox 事件在同一事务内提交；独立单批 CLI 先持久化租约，再校验 Blob hash 并清理，丢失删除响应时可按墓碑安全重放。所有不可变输入修订中的材料引用都会阻止物理清理；run、成果和已绑定观测快照通过输入修订被保守固定。输入修订目前没有引用释放生命周期，因此已有快照引用的材料会无限期保留。过期 `uploading`/`received` 上传以有界批次和 `SKIP LOCKED` 清理，并与 PUT/complete 使用同一上传行锁。

清理 CLI 默认不执行；只有显式开启且提供材料保留天数与孤立上传宽限小时数才可运行，代码不设业务期限。生产政策值、调度、备份周期/隔离、保留和供应商侧删除证明仍待决定。合成 PostgreSQL/Azurite 验证覆盖独立 dump/restore、Blob 拷贝/hash 核对及删除墓碑重放，不代表生产恢复演练。运行步骤见 `apps/api/STORAGE-LIFECYCLE-RUNBOOK.md`。生产执行保持 501；此跟进不构成 #8 完整验收。

### #7 服务端身份与会话切片（2026-09-24）

在 #8 owner API 基线上，`0003_m1_auth_sessions.sql` 保存 +86 规范化号码、挑战 HMAC、协议版本接受记录、注册幂等事件和可撤销会话；对 `0001`/`0002` 仅追加迁移。生产入口使用数据库中的已验证会话解析 `user_id`，不信任浏览器提交的 owner 标识。15 分钟访问令牌与最多 30 天的轮换刷新令牌仅以哈希入库，分别放在 `Secure/HttpOnly/SameSite=Strict` Cookie；另用可读 CSRF Cookie、请求头回传及严格 Origin 校验保护变更请求。登出撤销后，#8 材料/成果读取也不能沿用旧会话。

短信传输是明确的服务端接口；目前仅本地进程内合成测试实现。生产入口没有供应商适配器，发送与验证保持关闭。历史方案要求供应商身份、审核、地域、凭据注入和真实发送/回执证据；合成测试不表示 #7 实际短信验收。原型仅复用交互语义和 5 分钟/60 秒默认值，不沿用 JSON 账号、演示码或模拟积分。具体配置与升级说明见 `apps/api/README.md`。#17/#79/#16 与完整 Word 交付仍是 #6/#8 的独立验收依赖。

### #7 用户名密码决策（2026-09-24）

用户选择 M1 使用用户名密码，短信供应商接入不需要。以上 #7 短信切片仅为历史实现记录；公开 `/api/v1` 契约现使用 `auth/register` 和 `auth/login`。`0008_m1_username_password.sql` 追加唯一小写 ASCII 用户名与 Argon2id 凭据；旧手机账号保留，但没有自动用户名、密码或账号接管入口。旧短信路由从 API 和 OpenAPI 移除。登录使用账号及账号/来源组合的 15 分钟失败窗口（分别 10、5 次）；不按共享 IP 单独封禁。密码找回与账号迁移需 #9 单独设计。正式浏览器、TLS 和部署验收仍未完成。

### #9 账号设置、会话管理与注销切片（2026-09-24）

用户名密码决策后，Issue #9 原文的“换号验证/旧号码找回”按等价安全要求落地：不存在仅凭新凭据接管旧账号的入口。追加迁移 `0009_m1_account_lifecycle.sql` 增加 `closed` 账号状态、会话撤销原因与最近刷新时间、注销记录表，以及已注销 owner 的写入拒绝触发器。`/api/v1/account` 返回用户名、旧手机号掩码、协议版本、改密时间、`self_service_recovery=unavailable` 和配置的支持入口（`BB_SUPPORT_CONTACT`，未配置为 null）。会话列表只含本人有效会话；撤销指定会话或其他全部会话后，其访问/刷新令牌立即失效，外部或未知会话 ID 统一 404。改密必须验证当前密码，并撤销其他会话；会话内密码校验失败返回 403 `PASSWORD_INVALID`（不当成会话过期），与登录共用账号及账号/来源限流。

注销先 `GET /account/closure` 列出未结束 run、项目/材料/成果数量、保留记录与 `local_exports=not_affected`；有未终态 run 时 `POST` 返回 409 `ACCOUNT_CLOSURE_BLOCKED`。确认用户名和密码后，同一事务锁定用户行、软删材料（经 0006 触发器写存储墓碑）与项目、撤销成果交付与下载授权、撤销全部会话、删除密码凭据、标记账号关闭并写注销记录和 `user.closed` outbox。用户名保留不可重新注册；协议接受、注册事件、run 历史、#79 操作/用量日志与 outbox 按依法留存保留。并发写入由触发器等待注销事务提交后拒绝。`balance_status` 固定为 `not_applicable_m1`，M2 钱包/退款须以新增状态和迁移接入，不能直接复用。

仍未关闭：无可靠身份核验渠道，因此不提供自助找回，人工找回流程与核验证据需产品/合规定稿，客服不得绕过；被不可变输入快照引用的材料、成果文件字节与 prompt 快照正文还没有注销后的物理清理生命周期。浏览器设置页已在 `apps/web/` 的 `#/account` 接入，只消费上述公共路由，不新增契约或迁移。运行与验证见 `apps/api/README.md` 和 `apps/web/README.md`。

### #14 OCR 与原页校正切片（2026-09-25）

`python/bondbuddy_ocr` 提供独立 `ocr-request-v1`/`ocr-response-v1`，保留 #13 原生契约。受信 worker 校验 owner、不可变材料和 hash，运行 Tesseract 并将派生页面/结果写私有 Blob；source_preflight 默认三页、最多五页，完整 OCR 必须绑定已有有效 run 和其材料快照，M1 均 platform-paid。原页坐标、识别/方向版本、语言包 hash、表格候选、数值原文及 uncertainty 一并保留。

`0017_m1_ocr_review.sql` 保存追加式快照引用和用户校正；`apps/api/src/ocr.ts` 提供 owner 限定读取、原页及带 expected_revision 的校正，状态 outbox 不含正文。`apps/web/src/ocr-review.ts` 提供原页片段核对；所有 OCR 和用户校正仍不具备 manuscript eligibility，不能用用户说明替代审计事实。上传自动预检调度、#15/#76 适配、复杂跨页表格准确率和派生文件物理清理尚待对应流程。详细契约/运行/验收边界见 `python/OCR-HANDOFF.md`。
