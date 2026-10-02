# M3 实现与集成验收记录

关联 #47、#48、#49、#55、#145、#56；需求 PR #519 已合并，最终集成基线 develop `987f11e`（包含 #520 直接编制材料工具）。本记录随实现提交，描述实际证据，未勾选 GitHub 验收项或关闭 Issue。M3 不包含收费、参考库或商业数据接口前置。

## 已实现范围

| Issue | 本次交付 | 尚不具备的验收证据 |
| --- | --- | --- |
| #47 | 两标签工作区；直接解释/补证/计划/执行；默认收起助手与真实持久调用入口；工作台版本及草稿恢复 | 本地供应商的五种业务对话与授权真实材料联合验收 |
| #48 | 有归属及完整版本/hash的审计证据映射；精确算术；同表跨批上下文；不确定/OCR/冲突保留；差异范围与沿用 | 全品种授权金标准集的误报/漏报与专业质量报告；复杂表头/口径语义和跨批公式图仍待人工 |
| #49 | 精确市场/品种规则消费者、作用范围、效力来源、真实解析格式检查；缺知识与适用性保守处理 | 生产适用性白名单仍为空；没有完整已批准的 DFI 注册/一期和全部品种专业成果验收 |
| #55 | 财务/合规/公开维度合并；实际搜索事件审计；DOCX报告/原生批注；差异与恢复 | 本机 Copilot 两次实际探测均无搜索工具事件；WPS 和跨客户端往返未验证 |
| #145 | 明确采纳和执行；固定原报告/源稿/范围；修订/清洁Word与处理清单 | 授权真实文档的专业修订质量与全部复杂布局验证 |
| #56 | PostgreSQL/Azurite真实链路、合成模型子进程、浏览器、权限/恢复/零计费回归 | 真实供应商、全品种/DFI专业金标准、WPS、生产部署版本/回滚实测 |

“技术交付成功”和“专业复核通过”独立。未执行的关键维度、未验证语义、沿用项以及已修改项不会变成通过；专业与部署缺口尚在，不能声称六项全部完成。

## 工程证据

环境为 Windows、Node 24.14.0/npm 11.9.0、Python 3.11+、PostgreSQL 16（独立合成测试模板）、Azurite、Microsoft Edge。实体、财务数值、API浏览器夹具及模型子进程响应明确为 **synthetic**；实际数据库、文件上传/解析、Blob 字节、Word生成器、下载及恢复均执行真实代码。

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
