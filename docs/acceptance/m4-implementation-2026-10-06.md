# M4 本地实施与分层验收记录

状态：用户已确认 M4／M5 分期并要求执行 M4。本记录区分工程实现、合成集成、真实供应商、专业及发布证据；不是 M4 已上线报告。

## 代码与范围

- 实施分支：`codex/m4-core-20261006`，独立 worktree `m4-core-20261006`。
- 本地代码提交：`c85b724`（contracts／API／迁移／计费及 canonical 互斥）、`d3278ff`（Codex CLI worker／技能／财务工具）、`c51821d`（合并工作区／成果 tabs／交互）。验收与分期规格另行提交；均未推送。
- 本地基线：`origin/develop` `3725dd53b1504d7fd8e45b37c3b55252490d3b89`。GitHub 当前身份读取 `ITSophiaXu/BondBuddy` 返回 404，联网 fetch 未成功，不能称已同步最新远端。
- 交互基线：已确认 schema 6 `bondbuddy-artifact-workspace.html`，SHA-256 `AA15F4E7C517F893019E60CF546F6163A63620FC47287BB037172ED653D7A94A`。沿用 BondBuddy 导航和左右工作区，没有整体 redesign。
- 首发：沪深交易所普通私募、单承销商的立项报告和募集说明书摘要；基础问答、授权材料解读、确定性财务计算和两期比较；单文书正文与独立编制说明 DOCX、准确底稿全文续改。
- 扩展文种、市场、多承销商、多文书组合、局部执行、实时公开／法规检索、深度研究、高级 QA artifact、跨业务自动执行留在 M5。未开放请求免费说明并保留意图，不生成替代任务。

## 已实施切片

| Issue | 工程实现 | 关键证据及最终统一验收待办 |
|---|---|---|
| M4-01 | 合并“材料生成与问答”，兼容旧 `#qa`；按两种文书展开专属输入、独立草稿；QA 直接在助手 | 前端单元、Edge 合成浏览器测试及三场景同尺寸原型对照已留证；真实 API 逐屏验收待办 |
| M4-02 | 私有模板上传及准确版本采用，交易所／券商匹配提示，hash 去重、来源与授权复验 | API／worker 隔离及不可变 pin 测试；授权真实券商模板专业审核待办 |
| M4-03 | 受信立项技能，准确来源／模板／要求，真实 DOCX 与独立说明路径 | 实际 Python DOCX 合成集成通过；真实供应商文书 smoke 本轮超时，专业／Word-WPS 验收待办 |
| M4-07 | 普通私募摘要技能，匹配沪深来源与模板；正文／说明分别交付 | 合成 pipeline 真 Word、预览、hash 下载通过；真实供应商文书 smoke 本轮超时，专业／Word-WPS 验收待办 |
| M4-08 | 基础 QA 文本交付／免费再次导出，准确引用；六类比率及两期比较由宿主 Decimal 重算 | Python 与 worker 负例通过；真实 CLI 资产负债率 60% 成功；更多授权业务样本待办 |
| M4-09 | 免费任务澄清／要求回填；新输入只保存，当前有效报价下明确同业务执行一次启动；共用真实钱包按量预留／封顶／释放 | PG 真实账务与语义执行集成通过；正式人民币成本率／预算发布及真实支付费用核对待办 |
| M4-10 | Agent 常驻、讨论按钮不发送；正在制作及真实安全事件；完整消息、草稿、阅读与引用恢复 | 浏览器恢复、长会话、键盘／窄屏合成测试；真实 API 登录走查及线上验证待办 |
| M4-11 | 原件只读，文件模式 Codex CLI；准确方法／技能／工具 pin；全文新稿、持久稿次、旧稿保留；已完成调用与文件复用 | PG/Azurite checkpoint crash／unknown usage 恢复通过；真实文书及生产沙箱独立复验待办 |
| M4-12 | 本记录及验收矩阵，保留工程与专业／发布分层 | 本 issue 保持待验，不能以工程通过代替上线验收 |

新增迁移 `0091`～`0096`，既有迁移不改：M4 工作区／计费／scope、未绑定要求、QA 文本交付证据、结算变量修复、稿次及消息／模板身份不可变。公共 DTO 在 `packages/contracts`；旧 M1／M3 路由、任务交付政策和历史账务继续保留。

工作区左侧组织材料、目标、范围和要求并阅读 artifact 本体 tabs；右侧澄清、执行及讨论。无左侧 QA 表单、补充意见 textarea、助手收起／全屏。资料库与本次采用清单分开；当前输入快照与后继草稿分开；正文、说明、来源及旧版本准确固定。执行过程不捏造百分比／工具事件，旧版阅读不抢切。跨业务需显式进入目标工作区核对来源和需求后采用，不自动执行。

## 工程验证

下列资料、模型输出和测试账号均为 synthetic。PG 测试使用独立数据库克隆，不使用 M3 业务库；浏览器测试使用 owner-aware HTTP fixtures，不能当作真实供应商或真实 API 登录验收。

| 验证 | 命令／环境 | 已取得结果 |
|---|---|---|
| 全仓构建 | `npm run build`，Windows／Node v24.14.0 | 跨业务 handoff 及安全错误码收尾后最终复验：API／worker／web 等七个 workspace 全部通过。Node 22 生产基线仍需实际环境验证 |
| 公共契约 | `npm run check:contracts` | 最终复验通过：167 synthetic＋12 internal examples；4 lifecycle、29 OCR、11 binding |
| 前端状态 | `npm run test:unit -w @bondbuddy/web` | 最终 83 通过／0 失败，含任务互斥与版本冲突的独立安全提示 |
| 材料与问答／复核交互 | Edge Playwright `m4-workspace.spec.ts`＋`review-workspace.spec.ts` | 63 个执行用例均已验证通过，另 2 个旧截图任务按环境开关有意跳过。全量首次 1 个 checkbox 高度断言失败；修复继承的 min-height 后，该项与最新截图定向复验 2/2 通过。新增同源执行拒绝负例 1/1：草稿和未发送文字保留、结束后不自动启动。跨业务 binding 拒绝时不复制／采用／执行，复核更新计划持久恢复均已测 |
| M4 API／PG | `node --test apps/api/dist/m4-workspace.pg.test.js`，`BB_TEST_DATABASE_URL` 指向独立 PG | 最终 3 通过／0 失败／0 跳过（分类、扩展 PG、独立 handoff／lineage） |
| M4 及旧账务／复核／编制回归 | `node --test --test-concurrency=1`，下列八个测试文件 | 最终 18 通过／0 失败／0 跳过，47.8 秒 |
| 旧编制入口任务身份 | `node --test apps/api/dist/authoring-task-kind.pg.test.js`，独立 PG | 1 通过／0 失败／0 跳过；无论付费开关，update／generation 不可声明 QA 绕过互斥，拒绝后无 run，正常免费编制仍可提交 |
| Worker 方法／阶段 | `node --test` 定向 `m4-runtime-skills`、`m4-stages`、`model-generation-router`、`review-action-progress` | Windows 26 通过／0 失败／1 Linux symlink 跳过；最终 Linux 27 通过／0 失败／0 跳过，含 input gate 修复 |
| Worker pipeline／PG／Blob | `node --test apps/worker/dist/m4-pipeline.pg.test.js`，独立 PG、Azurite 3.35、业务 Python | 最终 1 通过／0 失败／0 跳过；真实 API、lease、durable journal、私有 Blob、真实生成 DOCX，模型为合成 seam；含空券商摘要模板、待核账务 Word／文本的准确读取正负例 |
| 确定性财务／有效稿／wrapper | 业务 venv `/opt/venv/bin/python -B -m unittest discover -s python/tests -p 'test_m4_*.py' -v`，设置 `PYTHONPATH=python` | 最终 Linux 22 通过／0 失败（17＋2＋3）。初次系统 Python 缺 lxml，改用既有业务 venv 后全部通过 |

PG/Azurite 集成已覆盖：双 Word 门、两稿准确底稿及稿次、授权 preview／下载 hash、跨 owner 404、准确来源 scope 互斥、QA 并行、真实钱包封顶／释放、重复执行幂等、word promotion 中断恢复只调用一次、unknown usage 的已生成文件／QA 文本持久恢复及仅一次结算、自然执行 proposal 由宿主核对后只建一个文书 run。

最终 API 回归文件：`m4-workspace.pg.test.js`、`authoring-task-kind.pg.test.js`、`billing.pg.test.js`、`review-billing.pg.test.js`、`provider-result-validation.test.js`、`review-workspace.test.js`、`review-linked-workspace.test.js`、`project-kind-conversion.pg.test.js`，均位于 `apps/api/dist/`。跨业务采用从持久原 user 消息重新核对准确来源，服务端派生 canonical，绑定／outbox 原子且重复不执行。源 generation 实际进入 running 后，目标旧更新／复核 API 返回 `PROJECT_RUN_ACTIVE` 且无并行业务 run；DB trigger 仍兜底。已采用 canonical 不可换源拆组，执行锁后重读来源防并发漂移；伪装 QA 的文书执行拒绝。旧付费报价失效，旧免费输入快照保留但受当前 canonical 互斥，不冒称所有旧输入废弃。

近期修复：重复既有字段／要求不增草稿版本；新要求或新消耗 pending 要求使旧报价失效但只保存。合法 `reporting_period` ISO 日期兼容到 `reporting_cutoff`，叙述性报告期保留。未开放能力和无文种任务准备免费，基础概念／材料解读／计算仍按实际 Q 类别。明确两期比较优先于计算／指标关键字，Q04/K=4；单期计算 Q03/K=3。Q04 财务比较缺宿主收据时不得接受模型伪造数字或“显著改善”，两期 50%→60% 由固定工具返回 +10 个百分点；仅方法或文书措辞比较仍可回答。详细 API 审计见[边界记录](m4-api-boundary-audit-20261006.md)。

Worker 已与 API 对齐：准确 `passed/available` 成果可在账务待核时阅读／引用，owner、project、version、hash 和交付证据门保留；仅立项模板要求非空券商，摘要券商选填。权限、伪 hash、撤回 Word 和文本证据篡改负例均拒绝；读取不新增费用。

截图及基线对照保存于[交互证据](m4-workspace-20261006/README.md)，共 12 张准备／制作／成果的原型及实现截图。截图为 synthetic HTTP fixtures，viewport 1360×900／390×844；原型为 exact SHA schema 6。勾选布局、重复来源、终态文案及稿次显示问题已修复；Root 目视复验桌面准备与窄屏成果，不替代真实 API 登录走查。

任务规划离线校验 `node product-prototype/product-specs/delivery-plan/publish-issues.mjs --check` 通过，73 个任务、pending 空；未运行 `--apply` 或写远端。

## 真实 CLI 证据与限制

环境：WSL `BondBuddyM3`、非 root `bbm3`、Codex CLI `0.154.0`、真实模型 `gpt-6-sol`、provider 配置 `copilot_enterprise`。使用已配置服务凭据，不回显凭据，不改变 M3 服务。以下是合成材料上的真实供应商 smoke；operator memory journal，`durable_journal=false`，不冒称完整持久业务链路的真实供应商验收。

| Probe | 实际结果 | 安全证据 |
|---|---|---|
| 财务 QA | 成功；总资产 5,000 万、负债 3,000 万，宿主重算结果 60%；1 次真实调用、11 个工具 attempt、usage measured | 输入 167,323、cached 148,240、输出 4,108、total 171,431；provider request ID 与 pricing unknown，如实保留。私有目录 `…/probes/m4-live/muwsy26p-qa` |
| 普通私募摘要 | 300,037ms 超时；1 次调用、9 个工具 attempt；`needs_reconcile` / `MODEL_TIMEOUT`，usage unknown；没有冒称交付 | call `call-c0b87b8d-ab83-45ef-bd1d-a367bd3840ef`，thread `01a111ba-9dc9-7e63-996d-4a0ba6fe3968`；私有目录 `…/muwt233p-document` |
| 立项报告 | 300,059ms 超时；1 次调用、7 个工具 attempt；`needs_reconcile` / `MODEL_TIMEOUT`，usage unknown；没有冒称交付 | call `call-6382761e-3078-4c51-b2cf-31f84ee511fa`，thread `01a111bb-153f-7120-aa0a-ff9faacd2f22`；私有目录 `…/muwt2ql7-init` |

文书 300s 是本次 probe override。生产 fileWorkspace 沿用 `BB_CODEX_AUTHORING_TIMEOUT_MS`，默认 2,700,000ms（45 分钟），不是本次 5 分钟。不能据此把两个失败 smoke 判为成功；保留失败证据，不盲目重发未知调用。正式超时预算、吞吐、完整真实文书与用量仍需验证。

实际生产 source verifier 的 Linux CLI 权限探针通过。CLI 官方 bwrap 会覆盖 `/proc` deny mount；本地使用已有受信 `/opt/bondbuddy-sandbox/bin/bwrap` 加固及其 HARDENING 文档后通过，未改 verifier 或放宽权限。该加固仅是本地证据，目标生产环境必须独立复验。

额外旧 `codex-file-authoring.test.js` 三项在原始 WSL 默认配置下均未通过 `AUTHORING_FILE_SANDBOX_UNAVAILABLE`，失败发生在供应商 intent 之前。该 fixture 用默认 PATH，未带已有 bwrap 加固，且此 WSL 不提供 CI 的 AppArmor 环境。上述 27 项 M4 Linux 测试与真实加固权限探针分别留证；不隐藏这三个环境失败，不以放宽边界来修复。原生 worker 镜像／生产权限门仍待独立验收。

## 最终统一验收待办与发布条件

- 两种文书的真实 CLI 完整交付、正式预算下性能、准确来源／模板／要求／方法 pin、可编辑 Word／WPS 逐份核验及对应专业审核；授权真实样本不等于已签认。
- 模型人民币成本率、预算和运营价格配置正式发布；仓库没有假生产价格。G01 K=8／G05 K=6 是系数，实际成本×100×K，预留上限 B、成功扣 min(A,B)，unknown 保持待核，最终失败／有效取消释放；旧任务不追补。
- 目标生产 CLI、文件沙箱及凭据隔离复验，部署版本／迁移／健康检查／回滚计划，最终发布许可。
- 恢复仓库访问后 fetch/rebase 最新 develop、必要回归、创建并关联 PR、同步 issue 状态。当前没有远端 PR、合并或部署。
- 本地真实 API 浏览器走查和同尺寸原型对照：自动审批拒绝使用本轮新建合成账号登录 `http://localhost:5178`，理由是通用 M4 测试指令不构成新账号／该站点登录的明确授权。已请求用户授权，未答前不尝试登录或绕过；工程自动化继续，不能替代此项。

本轮不关闭 M4-12。M4-01／02／03／07／08／09／10／11 的工程证据按上述 issue 关闭口径汇总；远端实际状态尚未修改。
