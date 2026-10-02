# M3 实现与集成验收记录

关联 #47、#48、#49、#55、#145、#56；需求 PR #519 已合并，集成基线 develop `c2c3448`（包含 #520 直接编制材料工具、#524 长编制超时、#522 固定审计勾稽方法）。本记录随实现提交，描述实际证据，未代替 GitHub 专业及上线验收。M3 不包含收费、参考库或商业数据接口前置。

## 已实现范围

| Issue | 本次交付 | 尚不具备的验收证据 |
| --- | --- | --- |
| #47 | 两标签工作区；直接解释/补证/计划/执行；默认收起助手；五类实际 Copilot 回复；可调整提议后采纳并追溯原提议；工作台版本、草稿及缺项恢复 | 授权真实材料与部署后的 API/队列/供应商联合验收 |
| #48 | 有归属及完整版本/hash的审计证据映射；精确算术；同表跨批上下文和原文显式求和生产路径；不确定/OCR/冲突保留；差异范围与沿用 | 全品种授权金标准集的误报/漏报与专业质量报告；复杂表头/口径语义、比率/增长及复杂公式图仍受限 |
| #49 | 精确市场/品种规则消费者、作用范围、效力来源；真实字体/字号、指定标题层级及受限页眉/TOC原生属性检查；缺知识与适用性保守处理 | 生产适用性白名单仍为空；复杂分节页眉/页脚、目录完整性/页码刷新、视觉排版和全部品种/DFI专业验收未完成 |
| #55 | 财务/合规/公开维度合并；实际搜索事件审计；DOCX报告/原生批注；差异与恢复 | 本机 Copilot 两次实际探测均无搜索工具事件；WPS 和跨客户端往返未验证 |
| #145 | 明确采纳和执行；固定原报告/源稿/范围；修订/清洁Word与处理清单 | 授权真实文档的专业修订质量与全部复杂布局验证 |
| #56 | PostgreSQL/Azurite真实链路、合成模型子进程、五类实际供应商提示场景、浏览器、权限/恢复/零计费回归 | 真实材料与供应商联合链路、全品种/DFI专业金标准、WPS、生产部署版本/回滚实测 |

“技术交付成功”和“专业复核通过”独立。未执行的关键维度、未验证语义、沿用项以及已修改项不会变成通过；专业与部署缺口尚在，不能声称六项全部完成。

## 工程证据

环境为 Windows、Node 24.14.0/npm 11.9.0、Python 3.11+、PostgreSQL 16（独立合成测试模板）、Azurite、Microsoft Edge。API/浏览器及主链路中的实体、财务数值和模型子进程响应明确为 **synthetic**；实际数据库、文件上传/解析、Blob 字节、Word生成器、下载及恢复均执行真实代码。另行列明的 Copilot 五场景采用合成业务上下文和真实供应商回复；解析器兼容性检查还使用仓库已授权样本，二者不混同为真实业务联合验收。

- 根 `npm run build`：全部工作区构建通过。
- `npm run check:contracts`：156个公共示例、12个内部library示例、4个lifecycle示例；OCR 29/29、主体绑定11/11通过。
- 财务/合规/模型/新旧稿定位与真实格式相关 domain+worker：79/79通过，包含原文与模型主体、期间、单位、口径不匹配，以及模型无法自报信任的回归。格式标准来自锁定输入中的明确用户要求，保留原文/hash并标为internal_method；没有把未批准模板当成监管标准。
- 表格上下文修复分支83/83通过，加入真实parser的synthetic XLSX/DOCX多表、多批次及嵌套表；保持精确材料/解析/工作表边界、隐藏表与公式缓存待核，容量缺口明确uncovered，不能扩张差异复核范围。完整边界见[财务与合规检查记录](m3-review-check-boundaries-2026-10-02.md)。
- 助手最终15/15通过，0跳过；此前助手与共享trial-guard联合23/23。新调用遵守证据门、暂停开关、账号及平台用量限制；证据写入故障保留结果与unknown用量并暂停后续发送，完成结果仍可重放。完整 PostgreSQL/Azurite 流程覆盖真实上传→解析→合成受限模型→问题报告/批注→采纳计划→修订/清洁/基线→处理清单/历史/差异复核/他人下载404。
- `word_promoted` 后注入崩溃，过期租约恢复后报告JSON/hash、报告/批注实际Blob字节hash、完成时间、调用次数和每类唯一成果映射保持不变。
- 助手附件先为全部报告引用预留容量，普通正文省略有提示；发送时不可解析的附件在恢复时不会自动替换为后来解析的内容；未知调用不重发；无范围/计划/账务副作用。
- Web单元48/48；首次浏览器23/23（M3 8 + M1 13 + workflow 2）；处理清单补充后M3浏览器11/11。详见[同尺寸原型与实现截图及行为记录](../../apps/web/test-evidence/m3-review/README.md)。浏览器夹具不是实际供应商或真实Word业务质量证明。
- Python复核报告/原生批注定向7/7；既有修订生成8/8。[实际Word客户端证据](m3-word-client-2026-10-02.md)：Word16.0.20430.20118六例保存重开6/6，最终可读报告再测1/1；WPS不在本机可用软件中。
- 集成后的真实格式/公开证据/修订/完整PG-Azurite链路定向复测17/17通过、0跳过；API工作区真实PG回归1/1通过。
- Codex适配器20/20通过；修复Windows进程树终止命令返回非零时仍永久等待的问题。模拟越权工具尝试、超时、取消、已完成结果重放和未知usage均通过；平台信号/系统进程环境差异单独断言，不降低Linux检查。
- 公开搜索事件journal真实PG/Azurite回归1/1通过：写入校验owner/project/run/call/attempt及有效租约，事件/hash不可变；相同重放可接受，冲突、跨项目及过期租约拒绝，并保留证据故障保护。
- 最终合并`987f11e`后全工作区构建、contracts及表格修复后的worker构建通过。下列联合回归共148项：首轮147通过、0跳过；唯一失败为既有编制测试在Windows找不到`python3`，改为使用明确配置的测试Python后发现精简检出缺少已有知识目录，恢复该跟踪目录后定向复测1/1通过。未更改解析器或放宽断言。共用适配器现为21/21，包含#520材料工具；M3真实PG/Azurite链路、助手、修订及全部新增表格场景通过。
- 真实PG/Azurite解析并发槽回归2/2通过，环境工厂装配检查1/1通过。完整`runtime-entry.test.ts`在Windows执行到`PARSE_STAGING_UNSAFE_ROOT`失败，未绕过POSIX权限检查；随后由下述真实Linux CI补齐运行证据。
- [Linux Actions首次运行](https://github.com/ITSophiaXu/BondBuddy/actions/runs/37004818931)于2026-10-02T12:11:19Z成功：Ubuntu24.04、Node24.14.0、Python3.11.11、PostgreSQL16.10、Azurite3.35.0，实际PR合并树`f989cc94a49fc6f60b57fb178218fda6dc35650a`（head `90ac256` + develop `987f11e`）。构建/契约/迁移通过；Node169/169、Python Word20/20，0失败、0跳过。包含完整runtime-entry/SIGTERM、0700/flock隔离、解析并发、共享worker及M3上传到Word链路；模型仍为synthetic。配置及证据边界见[Linux PR检查说明](m3-linux-pr-ci.md)。这补齐CI环境的Linux测试，不代表生产部署/回滚通过。
- 随后同步`1b06287`：保留#524仅用于编制材料工具的长超时及只读工具恢复识别，同时保留M3搜索事件journal；助手/复核/修订没有被切换为编制材料工具。CI增加`run-runtime`与`unified-timeout-recovery`覆盖共用队列变化；该最新合并树的运行结果以[PR #523检查页](https://github.com/ITSophiaXu/BondBuddy/pull/523/checks)为准，不以首次运行的历史SHA替代。
- [同步后 Linux CI](https://github.com/ITSophiaXu/BondBuddy/actions/runs/37006145251)于2026-10-02T12:25:13Z成功：head `9ea8ed8`与develop `1b06287`的合并树`1ab1c77`，Node173/173、Python Word20/20，零失败/跳过/TODO。这是下述新增修复前的历史证据；新提交的检查结果继续以 PR 检查页为准。
- 实际 Copilot 首次拒绝 schema 中的 `uniqueItems`，报 `invalid_request_body`。适配器仅从供应商副本移除该字段，原 schema 的本地 Ajv/Value.Check 校验仍拒绝重复项；明确请求拒绝不盲目重试，用量缺失仍为 unknown。适配器定向24/24通过，未降低生产校验。诊断CLI也补上原schema的Ajv校验，默认/2020-12方言的重复项拒绝及凭据脱敏2/2通过，避免探测入口误报成功。
- 五类助手实际供应商探测5/5完成，使用当前账号、Copilot Enterprise、沙盒与自动审批；业务口径、结论异议、材料生效日期、跨问题计划、运行中下一轮补充均返回有效结构。完整复核不要求先采纳修订计划。实际 input54,135/output6,479，合计60,614 tokens；cached input包含在input中。见[真实助手探测记录](m3-assistant-live-2026-10-02.md)。这些调用未经过部署后的API/队列/浏览器，不替代该联合验收。
- 显式同表求和定向48/48通过，包含真实synthetic DOCX/XLSX解析及跨批次30与35不一致检出；只有原文公式声明及操作数定位完整时才能确定复算，不由模型自行补公式。标题层级/parser1.0.8定向Node39/39、Python4/4通过；Windows完整parser集中的三个POSIX进程测试交由Linux原样执行，未放宽断言。
- 提议调整与缺项恢复：真实隔离PG API1/1、提议浏览器4/4、不可修订提议1/1及缺失项目信息1/1定向通过，后续截图用例有重叠，不累加为新的完整浏览器总数。计划保存包含原提议/hash及as_proposed/user_adjusted来源，保存/采纳均不创建run；当前任务快照与未发送草稿保持。对应截图见浏览器记录。
- 补充修复显式材料tab返回及弹窗内保存失败提示后，整合`c2c3448`的head`a0bf76f`完整M3浏览器回归17/17通过（Edge，32.5秒）。这是一次完整执行，替代该范围内早期分组计数；四张实现截图重新生成并目视核对。原型与其未发送草稿未改动。
- 固定审计知识与原生公式整合后，财务/domain上下文/修订保护/审计及worker知识、组合、原生DOCX/XLSX、模型、上下文、定位映射定向122/122通过，零跳过；随后新增同记录同数字/单位歧义边界并重跑保护集10/10。两轮共123个不同用例，不将重叠的10项重复累加。独立已核金额、来源冲突及累计舍入待核都能阻止不安全修订；差异复核ID碰撞保留旧未选事项和来源，当前关联结果另有稳定ID及完整覆盖引用。
- 页眉/TOC原生属性最终定向Node20/20（29.0秒）、Python辅助内容安全及分节/关系回归4/4通过，零跳过。20种合成DOCX模式覆盖默认页眉、首页/奇偶未生效变体、字体选择、复杂文字开关、外部未解析正文、简单/复杂/空/脏/锁定/删除/未闭合TOC，以及归属、材料/解析hash、旧版本和要求来源门。结果以带部件hash和节/域位置的覆盖明细呈现，不伪造正文锚点；复杂布局与页码刷新仍未验证。
- 本轮最终全工作区build与contracts再次通过；最终财务组合/保护19/19通过，含12000字说明/200项限制的合法模型回复在差异ID重映射后仍完整保留、报告有效。该组与前述财务组重叠，新增边界为1项，不将19重复累加。
- 本地真实助手链路暴露带点模型ID的结果存储失败：供应商调用已成功且measured用量10955/896已保存，结果字节尚未入库，状态保留pending_reconcile。修复仅使model_id接受公共模型契约已有的点号，归属/资源/路径标识仍严格校验。并发回归另确定性复现PG微秒时间被JS Date截断的问题：同毫秒的先前消息被误判晚于发送时刻；claim现保留PG原始时间文本，历史和附件都使用精确截止时间，未来同毫秒内容仍拒绝。API/worker构建与真实PG/Azurite的provider-results、assistant、provider-reconciliation三文件20/20通过，0跳过。

测试使用独立数据库克隆，不连接模板长期占用，也不操作生产数据库或用户原型存储。首次补写的API测试尝试直接把无交付证据的任务设为成功，被数据库Word门正确拒绝；测试已改为分别验证失败报告可追溯与默认不展示，真实成功行为由完整交付链路验证。

最终联合回归命令（仓库根目录；先设置`BB_TEST_DATABASE_URL`为已迁移且可克隆的synthetic模板、`BB_TEST_AZURITE_CONNECTION_STRING`为测试存储、`BONDBUDDY_TEST_PYTHON`及`BONDBUDDY_WORD_PYTHON`为包含仓库Python依赖的解释器；检出需包含`knowledge/exchange-bonds/drafts/sse-private`）：

```powershell
npm run build
npm run check:contracts
node --test --test-concurrency=3 packages/domain/dist/review-*.test.js apps/worker/dist/review-*.test.js apps/worker/dist/codex-adapter.test.js apps/worker/dist/codex-durable.test.js apps/worker/dist/authoring-material-tools.test.js apps/worker/dist/unified-model-stage.test.js apps/worker/dist/unified-authoring.pg.test.js apps/worker/dist/m3-review-pipeline.pg.integration.test.js apps/api/dist/review-workspace.test.js
# 修复本机Python路径并恢复已有知识文件后的定向复测
node --test apps/worker/dist/unified-authoring.pg.test.js
```

## 实际公开搜索能力探测

2026-10-02，Codex CLI 0.159.2，当前 `copilot-enterprise` / `gpt-6.1-sol`，保留原账号、自动审批和沙盒。只发送公开搜索问题，未发送项目文档；没有修改全局提供商配置。

| 探测 | 实际结果 |
| --- | --- |
| `web_search=live` | 主模型正常完成；input 19010 / output 199 tokens；0个web_search事件；明确工具不可用 |
| 独立启用standalone search能力 | 主模型正常完成；input 23976 / output 324 tokens；0个web_search事件；仍无法调用搜索 |

日志中的粗略字符串匹配不是可靠的鉴权诊断；不能把正常模型调用误报为登录失败。当前事实是未取得真实搜索事件或来源内容。实现中的工具不可用处理已验证，但不能据此通过 #55/#56 的真实搜索验收。不改用其他账号/提供商，不新增被排除的爬虫平台。官方能力配置依据：[非交互执行](https://developers.openai.com/codex/noninteractive/)、[高级配置](https://developers.openai.com/codex/config-advanced/)。

## 运行与发布边界

部署前备份数据库并按顺序执行新增0084/0085/0086；它们不回写旧迁移、不开启收费、不预置专业批准。运行时继续使用已有API/worker与私有对象存储配置；可用模型通过原有Codex适配器设置。真实搜索是可选能力开关，关闭或不可用必须在报告中显示未覆盖。

当前没有生产发布、没有远程迁移、没有部署成功/回滚实测证据。可回退应用到发布前提交并保留新增表/记录，不直接删除不可变审计数据；真实发布前仍需验证旧版应用兼容、备份恢复及资源限制。保持 PR 可审查，所有未完成验收项继续留在原 Issue。
