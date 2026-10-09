## 2026-10-08 全站助手增量

以[全站项目助手决定](product-decisions/2026-10-08-global-project-assistant.md)为最新口径。材料页表单保留，新增登录会话级悬浮助手；旧 M4/M5 排期不限制本次已授权范围。

- `POST /m4/topics` 增加 `surface=assistant`；view 保存明确项目、未提交动作、复制进度与确认版本。旧材料话题仍为 `materials`。
- `GET /assistant/projects/:id` 返回当前账号的材料与准确已交付正文版本。
- `GET/POST /assistant/topics/:id/cards` 保存和恢复确认卡；内容来自已锁输入及原报价，模型不能提供金额和资源 ID。卡片本身不执行、不冻结积分。
- 明确确认后仍调用原 runs/review/M4 执行接口；保留幂等键、原账务和私有下载。
- 新全站技能只生成 `assistant_action` 建议；旧 M4 自动采用路径不能处理全站回复。真实用量缺失保留原账务状态。

# M4 API 与材料固定价计费

> 2026-10-07 最新用户决定：材料生成恢复原型表单，增加交易所选择和直接保存的补充要求输入框，去掉本页对话；本次不实现项目问答页面。以 docs/product-decisions/2026-10-07-material-studio-prototype.md 为准。下文冲突的合并工作区/常驻助手条款仅作历史记录；后端能力、权限、计费和固定输入继续保留。

M4 保留 Codex CLI 服务端 worker。`m4_document_v1` 与 `m4_qa_v1` 使用独立不可变输入，不重新解释既有 M1 `generation` 或旧 M3 消息。首发文种为立项报告（`init`）和交易所普通私募募集说明书摘要（`private_summary`）。市场为沪深，单承销商，全文制作和明确底稿全文改稿；局部执行与公开检索属于后续范围。

## 工作区 API

公开类型及请求 schema 唯一来源为 `packages/contracts/src/m4-workspace.ts`。

| 接口 | 行为 |
| --- | --- |
| `GET/POST /api/v1/m4/topics` | 账号话题列表；幂等创建绑定独立 generation 项目的话题，可关联已有项目 |
| `GET /topics/:topic_id/workspace` | 双文种独立草稿、准确采用资料、消息、任务/事件、成果、未发送文本、阅读 tabs、滚动与引用恢复 |
| `PUT /topics/:topic_id/drafts/:document_type` | 乐观版本保存；制作中仍可保存后继草稿，当前 run 输入不变 |
| `POST /topics/:topic_id/materials` | 采用授权的准确材料版本；原件上传复用已有项目上传接口 |
| `PUT /topics/:topic_id/view` | 保存准确阅读/未发送状态，保留旧版引用 |
| `GET/POST /templates` | 本账号私有 Word 模板；明确文种、交易所、券商、准确材料版本和 hash。摘要无需编造券商 |
| `POST /topics/:topic_id/quote` | 返回输入绑定的五分钟报价，按 billing_method 区分固定价与历史按量预留上限 |
| `POST /topics/:topic_id/execute` | 核对输入、报价、授权、同项目互斥和实际余额，原子预留、保存 run 和 outbox |
| `POST /topics/:topic_id/messages` | 基础问答或任务讨论。补齐字段/采纳要求不自动制作。用户明确本业务执行且有当前文书报价时，可解析自然语言主动作再由宿主核对执行 |
| `POST /topics/:topic_id/handoffs/bind` | 用户明确采用准确原消息及来源时，将新建更新／复核目标绑定服务端派生的 canonical scope；不复制文件、不执行、不收费 |
| `GET /artifacts/:artifact_id/versions/:artifact_version/preview` | 准确 artifact 原文预览；没有提取文本时如实提示，保留 Word 下载 |
| `GET /artifacts/:artifact_id/versions/:artifact_version/bytes` | owner 授权、准确版本/hash 核验下载。QA 是文本，不伪装 Word |

表中简写路径均接 `/api/v1/m4`。话题的材料可来自本账号其他项目；每次采用/执行重新验证归属与准确版本。执行 scope 优先从明确原稿/改稿底稿的项目派生，并锁定 canonical 项目。完整更新、复核和材料制作跨话题互斥；QA 可同时运行。运行中改变材料只保存后继输入，不能重绑定当前 run 的 scope。

跨业务入口先显示原需求和准确来源，由用户在新建更新／复核项目明确采用。`handoffs/bind` 请求含 `message_id`、`message_version`、`target_project_id` 和准确 `source_material`；API 从本账号话题的原 user 消息重新校验来源项目、材料 ID／version／hash，并派生 `execution_scope_project_id`，不接受客户端指定 scope。成功响应的 `binding` 固定上述身份及 canonical scope，页面核对响应后才复用现有 owner 文件接口复制原稿及保存目标要求。没有固定来源时只采用意图，并提示用户明确待处理稿，不能声称已经绑定来源。

首次绑定只增加目标 `draft_revision`、写 scope 和同事务 outbox，不修改文件或已有任务，不预留积分；重复同 scope 是只读幂等。已有非 QA 业务任务历史、已采用其他 canonical、或已经被其他项目用作 canonical 的目标不能重绑定。原来源正在制作不阻断采用草稿；新目标执行仍受同 scope 非 QA 互斥，API 返回 `PROJECT_RUN_ACTIVE`，页面提示同一来源已有任务执行中；DB trigger 保留兜底。QA 可以并行。

采用形成的 canonical 关系不能在后续换源时拆散：已被其他业务采用为 canonical 的 M4 话题须另建话题使用新来源。执行前对源项目及 canonical 取锁并重新核对派生 scope，防并发绑定后沿用旧 scope。新增路径使用 `FOR UPDATE NOWAIT`；与已有保存／提交重叠时返回 `INPUT_REVISION_CONFLICT`，提示稍后重新核对并明确操作，避免不同锁顺序死锁。此情形与 `PROJECT_RUN_ACTIVE` 的业务任务互斥提示分别展示；不透传后端原始错误消息。付费更新／复核的旧报价随目标 draft 变化失效；既有任务及旧免费输入快照仍按原输入保留，但执行受当前 canonical mutex 约束，不能称为全量旧输入废弃。

文书成果分别交付正文和编制说明 Word，真实存储 `artifact_id/version/hash` 不变。`revision_number` 是服务端锁定后持久分配的稿次，正文与说明同稿次，下载文件名包含稿次。QA 结果持久为文本证据，留在聊天并可免费重新导出。

助手重复当前已保存字段和要求时不增加草稿版本，既有准确报价仍可用于同次明确执行；真实新要求、字段变化或首次采用待分配要求都会产生新版本，旧报价不能自动启动。日期字段统一使用 `reporting_cutoff`；合法 ISO 日期形式的旧 `reporting_period` 回复归一到该字段，叙述性报告期仍保存在 `reporting_period`。

## M4 账务

2026-10-08 起，四类完整材料按每份 4,500 积分固定价：报价返回 `billing_method=fixed`、`amount_semantics=fixed_price` 和不可变价格版本，用户确认后以 `fixed_credits` 冻结。正文 Word 与编制说明都实际交付后扣款，失败或取消全额释放；材料生成不依赖模型成本配置。迁移 0099 将 M4 固定价结算路由至专用双文件触发器，不影响 M1/M2。详见[产品决定](product-decisions/2026-10-08-m4-fixed-document-price.md)。

按[2026-10-09 用户决定](product-decisions/2026-10-09-fixed-qa-price.md)，新的普通 QA 统一固定 60 积分，以已交付答案成功终态结算，失败／取消全额释放。`publishM4QaPrice` 可信运营函数发布不可变价格版本；运行前报价版本变化需重新确认，运行后保留原锁定价格。追加迁移0101仅扩展固定QA账务守卫，不种生产价格。

已运行的历史按量 QA 与文书保持原计费：真实供应商成本（元）×100×K 得 A，预留 B，成功扣 `min(A,B)`，失败/取消释放。实际钱包、积分批次、预留/分配/结算/释放事件共用。旧未执行文书报价返回 `QUOTE_CHANGED`，必须重新展示固定价后确认。

`publishM4BillingConfig` 是可信运营发布接口，记录 actor、reason、有效时点和不可变配置。配置须包含准确模型 ID、人民币成本率（整数 micro-yuan/百万 tokens）及每类任务估算预算/预留系数。仓库不种生产成本率或预算；未发布返回 `BILLING_NOT_READY`。调用时固定配置，运行中发布新版不替换原快照。网关/CLI 同一调用只采用一份权威 usage；缺失/冲突不当作零成本。已由平台承担的预检/解析不补收。

产品帮助和必要任务澄清、字段补齐、要求整理分别使用免费类别 `m4_Q00` / `m4_task_assistance`，不建用户积分预留。普通 QA 仍按服务端分类报价。明确跨业务请求只提供目标入口；宿主不在当前业务静默执行。

未选择文种时，任务准备要求同样免费并持久等待首次采用。明确请求未开放文种、局部执行或实时公开／法规检索、深度研究时，免费返回能力说明，不按基础 QA 预留。普通概念解释、准确材料解读和确定性计算仍采用原实际 QA 类别。API 的未开放请求判断供 worker 的诚实反馈复用；否定执行和基础概念不冒充已进行检索。

已核验 result 但 usage 待核时，按量任务可展示已生成成果，保持 `settlement_pending` 或可恢复暂停，不成功扣费。待核队列只在实际 usage 齐备后恢复并复用已固定 result，不重复派发供应商调用。固定价文书按真实双文件交付结算，固定价 QA 按答案实际交付结算，未知 usage 原样保留审计。供应商未完成/结果冲突仍走原 reconciliation 门，不能借此放宽。

## 验证边界

`apps/api/src/m4-workspace.pg.test.ts` 使用独立 PostgreSQL 克隆、私有内存 Blob 与真实生成的 synthetic DOCX，验证授权/准确 pin、双文种草稿/阅读恢复、同源项目互斥、免费澄清、未绑定要求一次采纳、明确自然语言执行的宿主核对、钱包预留/封顶/释放、usage 待核恢复、QA 文本交付、正文＋说明双 Word 门和持久稿次。

新增 handoff suite 使用另一独立克隆，验证明确采用的 owner／准确消息和来源、无来源／旧 pin／伪 hash／外账号／已删除来源拒绝、绑定无执行和费用、重复幂等、来源生成期间目标更新／复核互斥、真实更新和复核 API 返回冲突、真实 QA 并行、已有任务／其他 canonical 重绑定拒绝、NOWAIT 冲突恢复及采用后的换源分组保护。

这些是合成工程验证。真实 Codex CLI、授权业务样本 Word/WPS、专业内容和发布验收分别记录，不以本测试冒充完成。
# 2026-10-07 材料知识增量

文种增加 `underwriter`（主承销商核查意见工作稿）、`legal`（法律意见工作稿）；G02/G03 复用既有 K12/K15。新任务必须在 `input.fields.market` 明确选择 sse/szse，服务器按文种与交易所载入 `knowledge/material-drafting/2026-10-07/catalog.json`，把 `knowledge`（版本、来源、完整 MD、哈希、市场及文种）固定到报价及任务 manifest。浏览器不能传入或覆盖知识正文。旧 v1 任务没有 knowledge 时保留原输入；新文种 worker 必须核对知识。运行中新草稿不修改旧任务。

CLI 工作目录新增只读 `knowledge/material-drafting.md`，input.json 指向对应知识，与采用材料、用户要求、Skill 一起进入一次文件编制任务。保持正文和独立编制说明的 Word 交付、准确版本、授权下载与现有费用结算。镜像仅包含目录及编制 MD，不打包全部知识原件。迁移0098只扩展文种约束；不修改任务、不发布新费率。

历史按量文书沿用已锁定成本配置；2026-10-08 固定价决定已覆盖新文书对 G02/G03 预算的依赖。可读官方来源与 IRM 未读取记录见知识 README；未专业核验不冒称当前法规已确认。完整知识决定见 [知识与文种扩展](product-decisions/2026-10-07-material-drafting-knowledge.md)。

## 2026-10-08 一键生成交互

用户点击生成后，浏览器保存草稿并连续调用 `/quote` 与 `/execute`；quote 仅用于服务端定价、余额校验与准确输入绑定，不呈现报价或二次确认。报价返回后如草稿或文种已改变，本次不提交，保留修改并提示重新生成。余额不足提示充值且不自动重试；回执丢失保留原 `execution_request_id`，重试不再报价或创建另一任务。

固定 4,500 积分仍在双 Word 成功交付后由服务端结算，失败/取消释放。前端任务状态变化触发真实余额刷新，常驻主数字显示可用＋预留，成功后才减少；没有客户端扣账、协议或数据库变更。
