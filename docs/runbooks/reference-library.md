# 后台募集书参考库运营手册（#78 / M1-33）

适用范围：`db/migrations/0023_m1_reference_library.sql`、`apps/api/src/library.ts`、`apps/api/src/library-admin-routes.ts`、`apps/worker/src/library-pipeline.ts`、`apps/worker/src/library-sources.ts`、`apps/worker/src/library-sync-cli.ts`。参考库是平台数据，只供受信任务服务和获授权运营使用；普通用户接口不提供库清单、候选或匹配分数。

## 1. 组成与数据流

```
来源适配器 discover → fetch（按条重试）→ 按 SHA-256 去重 → 私有 Blob library/… → pending_parse
  → 现有 Python 解析桥（document-parse-request-v1）→ pending_classify
  → 分类/画像（市场、方式、品种、文书阶段、最近完整年度前三大业务）→ pending_review + 审核队列
  → 运营 approve：同一事务写正文状态、画像状态和新的索引发布（index release）→ published
```

- 同步任务运行在 `bb_jobs`（`job_type='library'`，系统属主 `system-reference-library`）租约模型上；每条完成后写检查点，崩溃后从下一条继续。#79 的 `bb_observability_events` / `bb_observability_errors` 与 outbox 记录每次状态变化。
- 状态机（每次变化都由触发器写 `bb_library_audit`，含原因与操作者，并写 outbox）：
  `pending_parse / pending_classify / pending_review / published / superseded / withdrawn / license_revoked / rolled_back`，另有 `rejected`（审核拒绝）与 `failed`（解析/分类失败，可按记录重跑）。
- 一致性：延迟约束触发器在提交时检查“活动索引发布 = 全部 published 正文 + 其 published 画像”。绕过发布流程直接改状态的事务会在 COMMIT 失败，因此正文与索引不会一新一旧。
- 迟到旧任务：版本按来源修订序（SSE 为 `FILE_TIME × 100 + FILE_VERSION`）排序。更低修订的字节流入库后立即 `superseded(stale_late_revision)`；旧版本审批时若已有更新修订，同样被标为 superseded，不会覆盖新版本。
- 个人上传隔离：库表不引用 `bb_material_versions` / `bb_uploads`；`blob_key` 只能以 `library/` 开头；入库函数没有“用户材料”参数。运营批量补录只读取 `library/import-staging/<sha256>`。

## 2. 来源登记与使用权

| source_id | 类型 | 使用权 | 依据 |
|---|---|---|---|
| `sse_bond_project_platform` | public_disclosure | `evaluation_only` | 上交所网站法律声明（2026-09-25 核对 https://www.sse.com.cn/home/legal/）：允许非商业目的浏览、下载；以营利为目的使用须取得上证所信息网络有限公司书面许可。 |
| `operator_import` | operator_import | `evaluation_only` | 运营按批次声明授权依据；记录许可后再改权属。 |

**只有 `commercial_licensed` 来源的 published 版本能被任务选用。** SSE 来源在取得书面许可前只能同步、解析和审核，不能进入新任务的候选。变更权属：

```
POST /api/v1/admin/library/sources/sse_bond_project_platform/rights
{"usage_rights":"commercial_licensed","reason":"sse_infonet_licence_recorded"}
```

`revoked` 是终态：该来源所有正文立即变为 `license_revoked`，从新的索引发布中移除，已锁定任务再读取正文时被拒绝（锁记录仍可追溯）。恢复需重新登记来源。

## 3. 定时同步

- 入口：`node apps/worker/dist/library-sync-cli.js [source_id]`（需要 `DATABASE_URL`、`AZURE_STORAGE_CONNECTION_STRING`，可选 `BB_LIBRARY_CONTAINER`、`BB_LIBRARY_MAX_PROJECTS`、`BB_PYTHON`、`BB_REPO_ROOT`）。每次调用：登记来源 → 若无进行中的同步则入队 → 执行至空闲 → 在 stdout 打印脱敏 JSON 摘要（只有计数和代码）。
- 手动入口仍可用于演练和一次性补跑；常规运行改用下面的 ops 调度任务。

### 3.1 ops 调度任务 `library_sync`（迁移 0032）

- 在 ops 调度器（`apps/worker/dist/ops-scheduler.js`，Compose 服务 `ops`）设置 `BB_OPS_LIBRARY_SYNC=on` 开启，默认关闭。需要 `AZURE_STORAGE_CONNECTION_STRING`；可选 `BB_LIBRARY_CONTAINER`、`BB_LIBRARY_MAX_PROJECTS`（默认 3）、`BB_LIBRARY_MAX_JOBS_PER_PASS`（默认 5）、`BB_LIBRARY_STALE_FACTOR`（默认 2）、`BB_OPS_LIBRARY_SYNC_SECONDS`（检查周期，默认 60 s）、`BB_OPS_LIBRARY_SYNC_LEASE_SECONDS`（默认 1800 s）。
- 每次运行：①领取到期来源：`enabled`、`kind='public_disclosure'`、未撤回、`next_sync_due_at<=now()`，对 `sync_lease_owner/sync_lease_until` 做条件 UPDATE，多个调度实例不会重复领取同一来源；②每个来源入队一个 `library_sync` job（有进行中的 job 时复用它）；③调用共用流水线清空 library job（发现 → 下载 → 按 hash 去重 → 解析/分类 → 待审队列，增量游标和按条重试沿用第 3 节）；④释放租约，并设 `next_sync_due_at = now() + sync_interval_seconds × (1 ± 10% 抖动)`；⑤检查来源是否陈旧。
- 周期按来源配置：`bb_library_sources.sync_interval_seconds`，默认 86400（每天），取值范围 300 s 至 1 年。SSE 登记为每天一次。修改方法（运营 SQL，写审计时带原因）：`UPDATE bb_library_sources SET sync_interval_seconds=21600 WHERE id='sse_bond_project_platform';`。
- 单次执行与恢复：job 通过 `bb_jobs` 租约领取（`SKIP LOCKED`）。实例崩溃后，job 保持 `running`，租约到期后由任一实例接管（`lease_recovered`），从检查点 `next_index` 继续执行，已完成的条目和发现结果不会重做。
- 告警（写入 #79 `bb_ops_alerts`，在 `/api/v1/admin/alerts` 可见）：
  - `library_sync_failed`（critical，scope=来源 id，按小时去重）：同步最终失败，或部分条目失败（`partial`）时触发。`consecutive_failures` 加 1；只有全部条目成功才清零。
  - `library_source_stale`（warning，scope=来源 id，每个 `sync_interval_seconds` 周期最多一条）：距上次成功（从未成功则从登记时间算起）超过 `BB_LIBRARY_STALE_FACTOR × sync_interval_seconds`。
- `evaluation_only` 来源照常同步和审核，用于评估，但查询时按使用权过滤，任何版本都不会成为任务候选；有测试覆盖。
- 资源：解析在 ops 容器内运行 Python 子进程。现行 `deploy/m1/compose.yaml` 给 `ops` 384M 内存、`NODE_OPTIONS=--max-old-space-size=256`；`worker` 内存上限为 768M，未设置 `NODE_OPTIONS`。开启同步前按实际 PDF 峰值评估并调高 ops 限额，确认出口代理允许 `query.sse.com.cn`、`static.sse.com.cn`。
- 增量游标：`{"publish_date": "<最高已见 PUBLISH_DATE>"}`，下一次从同一日期起重扫（重叠一天），重复条目记为 `unchanged`。失败条目以 `retry_items` 写入游标，直到成功为止，不会因游标前进而丢失。
- 只有全部条目成功时才更新 `last_success_at`；部分失败记 `partial` 并设置 `last_error_code`。
- 限速：请求间隔 ≥700 ms，单文件下载超时 180 s，单文件上限 150 MiB，按条最多 3 次尝试（退避 5 s × 次数）。

## 4. 运营接口（`/api/v1/admin/library/*`）

默认拒绝：没有 `bb_library_operator_grants` 有效授权的账号，访问任何管理路径都得到与未知路径相同的 404。`library_reader` 只读；`library_operator` 可执行操作。每次访问写 `bb_log_access_audit`（purpose=`library_read`/`library_operate`）。#79 的 `bb_operator_grants` 已存在，但参考库路由仍查询独立授权表；不能只配置统一授权表就认为已开通参考库权限。合并角色需要单独设计、迁移与验证。

| 方法 | 路径 | 角色 | 说明 |
|---|---|---|---|
| GET | `/overview` | reader | 新增(24h)/待处理/失败/陈旧来源/已发布/待审数量；每个来源的最近成功、最近尝试、下次到期（`next_sync_due_at`）、周期（`sync_interval_seconds`）和连续失败次数（`consecutive_failures`）；按市场×方式的覆盖与三业务代码数；活动索引发布 |
| GET | `/alerts` | reader | 告警列表（见第 5 节） |
| GET | `/misses` | reader | 未命中汇总（仅查询形状和集合键哈希，无用户数据） |
| GET | `/reviews` | reader | 待审队列 |
| GET | `/versions/:id` | reader | 版本、画像版本及完整审计 |
| POST | `/versions/:id/review` | operator | `approve` / `reject` / `correct` / `withdraw`，`reason` 为机器码 |
| POST | `/versions/:id/rerun` | operator | 按记录重跑解析与分类 |
| POST | `/releases/:id/rollback` | operator | 以新发布恢复旧索引；撤回或授权失效的条目不会恢复 |
| POST | `/sources/:id/sync` | operator | 立即入队一次同步（有进行中的同步则返回它） |
| POST | `/sources/:id/rights` | operator | 更改使用权 |
| POST | `/imports` | operator | 运营批量补录（1–50 条，PDF/DOCX，base64），与公开来源共用流水线 |

审核规则：`approve` 要求版本和最新画像都处于待审、画像为合并口径且三项业务各有证据、市场/方式/品种/阶段均已分类。默认分类器**不会猜测**前三大业务：它只从标题推出市场、方式、品种和阶段，画像保持 `incomplete`。运营须用 `correct` 提交最近完整年度、词典版本及逐项证据（页码/记录 ID），生成新的画像版本后再批准。第三业务排名变化或任何画像内容变化都会追加新画像版本，旧的待审画像变为 superseded。

## 5. 告警样例

```json
[
  {"kind":"source_sync_failed","severity":"critical","subject":"sse_bond_project_platform","detail":"LIBRARY_FETCH_FAILED","since":"2026-09-25T08:11:08.520Z"},
  {"kind":"source_stale","severity":"warning","subject":"sse_bond_project_platform","detail":"never synced successfully","since":null},
  {"kind":"items_failed","severity":"warning","subject":"document_versions","detail":"1 version(s) failed parse/classify; re-run per record","since":"2026-09-25T08:17:40.000Z"},
  {"kind":"review_backlog","severity":"warning","subject":"review_queue","detail":"57 open review item(s)","since":"2026-09-20T02:00:00.000Z"}
]
```

#79 告警表中的调度告警（`GET /api/v1/admin/alerts`，合成样例）：

```json
[
  {"kind":"library_sync_failed","severity":"critical","detail":{"source_id":"sse_bond_project_platform","error_code":"library_source_unreachable","consecutive_failures":2}},
  {"kind":"library_source_stale","severity":"warning","detail":{"source_id":"sse_bond_project_platform","age_seconds":190000,"threshold_seconds":172800,"never_succeeded":0}}
]
```

处理：`source_sync_failed` → 查看最近一次 `bb_library_sync_runs` / `bb_library_sync_items`（按 `error_code`），确认来源是否可达，再次触发同步；`source_stale` → 检查定时器是否在运行、来源是否被禁用；`items_failed` → `GET /versions/:id` 查看原因后 `rerun`；`review_backlog` → 安排审核人。告警目前通过 `/alerts` 拉取；推送到告警通道依赖 #79 的告警汇（PR #152）。

## 6. 失败恢复演练

以下每一步都有对应自动化测试（`apps/worker/src/library.test.ts`、`library-scheduler.test.ts`，合成数据），可在预发环境按同样步骤手动演练：

1. **来源不可达**：让适配器返回错误（或断网）→ 任务 `retry_scheduled` 后达到上限 `failed`，`error_code=LIBRARY_SOURCE_UNREACHABLE`，#79 错误记录依次为 `retry_scheduled`、`terminal`，`/alerts` 出现 `source_sync_failed`。恢复连通后 `POST /sources/:id/sync`。
2. **同步中途崩溃**：在第 1 条完成后杀掉 worker（测试中使租约过期）→ 下一次运行接管同一 job，从第 2 条继续，第 1 条不重新下载，版本不重复。
3. **单条下载失败**：瞬时失败在同一条内重试（sync item `attempts` 记录次数）；持续失败记 `failed`，该条写入游标 `retry_items`，下次同步自动重试。
4. **解析失败**：版本 `failed`，`/alerts` 出现 `items_failed`；修复原因后 `POST /versions/:id/rerun`，版本回到 `pending_review`。同一文档的新修订会自动退役失败的旧修订。
5. **错误发布回滚**：`POST /releases/<上一个发布>/rollback` → 生成新发布；被回滚的版本为 `rolled_back`，恢复的版本为 `published`，查询结果随之变化；已锁定任务保持原锁定版本。
6. **授权撤回**：`POST /sources/:id/rights {"usage_rights":"revoked"}` → 新任务立即无候选；已锁定任务读取正文返回 `denied/source_rights_not_current`。

## 7. 任务侧契约（内部 v1）

`packages/contracts/src/reference-library.ts` 定义 `reference-library-query-v1`（采用 @loooo139 在 #77 提出的最小内部查询契约），仅供受信任务服务使用，不进入公开 OpenAPI（`check:contracts` 会校验）。

- 输入：任务服务身份、owner/project/run 审计上下文、目标三业务标准代码无序集合、词典版本、年度、证据引用、目标市场/方式/品种/阶段/规则版本、可选 `index_release`。
- 输出：`candidates` / `no_match` / `unavailable` / `index_version_mismatch`；候选只含不可变 document/profile/taxonomy/index 版本、市场/方式/品种/阶段、状态（恒为 published/可读/有使用权/来源有效）、适用规则范围、章节映射版本、审核质量、披露日和集合键。不含正文、发行人名称或收入金额。
- 过滤：活动发布 + 正文 published + 画像 published 且完整 + 来源 `commercial_licensed` + 集合键、词典、品种、阶段一致。市场/方式不强制相同，由 #33 的领域规则按跨市场章节映射决定。
- 选中后调用 `lockReferenceSelection` 锁定版本；读取正文用 `readLockedReference`，每次读取重新检查撤回与授权。
- 缓存：按“活动发布 ID + 来源权属时间戳 + 章节映射时间戳”作键，每次查询都从 PostgreSQL 读取；任何发布/撤回/回滚/权属/映射变化都会使其失效。

### 7.1 v1.1 增量字段（`reference-library-query-v1.1`，迁移 0030）

请求 `schema_version` 传 `reference-library-query-v1.1` 时，响应同名版本，每个候选在 v1 字段外追加；传 v1 仍返回原样 v1 形状。

- `comparability`：已审核画像版本的可比性事实 `accounting_scope`（consolidated/parent/mixed/unknown，已发布画像恒为 consolidated）、`revenue_basis`（`operating_revenue` / `main_business_revenue`）、`currency`（ISO 4217，如 `CNY`）、`unit`（`yuan` / `thousand_yuan` / `ten_thousand_yuan` / `million_yuan` / `hundred_million_yuan`）、`fiscal_year`，以及 `attestation { review_id, reviewed_by, reviewed_at, profile_id, profile_version }`。这些字段写在 `bb_library_profiles` 上，按画像版本不可变；首次发布（pending_review → published）必须齐全，并在同一 UPDATE 里写入批准审核项的 id、审核人和时间，数据库触发器强制执行。0030 之前发布的画像没有这些事实时返回 `null`，调用方必须视为不可比（不得标 exact）。
- 缺少事实的画像需由运营通过 `correct` 提交 `revenue_basis`、`currency`、`unit` 后再批准；未审核数据仍不可发布。
- `chapter_mappings`：已接受的章节映射版本 `{ mapping_version_id, mapping_key, version, status, source{market,offering,instrument}, target{market,offering,instrument}, document_stage, rule_version }`。只返回 source 等于候选市场/方式/品种、target 等于请求市场/方式/品种且阶段和规则版本一致的版本；`chapter_mapping_versions` 同步为这些 id。映射版本存 `bb_library_chapter_mapping_versions`，只能跨市场或方式，除一次撤回外不可变；运营接口 `POST /api/v1/admin/library/chapter-mappings` 与 `.../chapter-mappings/:id/withdraw`。

## 8. 已知缺口

- 默认分类器不自动抽取前三大业务；自动抽取属于 Xuefeng 的抽取工作，业务词典与品种取值（`corporate_bond`、`renewable_corporate_bond` 等）尚待 Maxy 确认后进入公共枚举。
- Python 解析桥已允许子进程在 stderr 输出警告时返回有效解析结果（#169）；stderr 只生成有界、脱敏诊断，不再单凭 pypdf 的 “Ignoring wrong pointing object” 警告判失败。非零退出、超时、无效响应等仍按对应错误处理；排查时查看诊断代码，不记录原始 stderr 或本地文件路径。
- SSE 来源在书面许可前为 `evaluation_only`，真实文件不会进入任务候选；首批“真实已审核参考稿”仍依赖 #77 的授权与业务审核。
- 定时同步已接入 ops 调度器，但默认关闭；开启前需按解析峰值复核 ops 内存、配置出口允许列表，并完成真实 SSE 首次和增量同步证据。#79 告警表已接入，外部告警推送须单独验证；参考库授权仍使用独立授权表。
- 周期目前只能通过 SQL 修改，还没有管理接口。
