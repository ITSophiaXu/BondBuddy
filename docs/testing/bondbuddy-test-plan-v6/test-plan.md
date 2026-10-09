# BondBuddy Test Plan v6 — 快速进入用户测试

发布日期：2026-10-09；计划调查日期：2026-10-08。先读[执行入口](README.md)，复制[执行结果模板](execution-report-template.json)并冻结本轮范围。

**v6.1场景增补：**[用户行为任务卡](user-scenarios.md)将工程机制展开为6正常、7异常、10corner场景及逐步恢复；[结果模板](user-scenario-result-template.json)单独记录Agent/Human观察和功能/设计缺口。用户已确认暂停补料后继续原任务是验收目标，现有取消后新建不能替代；积分规则尚需设计。增补按最新develop `55941dc`核对，新已发布固定60积分QA覆盖本计划相应新任务的旧按量/成本配置/“60未批准”口径；旧已提交run保留原锁定协议，线上配置仍须核验。

**版本边界：下表保留原v6在2026-10-09当天较早重新核对的远端 develop/master SHA；随后v6.1增补已重新核对develop `55941dc`，新增功能与QA价口径见上方增补及用户场景。线上、页面、资源 hash、收费开关和迁移状态仅为 2026-10-08 的历史观察，发布当天未重新核验运行环境。执行前必须重新核验并登记实际版本/配置。** 下文“当前/最新/今天”涉及运行环境时均指调查时点，不能作为新一轮 pass 证据。

本计划先核对最新远端源码与正式站，再按实际产品行为设计测试。覆盖募集书编制/更新、复核、四文种材料生成、全站助手、资料、账号和积分。每个用例都有目标、操作、通过标准及 Agent/Human 分工；后附每日 bug bash、永久回归登记和发布基线。

**本轮首要目标：尽快达到受控邀请用户测试的准入条件U。** 79组是完整覆盖池，不是邀请用户前必须逐组完成的清单。Agent先完成7个必要检查包，Human用30–60分钟有效操作做代表流程/成果预检，U通过即可开始用户测试；完整E/R发布验收与历史对账继续并行。当前采用小批受邀、限定实际已部署功能的首轮试用范围，不据此声明正式发布或全部专业验收完成。

**本轮完成版本调查与计划设计，没有执行完整产品测试、真实生成、支付或部署。公开健康检查和页面只读观察单独记为调查证据，不能算用例全部通过。**

<!-- test-ownership-summary-start -->
**执行分工：65项由Agent独立测试，3项必须Human验收，11项由Agent预检后交Human验收。** 每个用例最后一列已用中文标出执行者；[第3章](#3-agent--human-执行分工明确清单)列出完整ID与逐项交接。

| 谁来测试 | 用例数 | 具体范围 |
|---|---:|---|
| **Agent独立测试并判pass/fail** | **65** | 权限/上传/输入固定/恢复/并发/计费/账本/确认卡/dashboard/性能/镜像；完整ID见3.1 |
| **必须Human最终验收** | **3** | BB-036专业文书；BB-037摘要内容；BB-039真实Word/WPS |
| **Agent预检＋Human验收** | **11** | BB-012/013/016/023/027/029/032/035/038/051/067；逐项分工见3.3 |

这是测试分配，不表示65项已经实现自动化或已执行通过。真实调用按既定测试环境/授权预算执行。
<!-- test-ownership-summary-end -->

## 1. 最新版本与功能基线

### 1.1 源码参考与2026-10-08历史线上观察分开登记

| 对象 | 2026-10-08 调查结果（北京时间） | 证据与可信边界 |
|---|---|---|
| GitHub repo | ITSophiaXu/BondBuddy；默认分支 develop | 已使用具有访问权限的既有账号重新鉴权读取 GitHub，并成功 fetch |
| 最新 master | `a6fa7eb030f7f9bc4c803176b2aacf38d35642b6`；17:22:48；发布 PR [#616](https://github.com/ITSophiaXu/BondBuddy/pull/616) | 2026-10-08查询；2026-10-09重新查询未变化 |
| 最新 develop | `ebae7f6b50aaacff34cab717a5bde5892fe239b6`；17:14:08；功能 PR [#615](https://github.com/ITSophiaXu/BondBuddy/pull/615) | 与 master 源码树相同，提交身份不同 |
| 两分支源树 | `9930a4f4c981cdff0275a1698f16dd8188225bb8` | 源码引用固定到 master SHA；develop/master 当时源树一致 |
| 固定源码参考 | [AGENTS.md](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/AGENTS.md) | 以下源码证据固定到此 SHA；实际测试须使用冻结的运行版源码 |
| 最新有部署回执的 Web | `6f2e2305a64b03ef0e699da8b68ddbb68c3b0eea`；14:38；[#610 回执](https://github.com/ITSophiaXu/BondBuddy/pull/610#issuecomment-6054025965) | 部署记录中的版本；当前公共资源 hash 与回执一致 |
| 最新有部署回执的 API/worker | `2e7b33475a35957c5131753eadf60223f76ef375`；0099 已迁移；[#593 回执](https://github.com/ITSophiaXu/BondBuddy/pull/593#issuecomment-6051589302) | 报告版本；公开端点未提供运行 SHA，尚未独立读取容器版本 |
| 正式站直接探测 | [bondbuddy.gululai.com](https://bondbuddy.gululai.com/)；19:03：首页、`/healthz`、`/api/v1/ready` 均 200；DB/Blob/证据门/worker heartbeat 均 ok | 本轮公共只读观察；heartbeat age 11 秒，不证明业务端到端交付 |
| 当前 Web 公共资源 | `/assets/index-FcPIb1Ll.js`；SHA256 `76e45c7b5425d7d5d25cd92aa9e3f8c4af84f3c250e11c368584d071ffc04642`；CSS `/assets/index-KlPkIRHL.css`，SHA256 `628fb6ff77bfaadb667ae4ab008622fff4f1fb75c83f53b867588035db694796` | 当前下载字节与部署回执匹配；不能据此推导 API/worker SHA |
| 当前页面观察 | 工作台有状态统计/三业务筛选；既有材料草稿有四文种/独立表单/一次生成按钮；账号仍为旧信息与内联折叠设置布局；三页未见悬浮助手 | 复用浏览器既有登录会话，仅查看；未填表、保存、上传、执行或付费 |
| 尚待线上更新 | 最新全站助手 #616、0100 迁移；新账号布局缺完成回执 | [#612 17:26 阻碍记录](https://github.com/ITSophiaXu/BondBuddy/issues/612#issuecomment-6056852842) 与当前页面相符；不能写成最新 master 已上线 |

历史回执可通过上表 PR/Issue 链接核对。原公共探测、页面只读观察及调查过程保存在本地，未随本包提交；这些记录不能作为团队本轮可复核的通过证据。

### 1.2 当前功能与执行规则

| 模块 | 最新源码行为 | 测试重点 |
|---|---|---|
| 募集书编制/更新 M1 | 原稿选填；每份上传原稿源信息必填；源/目标独立。报价展示后用户明确确认执行。修订版+清洁版可下载 | 准确输入/底稿、八档固定价、提交后材料只读、旧协议恢复 |
| 募集书复核 M3 | 一次 CLI 执行可直接交付报告 Word，无须 findings JSON；旧报告沿原协议 | 文件报告、租约/取消、下载与幂等结算；收费开关按环境核对 |
| 材料生成 M4 | 四文种：立项报告、主承销商核查意见、法律意见书、普通私募募集说明书摘要；沪/深交易所普通私募、单机构、单份全文 | 4 文种×2 交易所，共 8 组合；真实正文 DOCX+独立说明 DOCX；明确全文新版本 |
| 材料表单 | 选择文种→交易所→来源→模板/支持材料→可选要求。材料页无常驻嵌入聊天；一次点击生成，内部 save→quote→execute | 不要求用户再看报价/第二次确认；输入变化、丢响应、充值返回不能误提交 |
| 模板/知识 | 八个市场/文种知识包，服务端选完整 MD、版本/hash 并固定到 quote/run；立项仍需本账号券商模板，其余三种可用系统知识 | 精确匹配、只读挂载、客户端不能覆盖知识；摘要需要准确募集书来源或续改底稿 |
| 全站助手（最新源码，待部署） | 登录后右下角按需展开、收起/宽屏、近期/新会话、跨页恢复；建议后生成可编辑任务卡 | 普通回复/准备卡不执行不冻结；**用户确认卡**才调用原业务入口；项目切换/退出/跨账号隔离 |
| 助手成果续改 | 明确选定的清洁版作为准确募集书底稿，沿用市场/品种/期间和限制；纯内容续改按一期更新 | 固定 artifact/version/hash，纯内容应 17,900 而非新编 159,900；保留旧成果 |
| 专业 QA | 原上限按量计费、宿主 Decimal 财务工具、材料引用/两期比较、免费帮助与既有回答文本导出 | 每轮重新分类；付费提问先展示实际 cap，再次确认；生产成本配置缺失时真实收费拒绝 |
| 原件上传 | 存储声明支持格式的原始字节，核对归属/会话/大小/容量/hash；上传前不做 PDF 解码、Office 解包、OCR、验签 | `signature_assessment=null` 是未评估；100% 传输不等于保存完成；lost complete 同 key 核对/重试 |
| 工作台 | 每个未归档项目的当前/最近 run 决定待处理、进行中、已完成；三业务一行/项目；完整分页后统计 | 测试完成不算正式完成；旧成功不能盖住最新失败；30 秒刷新、精确 run 链接和筛选保持 |
| 账号/积分 | sidebar 用户名/退出、余额入口；新账号仅用户名/脱敏手机号与设置弹窗；主余额=available+reserved | 预留时不当作已消费；成功才扣、失败/取消释放；长用户名、手机布局、退出清理 |
| 本期范围外 | 推荐函、公募/协会/DFI、多机构或文书组合、M4 精确局部改稿、实时法规检索/深度研究 | 保留意图和资料、说明范围，零替代任务/收费；不要继续把核查/法律列为未开放 |

两类入口必须分开验：**材料表单一次点击生成；全站助手必须确认任务卡。** M1 编制提交后的材料只读不能套到 M4：M4 运行中可保存下一草稿/补充，但不能改变当前 run 的固定快照。

M1 的“可下载”只表示文件可用，`content_review=not_performed`；不得把完整 XML、内容、修订一致性检查重新设成下载门。M4 的两份 Word 是正文+说明，不能混为 M1 修订版+清洁版。专业正确性及 Word/WPS 质量另行验收。

### 1.3 源码价格与历史部署配置边界

| 任务/配置 | 当前口径 | 必须验证 |
|---|---|---|
| 新 M4 文书/明确全文新稿 | 固定 **4,500** 积分；`m4-document-fixed-20261008-v1` | 提交预留；两份真实 Word 存储/hash 回读/登记后结算 4,500；失败/拒绝/有效取消全释放；unknown usage 保留审计但不阻固定价成功 |
| 募集书编制/更新 | `authoring-20261008-v1`：一期 17,900；年度 27,900；补两年 48,900；补三年 68,900；迁移 64,900；迁移两年 85,900；迁移三年 105,900；新编 159,900 | 八档分类、显式报价确认、余额不足前后端拒绝、锁价、旧试用不追补 |
| QA/历史按量文书 | QA 沿原 capped metered；旧文书 run 沿其锁定旧价 | 不把 4,500 套给 QA；unknown 按量先待核；固定文书不依赖 QA 成本率 |
| 线上收费回执 | `BB_PAID_AUTHORING_ENABLED=1`；复核付费开关 0；QA 正式成本配置未发布；充值未接通 | 按实际配置展示，60 积分/次仍是提案；已有积分仍可按已开放文书/编制政策消费 |
| 充值 | 新最低 20,000 积分/¥200；新 cny50 拒绝；旧合法订单值和幂等到账保留 | 未接通渠道不虚称成功；充值/返回不自动开始任何业务 |

主要决定：[全站助手](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/product-decisions/2026-10-08-global-project-assistant.md)、[材料固定价](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/product-decisions/2026-10-08-m4-fixed-document-price.md)、[四文种知识](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/product-decisions/2026-10-07-material-drafting-knowledge.md)、[原件上传](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/product-decisions/2026-10-07-pdf-original-upload.md)、[收费启用回执](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/acceptance/authoring-credit-activation-20261008.md)。

## 2. Test goals：按五项业务目标验收

以下五项是用户确定的一级业务目标，用于组织用例、每日bug bash和release baseline。输入/内容准确归入G1；权限隔离、异常状态和故障恢复归入G5，作为业务目标下的具体检查。Agent/Human执行分工继续按第3章登记。

| Goal / 用户业务目标 | Test goal：要证明什么 | Pass criteria | 代表用例 |
|---|---|---|---|
| **G1 业务模块都能够正确完成** | 本次声明开放的募集书编制/更新、复核、四文种材料生成、QA、助手及账号模块，能从有效输入完成各自预期结果；来源/版本/企业/期间/关键事实正确 | U：每个试用模块至少一条真实闭环，开放四文种时各一个已授权市场，共4组合；关键事实/文件可用性预检通过，无核心P0/P1。R：沪深×四文种8组合及M1/M3代表旅程，完整专业和Word/WPS验收通过 | BB-013/016/027/029–039/067/069/075/077/078 |
| **G2 user flow正确流畅** | 用户能顺畅完成“进入模块→准备资料/要求→明确执行→查看进度→阅读/下载→继续修改”；页面切换、返回、刷新、错误重试保持上下文，确认步骤符合入口设计 | 关键旅程100%通过，无流程死路、意外执行、输入/焦点/阅读位置丢失；材料表单一次生成、助手确认卡和M1报价确认各自正确。客观UI由Agent验；连续使用体验由Human在BB-051验；响应时间按已确认SLO实测 | BB-005/010–011/019–026/040–043/051/062–068/070–075 |
| **G3 积分使用/消耗正确** | 报价、余额、预留、消费、释放及历史任务收费，准确符合本轮任务和锁定版本 | 四文种双Word交付后只扣4500一次；八档编制价及一期17900准确；不足不超支/误启动；失败或有效取消按协议释放；主余额和ledger一致；免费操作不扣积分；QA/legacy与固定价的unknown处理正确，旧任务不追补 | BB-014/044/052–058/066–068/073–074 |
| **G4 修复稳定回归** | 每个已修复问题有永久复现用例，新候选不会破坏已修复行为或既有业务/协议 | U：试用范围/当前diff涉及的已知资金、权限、误执行、底稿、恢复P0/P1永久断言全部通过；记录版本/映射及未覆盖项。E/R完整发布baseline：全历史fix对账、未映射fix=0、可信旧fail→候选pass、全部适用永久回归100%通过，无必跑fail/blocked/skip/todo。不因准入缩小而删除原断言或隐藏已知风险 | 全部registry关联用例，以及BB-001/017/056/060/074/076 |
| **G5 可靠性：异常情况和bad case可以处理** | 缺材料/错误输入/错权限/余额不足、网络中断、丢响应、并发、超时、取消、worker崩溃、服务不可用等，有正确状态、可操作提示和安全恢复 | 所有必跑异常分支符合各自协议：正确拒绝/暂停/恢复/释放/结算；保留输入/来源/审计，不重复执行/扣费、不越权泄漏、不假报成功。队列未启用允许paused并保留预留；固定文书unknown双交付可结算，QA/legacy按量unknown待核 | BB-004/007–012/024/026/043–050/052–057/063–068/070/072/074 |

G1和G2分别回答“结果是否正确”和“用户能否顺畅完成”；页面可点或文件已生成，不能单独证明两项目标都通过。G3要求精确金额/积分断言，G5要求逐个异常分支的正确处理，不能用总体成功率掩盖资金或数据问题。

G4在U按准入范围登记，在E/R按完整发布门登记；U pass不等于全历史回归已完成。registry里的永久用例关联G4，但一条通过不等于完整G4完成，还需全历史对账与整套候选证据。每goal、每阶段分别记录pass/fail/blocked/not_run；覆盖数量不能相加当总用例数。

范围与声明必须明确：U使用真实代表闭环及同运行版工程证据，Human做试用质量预检；E/R完整验收继续跟踪。缺真实闭环或U必要Human预检时不能邀请该模块；缺R完整专业签认不等于禁止已通过U的受控试用。未开放功能验准确说明和禁止替代执行，不假写已完成。

### 2.1 本轮成功标准：能够开始用户测试

| Goal | U准入要证明的最小结论 | 用户测试阶段继续验证 |
|---|---|---|
| G1 业务完成 | 每个本轮开放模块真实输入→真实处理→正确成果/可下载，关键来源/事实未见阻碍 | 不同项目、材料与真实需求下的业务适用性和专业质量 |
| G2 流程 | 代表旅程无死路/意外执行；一位业务用户理解操作、费用和结果 | 无引导完成率、困难步骤、任务耗时和体验反馈 |
| G3 积分 | 实际启用价格、预留/成功扣费/失败或取消释放正确，重复/并发不多扣 | 真实用户是否理解费用；持续逐run对账 |
| G4 回归 | 当前范围及变更涉及的已知高风险fix全部通过 | 每个新bug补永久复现；完整历史清单并行对账 |
| G5 可靠性 | 权限/余额不足/丢响应/刷新/取消/关键checkpoint恢复可处理 | 更多异常与材料变体，发现后定向修复，不重复全部真实故障矩阵 |

Agent用例占65/79，约82%，是执行责任分配，不能等同82%已自动化或82%用户体验已验证。自动断言减少机械重复；真正用户的业务理解、专业反馈和连续使用在U之后成为本轮主要工作。准入必须看这些必要证据，不能只看用例数量或整体通过率。

P0：跨账号泄漏、资金/重复扣费、不可恢复数据丢失等。P1：核心闭环失败、错误来源/底稿/关键数值、虚构重大事实、意外执行、历史静默丢失。P2：存在可靠替代路径的非关键问题。P3：轻微视觉/文案问题。

## 3. Agent / Human 执行分工：明确清单

判定规则：有可复算数值、固定状态、文件hash、权限结果或账本数量等客观标准时，由Agent独立测试并判定；涉及真实专业内容、材料解释、桌面客户端质量或使用体验，由Human作最终判断。界面机械操作与财务算术本身不需要人工重复。

### 3.1 Agent可以自己完成并判定的65项

完整用例ID：`BB-001`、`BB-002`、`BB-003`、`BB-004`、`BB-005`、`BB-006`、`BB-007`、`BB-008`、`BB-009`、`BB-010`、`BB-011`、`BB-014`、`BB-015`、`BB-017`、`BB-018`、`BB-019`、`BB-020`、`BB-021`、`BB-022`、`BB-024`、`BB-025`、`BB-026`、`BB-028`、`BB-030`、`BB-031`、`BB-033`、`BB-034`、`BB-040`、`BB-041`、`BB-042`、`BB-043`、`BB-044`、`BB-045`、`BB-046`、`BB-047`、`BB-048`、`BB-049`、`BB-050`、`BB-052`、`BB-053`、`BB-054`、`BB-055`、`BB-056`、`BB-057`、`BB-058`、`BB-059`、`BB-060`、`BB-061`、`BB-062`、`BB-063`、`BB-064`、`BB-065`、`BB-066`、`BB-068`、`BB-069`、`BB-070`、`BB-071`、`BB-072`、`BB-073`、`BB-074`、`BB-075`、`BB-076`、`BB-077`、`BB-078`、`BB-079`。

| Agent独立测试的范围 | 举例 | 自动pass criteria与证据 |
|---|---|---|
| 版本/健康/迁移/部署/资源/性能 | BB-001/002/059/060/076 | SHA/digest/ledger/hash与manifest一致；健康/heartbeat正常；p95和终态实测；staging恢复/回退正确 |
| 注册、登录、账号安全/注销、权限隔离 | BB-003/004/061/063/077 | 越权拒绝、零泄漏/写入，失效会话清理；旧响应不污染新账号 |
| 上传、保存、材料/来源/草稿恢复 | BB-006–011/014/017–022/026/028/042/043/062/072 | 原字节/hash准确；幂等回执；准确输入/底稿；丢响应/刷新不丢状态；材料锁按协议生效 |
| 并发、任务互斥、取消、崩溃恢复、安全沙箱 | BB-024/025/033/040/041/044–050/064–066/079 | 每key一次run；恢复不重调；终态不倒退；原件只读、越界拒绝；确认前零非QA文书执行 |
| 计费、积分、支付沙箱与算术 | BB-030/031/052–058/068/073/074 | 4499不足/4500足额；双Word后扣4500一次；失败释放；一期17900；八档价/账本准确；60%、百分点/相对增幅可复算 |
| 导航、工作台、账号布局和项目生命周期 | BB-005/015/019–021/034/069–071/075/078 | 精确run链接、全分页统计/失败保旧快照、表单边界、Escape/焦点/尺寸正确；点击不意外新建任务 |

上表按主题举例，个别联合case的机械子检查也可由Agent完成；**完整65项归属以本节ID清单及第4章执行列为准。** Agent需要可用的测试环境、账号与fixture；缺环境记blocked，不能将“可由Agent执行”写成“已经覆盖/通过”。

### 3.2 必须Human最终验收的3项

| 用例 | Human必须做什么 | Human pass criteria | 审核角色 |
|---|---|---|---|
| 专业 BB-036 | 对照来源审阅立项、核查、法律正文及说明 | 结构/依据/关键事实准确；没有虚构核查、内核、签署/审批；法规效力和待核项如实说明 | 债券业务/核查/法律专业审核人 |
| 专业 BB-037 | 对照原募集书逐项审阅摘要 | 关键数值、条款、投资者限制准确；重大负面事实未被无依据删掉；摘要无误导 | 债券业务审核人 |
| 客户端 BB-039 | 在真实Windows Word与WPS打开、编辑、修订/批注、保存重开 | 无修复警告/乱码/缺表；目录/分页/表格可用；修订操作正常；两客户端分别留证 | Word/WPS实际使用者 |

Agent可先整理引用、差异、可疑数值、文件hash和检查表，Human负责以上结论。不能让另一个Agent充当Human签认。

### 3.3 Agent先测，Human再验收的11项

| 用例 | Agent负责（客观检查） | Human负责（最终判断） | Human角色 |
|---|---|---|---|
| 联合 BB-012 | 原文定位、期间候选、OCR疑数、已确认日期规则 | 扫描原件/表头是否支持数字与期间；疑点是否恰当处理 | 业务/财务审核人 |
| 联合 BB-013 | 企业关系、输入hash、源/目标、输出事实对照 | 是否把母公司/子公司/参考企业事实写成目标企业事实 | 业务审核人 |
| 联合 BB-016 | 一次CLI、真实报告Word、下载hash、无JSON重问 | 复核问题及覆盖说明有无材料依据，是否误导专业结论 | 复核业务审核人 |
| 联合 BB-023 | v2底稿/version/hash、旧版保留、要求进快照 | 新正文是否实际沿用v2，兑现修改要求与禁止项 | 文书业务审核人 |
| 联合 BB-027 | 8组合知识/模板、版本/hash、私有归属 | 模板/知识是否适用业务；旧指引/IRM未读限制是否如实说明 | 文书业务审核人 |
| 联合 BB-029 | 每轮分类、免费/付费边界、报价和执行证据 | 回答的专业概念是否正确，实际内容是否属于帮助/准备/专业分析 | 业务审核人 |
| 联合 BB-032 | 缺值/零分母、单位/币种/期间冲突、来源定位 | 会计口径与可比性；缺项和风险解释是否有依据 | 财务审核人 |
| 联合 BB-035 | 8组合真实CLI、正文+说明、hash、调用/终态账务 | 引用BB-036/037/039的专业和客户端结论，不重复审阅同文件 | 业务+Word/WPS审核人 |
| 联合 BB-038 | v1→v3稿次、旧hash、每轮4500锁价、要求快照 | 新稿兑现要求、原限制/关键事实保留 | 文书业务审核人 |
| 联合 BB-051 | 屏幕尺寸、焦点/滚动/键盘、控件稳定性 | 连续真实业务旅程是否易懂、顺畅，提示是否可操作 | 真实业务用户/UX审核人 |
| 联合 BB-067 | 准确clean底稿/hash、原市场/品种/期间、17900分类 | 正文是否按请求改动，关键数字/局部范围/禁止项是否保留 | 募集书业务审核人 |

联合例分别记录「agent_result」「human_result」。工程E阶段可先通过合成/协议的Agent子例；真实验收R要求相应Human结果通过，不能把Agent pass升级为整例专业通过。BB-035复用同批文件的BB-036/037/039审核，避免重复审阅。

### 3.4 Daily bug bash怎么分工

- **Agent每天**：运行快速smoke/受影响历史回归，报告资金、权限、输入/版本、幂等、恢复和页面状态；故障注入在隔离环境。完整历史P0按第5章在夜间/RC及相关变更前执行。
- **Human每天10:15–11:00**：按当天主题抽3–5条连续业务操作或待复验bug。机械上传、计费、刷新不用重复手验；理解/专业疑点回到BB-051或对应联合例。
- **首次统一验收、受影响RC/专业或客户端修复后**：Human执行BB-036/037/039及受影响的11条联合例；每日不全量重复14条人工相关用例。
- **完整E/R发布基线**：65条独立例登记Agent报告；3条人工例与11条联合例的真实验收子例登记Human角色/日期/文件hash/结论。U只登记6.0准入子例和短Human预检；历史审批或旧截图不能替代受影响验收。

### 3.5 数据与执行层

执行层：**E（engineering）**为隔离环境合成/协议/浏览器/真实API工程回归；**U（user_testing）**为小批受邀用户测试准入，只要求6.0选定的必要子例与Human预检；**R（real_acceptance）**为完整真实模型/专业/客户端验收；**O（online_smoke）**为实际站点观察。U不用等待完整E门或R签认，但所选工程/真实准入断言必须通过；U不等于公开发布批准。

not_run / blocked / skipped / N/A均不是pass。N/A须写批准范围/feature状态及仍保留的负例。合成模型/HTTP、历史截图不作为真实CLI/后端/专业通过证据。

数据集：

- S0：两个 owner、至少三个项目、8 会话/8 成果/46 消息；四文种×两市场、v1/v2 来源与模板、4499/4500/多任务钱包、边界格式/大小、错 hash/租约/网络故障。CI 不调用真实模型。
- R1：仓库已授权任丘九月、章丘年末、杞县扫描/多年、任丘六月日期冲突四组材料；读取 [样本清单](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/tests/samples/README.md) 的 hash 与目标确认，不重复猜目标期间。
- R2：沪深各四文种真实验收资料；立项需真实本账号券商模板；深交所授权样本/券商模板缺失的组合记 blocked，不能换标题冒充。核查/法律可使用系统知识，不强制私人模板。
- R3：旧免费/旧按量文书/旧试用、failed/paused/usage unknown、旧充值订单和旧报告协议脱敏快照，用于迁移/恢复/锁价。
- K0：`material-drafting-2026-10-07-v1` 的 8 个知识包/[catalog](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/knowledge/material-drafting/2026-10-07/catalog.json)。2023 指引不等于现行法律已核验；上交所独立 IRM 核查模板未读取，采用完整指引，不宣称逐字模板一致。

环境：Node 22、业务 Python 3.11+、可克隆专用 PG16 测试库、Azurite、Linux worker 与生产 Docker 镜像；Chrome/Edge 桌面 1360×900、390×844/320px/1920px、键盘。真实模型与支付沙箱另有指定环境/预算。故障注入、删除、支付回调/账本重放只在隔离环境；线上日常以版本、健康和既有授权成果只读为主。

### 3.6 审查后如何减少重复执行

下列是**共享执行包**，每包保留各ID的独立断言与结果。只有同候选SHA、同fixture/input/request key、同run/文件hash、同适用配置的证据可以共享；缺少某断言仍记not_run/fail，不能因另一ID通过而连带pass。

| 执行包 | 覆盖ID | 一次执行复用什么；仍须分开什么 |
|---|---|---|
| 材料表单提交 | BB-025/026/044/053/058 | 单击/同key双击/丢响应共享run、预留、调用、outbox；4499不足和有效4500、字段变更仍各跑独立分支 |
| 助手准备与确认 | BB-024/034/064/065/066/044 | 同一准备卡/确认请求核对范围、零预执行、快照及重放；三类业务入口各一条协议正例，过期/越权是各自负例，不必各调用真实模型 |
| 钱包与计费 | BB-052–056/068/073/074 | 同批run/ledger/lot验证价格、预留、结算和前端余额；固定价/QA/legacy、同key重放/不同key竞争、有效/过期赠送不可互相代替 |
| 上传与恢复 | BB-006/007/010/011/028/042/043/062/063 | 同一资料/会话fixture复用回执/hash与持久化读取；upload complete/草稿save/execute三个丢响应机制分开注入；不同surface与账号切换分别断言 |
| M1/M3完整旅程 | BB-013/015/016/018/039/067/072 | 同一代表旅程产生的双Word/报告供下载、后续绑定、内容续改与Word/WPS审阅；不要为每个读取/绑定ID再生成 |
| M4真实文件 | BB-027/035/036/037/038/039/041/054/059 | 首次8组合的文件供知识/来源、专业、客户端、账务与耗时验收；续改用新稿。相同hash文件不重复专业审阅；模板/知识批准按版本/hash复用，内容变动复验受影响文件，生成/结构/渲染变化复验客户端 |

E报告中的权限、故障注入、支付重放、幂等与确定性账务用于R的工程前提，**R不再次把全部异常矩阵改用真实模型运行**。R仅增加代表真实业务闭环、受影响真实联调、专业内容与客户端证据。联合case的E子例和R/Human子例分别登记。首次统一验收八组合保留；后续按已批准baseline与diff决定真实组合，不能将每个UI修复都要求重新生成八组合。

故障与边界以具体机制选例：同key幂等和不同key争钱包不同；固定价与按量unknown不同；表单直接生成与助手确认卡不同。保留这些必要差异，不做所有文种×所有故障×所有价格×所有客户端的笛卡尔积。

O每日仅版本/健康与页面可用性；公共资源hash在候选切换或异常时核对，可引用同观察窗口证据。代理无需每日重新下载同批成果全文；成果交付/授权/存储变更后再校验下载hash。

## 4. Test cases 与逐例 pass criteria

每行是一组稳定场景；列中多个分支应在执行报告拆分 subcase，不能只跑一个分支就整行 pass。通过标准以真实后端/账本/文件证据为准，不只看页面文案。新功能在旧线上版本记“尚未部署”，在最新候选 E 环境验证；不会要求当前生产先运行不存在的功能。

### 4.1 版本、身份与原件

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-001 P0 G4/G5 | 核对候选/实际 web、API、每类 worker SHA/digest、资源 hash、迁移/flags/模型/价格 | 与 manifest 一致；0098/0099/0100 逐项 ledger；公开资源不能替代后台 SHA；未查到不能签运行版一致 | Agent独立 / E+R+O |
| BB-002 P0 G4/G5 | health/ready/heartbeat/DB/Blob；隔离环境断依赖 | 正常均健康；故障 readiness 明确失败；首页 200 不掩盖 worker 故障；不返回正文/凭据 | Agent独立 / E+R+O |
| BB-003 P0 G1/G4/G5 | 注册/协议版本/重复用户名/错误登录/限流；有效登录、access刷新轮换/过期、撤销session/退出；失效身份读取已有成果 | 合法注册登录可读本人项目；未接受当前协议/非法或重复注册拒绝且无半成品账号；错误登录统一提示、限流不泄露账号；刷新按服务端协议轮换，撤销或失效身份不能访问/刷新；旧异步请求不污染新账号；退出清理前端状态。账号动作闭环另见BB-077 | Agent独立 / E+R |
| BB-004 P0 G5 | owner B 猜 A 的 project/topic/card/material/template/artifact/run；伪版本/hash | API/worker 均拒绝，无字节/私有 metadata/写入/执行/预留；无越权隐式绑定 | Agent独立 / E+R |
| BB-005 P1 G1/G2/G3/G4 | 三业务导航、旧 #qa/充值/数据链接、查看套餐 | 新/旧入口到准确页面/子区并保留上下文；最低 20000/¥200；新 cny50 拒绝；充值禁用状态真实 | Agent独立 / E+R+O |
| BB-006 P1 G1/G4 | DOCX/XLSX/电子/扫描/签名 PDF 等声明支持格式；同名异字节；杞县审计原件 | 原字节/hash/size/role/version 准确；杞县 7,227,129 bytes 与样本 hash 一致；signature_assessment=null；无上传前解码/OCR/验签/Office 解包 | Agent独立 / E+R |
| BB-007 P0 G4/G5 | 声明支持格式但内容损坏/含活动内容/实际类型不符；不支持声明、空/单文件大小边界、错会话/路径；500MiB/60文件容量最后槽并发、满额精确原件去重 | 支持声明且基本校验合格可保存为opaque原件，不承诺可解析/可信签章；容量等于上限/超过1byte/第60和61项精确断言，最后槽并发不超额；满额仅同owner/project/role/media/size/hash且未删除原件可复用，不跨role或靠hash误复用；错误归属/声明/会话拒绝且无执行/预留；不恢复上传前parse/OCR门；任务内安全见BB-050 | Agent独立 / E+R |
| BB-008 P1 G1/G2/G5 | M1 无原稿；两份上传原稿分别遗漏源发行人/关系/市场/品种/报告期 | 无原稿可准备；每份原稿信息不完整时不能报价/新提交；零 run/reserve；补齐仅保存不自启 | Agent独立 / E+R |
| BB-009 P1 G1/G2 | 替换一份原稿/改另一份目标期间/重读 | 对应源声明准确更新；另一份源声明保留；源/目标期间独立；无关字段编辑不丢期间 | Agent独立 / E+R |
| BB-010 P1 G2/G4/G5 | PUT 100%；complete 响应丢失/暂时失败/重复完成；同名错误记录 | 100%不先显示已保存；精确 owner/project/hash/size/role/media 回读；可自动同 key complete 重试且仅一记录；不重传、不启动任务/扣费 | Agent独立 / E+R |
| BB-011 P1 G2/G4/G5 | 多文件一项失败；上传/保存/poll 中用其他 picker | 其他项继续且 picker/焦点不被拆；失败可见；只重试原 session；不丢未完成项 | Agent独立 / E+R |
| BB-012 P1 G1/G5 | 执行内 OCR 疑数/隐藏旧页/审计编号年与会计年度不同/真实日期冲突 | 有表头/期间来源；疑数不当核实值；不拿旧隐藏页作最新期；按既有目标确认处理；上传不单建 parse 前置 | Agent预检＋Human验收 / E+R |

### 4.2 编制/更新与复核既有主链

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-013 P1 G1/G2/G3 | M1从新建项目/原件→保存输入→展示并确认报价→CLI/进度→修订版+清洁版→下载/结算→明确继续下一版；无稿、同企业/母子公司/相似企业来源分支 | 正向闭环无死路，双Word与当前run/input/hash对应并按锁定价格一次结算；旧clean/旧成果保留供下一轮，原snapshot不变；允许无稿；参考企业财务不当作目标事实；材料/源/目标/要求/知识固定；无稿首稿不伪造历史修订。E用受控模型，R代表新编与更新真实CLI/专业结论，八档不逐档重复真实生成 | Agent预检＋Human验收 / E+R |
| BB-014 P0 G2/G3/G4/G5 | M1 报价后修改材料/期间/要求，旧价确认；有效提交同 key 重放 | 旧 quote 因变化失效无预留；新报价明确确认；有效 input/hash 固定；同 key 返回同 run | Agent独立 / E+R |
| BB-015 P1 G1/G2 | M1 双 Word，content_review 未执行或辅助 baseline 不全 | 文件归属/存在/hash 合格即可下载；不加内容/XML/修订一致性门；不虚称专业审核完成 | Agent独立 / E+R |
| BB-016 P1 G1/G2/G3/G4/G5 | M3项目/原件→明确提交→CLI/进度→报告Word→下载与终态账务；仅文字/Markdown或报告DOCX，无findings JSON；预览失败 | 一次CLI可完成报告交付，准确来源/input/run，下载hash与存储一致；按实际review flag/锁定计费模式记录终态，不假写已开启收费；无JSON重问、不虚构覆盖统计/问题；E受控文件交付，R代表真实CLI与专业复核旅程；预览失败仍可授权下载 | Agent预检＋Human验收 / E+R |
| BB-017 P0 G3/G4/G5 | 旧试用/按量/结构化/失败任务迁移、刷新、重放 | 原输入/锁价/协议/失败证据不改；不追补/自动重跑/改失败为成功；旧报告可读 | Agent独立 / E+R |
| BB-018 P0 G1/G2/G3/G4/G5 | 从准确M3报告/材料成果提更新，绑定来源/消息并重复；在目标入口明确确认→M1双Word交付；回看旧报告 | 正确owner/message/version/hash；准备/绑定免费且零执行；保留原募集书来源/要求/禁止项；明确确认才执行；新修订/清洁版属新run，旧M3报告仍可下载，不把报告误作清洁底稿；复用BB-013/016正向成果及BB-067专业结论，不为绑定例单独再生成 | Agent独立 / E+R |

### 4.3 材料表单、来源、要求与范围

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-019 P1 G1/G2/G4 | 打开材料页，切四文种/市场/上传或关联来源；与全站助手跨页对照 | 原独立材料表单，无常驻右侧聊天；适用字段/模板结构/生成按钮准确；切换不执行；助手独立悬浮生命周期 | Agent独立 / E+R |
| BB-020 P1 G1/G2/G4 | 原项目已有资料，助手引用/计算后准备另一文种（U1） | 复用明确采用的授权材料；不重复索要已选来源；不静默带入他项目/其他私有模板；原始版本准确 | Agent独立 / E+R |
| BB-021 P1 G1/G2/G4/G5 | 直接表单要求0/12000/12001字符、禁止项；助手卡补缺项（U2） | ≤12000准确保存并进输入；>12000报错不执行；表单要求不伪造聊天消息；助手补项到正确可编辑卡，均不自启 | Agent独立 / E+R |
| BB-022 P1 G1/G2/G4/G5 | M4运行中保存后继材料/要求；切文种/重开草稿（U3） | 当前 run pin/hash 不变；下一草稿保留不串文种；旧快照不覆盖新草稿；不错误套用 M1 材料锁 | Agent独立 / E+R |
| BB-023 P1 G1/G2/G4 | 留 v1 引用，选择 v2 M4 全文续改再提交（U4） | 实际全文底稿 v2/version/hash；原募集书来源独立；v1 引用不替换底稿；旧成果不改；保留限制 | Agent预检＋Human验收 / E+R |
| BB-024 P1 G1/G2/G4/G5 | 引用 v3 段落并要求 M4“只压缩这段”；底稿/引用冲突（U5） | 引用准确，冲突可见；未开放 M4 局部执行不能暗换全文 run/预留；不把此禁区套到已开放 M1 内容续改 | Agent独立 / E+R |
| BB-025 P0 G2/G3/G4/G5 | 材料表单单击/双击“生成”；助手发“生成但不要签署页”；问“如何/先别/不要复核”（U6） | 表单一次点击 save→内部 quote→execute，无第二确认；助手只建议/准备卡，确认才执行；禁止项保留；咨询/补缺零文书执行 | Agent独立 / E+R |
| BB-026 P0 G2/G3/G4/G5 | 相同字段重复保存；报价 pending 期间真实改要求/市场；complete/execute 响应丢失 | 无意义保存不增 revision；真实改动终止旧提交；quote 未完成不执行；丢 execute 响应沿原 key 回读，不换 key 重下单 | Agent独立 / E+R |
| BB-027 P1 G1/G2/G4/G5 | 四文种×市场模板/知识；私有 v1/v2、重复hash、错文种/市场/owner、无模板 | 立项需本账号券商模板；其他三种可系统知识；精确版本/完整知识 MD/hash 固定；客户端无覆盖权；重复不加价；模板缺/错明确报错 | Agent预检＋Human验收 / E+R |
| BB-028 P1 G1/G2/G4/G5 | 两来源候选；阅读旧稿；材料表单替换source成功/失败；助手上传普通附件 | 阅读/普通附件不替换执行源；表单purpose=source新上传成功直接采用新原件，失败保留原来源；歧义先澄清；页面/卡/输入/实际读取同version/hash；摘要有准确来源或续改底稿 | Agent独立 / E+R |

### 4.4 QA、真实文书与专业/客户端验收

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-029 P1 G1/G3 | 概念/帮助/清单/任务澄清/轻起草与专业分析混合多轮 | 每轮重分类，不继承上轮高系数；帮助/必要澄清免费；专业分析不伪装免费；未发布QA价不写60已生效 | Agent预检＋Human验收 / E+R |
| BB-030 P1 G1/G5 | 资产5000万/负债3000万，宿主 receipt 与模型错数字 | Decimal结果60%；公式/期间/单位/口径/精确来源齐；模型不能覆盖有效宿主结果 | Agent独立 / E+R |
| BB-031 P1 G1/G4/G5 | 两期50%→60%比较，移除receipt或提供冲突口径 | Q04优先；+10个百分点、相对+20%准确；无receipt不造数字/改善结论；冲突不可比明确 | Agent独立 / E+R |
| BB-032 P1 G1/G4/G5 | 缺值/零分母/混币种/元万元/母公司合并/错期间/OCR疑数 | 具体缺口明确，不猜0；换算有依据；不可比不强算；风险结论可追材料 | Agent预检＋Human验收 / E+R |
| BB-033 P1 G1/G2/G3/G4/G5 | QA来源引用、流式中断、恢复/重复导出既有回答 | 精确可访问版本；中断状态真实；完成文本原样恢复；再导出零新模型/预留/扣费，不冒充DOCX artifact | Agent独立 / E+R |
| BB-034 P1 G1/G2/G4/G5 | 四开放文种正例；推荐函/公募/DFI/多机构/组合/M4局部/实时法规负例 | 核查/法律不能误拒为M5；范围外说明并保留意图资料，零替代run/费用；不编检索/现行法律认证 | Agent独立 / E+R |
| BB-035 P1 G1/G3/G4 | 沪/深×四文种8组合，授权材料/立项模板，真实CLI全链路 | 8组合逐项真实正文+说明交付；knowledge/Skill/template/input hash、call/usage、artifact hash与账务齐全；合成不能代替；每份Human签认另记 | Agent预检＋Human验收 / R |
| BB-036 P1 G1/G4 | 业务审核立项、核查、法律正文及说明 | 适用结构/表格与来源完整；无虚构核查/函证/内核/签署/审批；法律依据效力和缺口如实待核；核查IRM未读不声称模板逐字匹配 | 必须Human / R |
| BB-037 P1 G1/G4 | 摘要逐项对照募集书/条款/财务/负面事项 | 企业/关键数值/条款/投资者限制准确；重大负面不无依据删；说明定位来源/模板/未核项 | 必须Human / R |
| BB-038 P1 G1/G2/G3/G4 | 代表文种v1→全文v2→v3；每文种新稿/续改至少覆盖，变更文种重点复验 | 精确底稿；正文/说明同run稿次；旧字节/hash不变；新要求/原限制保留；每个明确全文新版本按4500独立锁价 | Agent预检＋Human验收 / R |
| BB-039 P1 G1/G2 | Windows Word/WPS打开真实M1双稿、M3报告、四文种正文/说明；编辑/保存重开 | 无修复警告/乱码/缺表；分页/目录可用；正文可编辑；M1修订批注实际记录；两客户端分开结果，ZIP解析不代替 | 必须Human / R |

### 4.5 成果、恢复、并发与安全

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-040 P1 G2/G4/G5 | 读旧稿时新任务完成；当前制作转成果；关tab | 保留旧阅读位置；当前制作原位转准确成果；不重复tab；关闭视图不取消任务；正文/说明配同run | Agent独立 / E+R |
| BB-041 P1 G1/G2/G4/G5 | 预览失败/空提取/重载；分别下载正文/说明/旧结果 | 原文件/版本真实；失败仍可授权下载；零再生成；字节/hash一致；不拿旧说明配新正文 | Agent独立 / E+R+O |
| BB-042 P1 G2/G4/G5 | 8话题/8成果/46消息、多资料/草稿/引用/未发送文本；刷新重登（U7） | 服务端历史分页完整、账号隔离；同会话恢复，明确新会话不带旧输入；恢复零新执行/费用；材料/助手surface分离 | Agent独立 / E+R |
| BB-043 P1 G2/G4/G5 | save丢响应/乐观冲突/恢复错误/超限/分页失败 | 当前文字/原记录保留，失败明确可重试；不静默清空/截未解决要求；同key不重复消息/卡 | Agent独立 / E+R |
| BB-044 P0 G3/G4/G5 | execute丢响应、双击、两标签同key | 一个run/输入快照/预留/outbox；均指向同run；无重复模型调用；钱包数量准确 | Agent独立 / E+R |
| BB-045 P0 G2/G3/G4/G5 | 同来源跨话题/项目并发更新/复核/材料；伪装QA；完成后观察 | server canonical非QA互斥；换源拆组/伪taskkind拒绝；草稿保留；不自动排队或完成自启；真实QA可按政策并行 | Agent独立 / E+R |
| BB-046 P1 G2/G5 | 重复/乱序/终态后旧running事件、真实五阶段、原始日志 | 一份任务状态，终态不倒退；只展示实际白名单阶段；无编造百分比/ETA/工具；不泄露prompt/路径/凭据/推理 | Agent独立 / E+R |
| BB-047 P0 G3/G4/G5 | 调用后、Blob写后、成果登记/结算中崩溃恢复；Blob上传/回读失败或错hash、DB事务失败、重复outbox/租约接手 | durable结果/journal复用，完成调用不重调；缺文件/坏hash不登记可交付或结算，失败不能假成功；恢复后文件/版本/账本仅一次，无半笔资金/任务记录；租约过期旧worker不能覆盖新终态；固定价双交付可settle，QA/legacy按量unknown见BB055 | Agent独立 / E+R |
| BB-048 P1 G2/G3/G4/G5 | 续租中cancel、cancel与成功/交付/结算竞争、重复cancel；关闭浏览器、CLI超时/未知调用 | cancel与成功只能产生一个合法终态：成功先提交后cancel不能再按取消退款；有效cancel先提交则迟到成功不能交付/结算。只finalize一次：固定价成功一次settle或有效取消全release；按量成功可同一终态settle实际费用＋release剩余cap，各一次；关浏览器不cancel；用量真实保留，未知调用不盲重发；暂停恢复见BB-079 | Agent独立 / E+R |
| BB-049 P0 G4/G5 | 隔离环境清理源项目；running/paused跨项目source/support/template/QA pin；终态清理 | 非终态精确字节保留；错owner/project/version不误pin；终态按生命周期清理；旧非M4兼容 | Agent独立 / E+R |
| BB-050 P0 G5 | 真实Linux镜像输入写入/逃逸/symlink/hardlink/未采用文件/提示注入访问凭据 | 原件/knowledge只读；scratch/output授权可写；越界/危险链接拒绝；模型建议/Skill不扩权；无越权或网络外传 | Agent独立 / E+R |
| BB-051 P1 G2/G4 | 320/390/1360/1920px、键盘连续上传/助手/长历史/结果 | 无横溢/遮输入；键盘焦点可达；poll不拆控件；回看不抢滚动；关键交互Human连续旅程可理解 | Agent预检＋Human验收 / E+R |

### 4.6 价格、钱包与发布

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-052 P0 G3/G4/G5 | QA成本率未配置；固定文书4500有效；另测文书queueEnabled=false | 付费QA BILLING_NOT_READY且零该付费run/reserve/call；免费帮助可用；固定文书不被QA成本缺失阻断；队列未启用按现行协议创建paused/capability_not_ready并保留4500预留，无文书供应商调用；不发明独立M4收费flag | Agent独立 / E+R |
| BB-053 P0 G2/G3/G4/G5 | 固定文书余额4499/4500、过期quote/配置变更/输入变更；充值返回 | 4499不足零run/call/reserve；4500足额只预留4500；过期/变更旧quote拒绝；草稿保留；补余额/返回不自动execute | Agent独立 / E+R |
| BB-054 P0 G3/G4/G5 | 四文种/全文新版本成功，成本低/高；不同request key/不同来源独立项目竞争同一钱包（4500与9000）；交付任一Word缺失 | 同key重放另见BB044；4500仅一个可预留，拒绝方key零新增run/job/execution/input revision/hold/call，总增1run/4500；9000两笔各4500，不跨钱包/超支。固定价锁定，双文件存储/hash回读/登记后只扣4500；缺任一不结算，失败/有效取消全释放，不按usage浮价；已seed run的单纯reserve测试不能替代API零run断言 | Agent独立 / E+R |
| BB-055 P0 G3/G4/G5 | 固定文书usage unknown双Word交付；QA/旧按量unknown；后来补usage | 固定文书可成功settle4500且unknown审计不伪0；QA/旧按量待核不猜账；补usage不新调用/重复扣；旧run模式保留 | Agent独立 / E+R |
| BB-056 P0 G3/G4/G5 | M1八档、M3实际flag、M4固定/QA按量成功/失败/cancel；赠送/补偿/purchase分配与hold跨expiry；QA低于/等于/超过cap及cached/多attempt用量 | 对应文件/价格模式锁定，ledger/lot准确且仅一次；赠送/补偿先于purchase、赠送最早expiry先用、purchase按created_at/id；expired未hold不算可用，hold不消失；平台失败按协议仅为过期held赠送追加一次7天补偿，原expiry不改；user-cancel不延长过期赠送。QA按锁定费率/系数向上取整并封顶cap，低cap差额释放一次、超cap不加扣、confirmed_not_sent不计费；必要usage缺失待核。旧试用/订单/按量不追补；详细分支见4.9 | Agent独立 / E+R |
| BB-057 P0 G2/G3/G4/G5 | 支付沙箱伪签名/金额/merchant/currency/订单/txn；重复乱序callback；到账事务失败后refresh query补账、callback-query并发；跨owner query、旧cny50/新销售关闭 | 非法/跨owner拒绝且零grant；paid状态和purchase lot/grant同事务，故障无半账，补账/并发仅一次到账；paid不因迟到failed/expired倒退；原订单金额保留，新cny50拒绝；新销售关闭不阻旧合法paid订单处理；生产未接通如实，返回业务不自启；仅隔离沙箱 | Agent独立 / E+R |
| BB-058 P1 G3/G4 | 上传/保存/绑定/准备卡/下载/再次导出/恢复/必要澄清 | 无业务预留/结算；如存在平台调用如实另记payer，不声称0调用；无上一轮费用/系数继承 | Agent独立 / E+R |
| BB-059 P1 G1/G2/G5 | 正式timeout代表真实文书/受控并发，复用真实验收任务；不调模型的草稿/读取延时测量 | 正常/超时/并发各有准确终态/usage，无OOM/永久卡租约；超时失败原样保留，不拿45分钟预算推定成功。延时记录环境/样本量/负载/分位数：10次仅探索，2s/3s尚未批准，不能作发布fail门；正式SLO批准后冻结负载与充分样本再纳门 | Agent独立 / E+R |
| BB-060 P0 G4/G5 | 每候选迁移/旧新active任务兼容校验；首次、迁移/worker协议/拓扑/回退方案改变时在staging完整回退演练；部署后只读 | SHA/digest/flags/ledger/备份与兼容证据齐；触发完整演练时切兼容镜像，不回撤已部署迁移/全库覆盖；旧worker不误认新协议，无重复run/账务。纯UI改动可引用未变更且已演练的回退方案/hash，须登记触发判断；当前0100迁移候选触发演练 | Agent独立 / E+R+O |

### 4.7 调查时新增功能的永久回归

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-061 P0 G1/G4/G5 | 0100后assistant/materials surface、同owner不同project、跨owner读会话/卡 | DTO/存储surface准确；材料话题不冒充助手；归属核对；跨owner404/拒绝无内容；模型不能决定owner/price/baseline/request key | Agent独立 / E+R |
| BB-062 P1 G2/G4/G5 | 未发送文字/引用/附件/卡；收起、宽屏、跨三业务页面、reload | 同助手会话/草稿/卡恢复，不被页面新建重置；不抢表单/阅读；零执行；宽屏/窄屏键盘可用 | Agent独立 / E+R |
| BB-063 P0 G2/G4/G5 | 近期会话、新会话、明确切project、退出再登另一账号；旧请求迟到 | recent历史准确；新会话/显式项目切换不串旧材料；退出清前端；服务端历史按owner恢复；旧迟到请求不覆盖新账号；零执行 | Agent独立 / E+R |
| BB-064 P0 G2/G3/G4/G5 | 普通聊天、“请开始”、模型建议及prepare更新/复核/文书卡 | 非QA文书run/execute intent=0，prepare卡无预留；有可编辑核对卡；聊天CLI/QA run按免费或付费QA政策单列，付费须另确认；模型建议不能自动执行文书 | Agent独立 / E+R |
| BB-065 P0 G2/G3/G4/G5 | 卡准备后改目标/材料/要求/价格状态；旧卡再confirm；prepare响应丢失 | 修改使旧确认失效；重新prepare/展示新输入价；过期/旧hash拒绝零执行；不会只改页面仍提交旧快照 | Agent独立 / E+R |
| BB-066 P0 G2/G3/G4/G5 | 分别确认三类业务卡、同key双击/两标签/丢响应；跨owner卡、余额不足 | 仅明确确认才调用原入口；每key1run/1reserve；绑定精确业务/输入；越权拒绝，4500文书不足402且无调用；不通过聊天自动批准 | Agent独立 / E+R |
| BB-067 P0 G1/G2/G3/G4/G5 | 选明确旧M1清洁版续改，仅内容变化无新增年度；换错hash/插旧引用 | 实际底稿exact artifact/version/hash，原市场/品种/期间/限制保留；分类interim=17900不误new_authoring=159900；旧成果保留；错hash拒绝 | Agent预检＋Human验收 / E+R |
| BB-068 P0 G2/G3/G4/G5 | 助手专业QA首次发送/再次确认；免费帮助；改问题/cap；未配置QA | 首次显示服务端actual cap无付费QA run/reserve；明确第二次确认才执行；改变输入/价重核；免费帮助直接可发；未配置拒绝且不采用模型报价 | Agent独立 / E+R |
| BB-069 P1 G1/G2/G4 | >一页跨三业务项目、归档项目、多个run、test_completed | 全metadata分页完成再计数；每未归档项目按current/latest run一次；归档不计；内部测试稿不算正式完成；不按run累加 | Agent独立 / E+R |
| BB-070 P1 G2/G4/G5 | 首次第二页失败、刷新失败、旧成功+新failed、30秒刷新/离开logout | 首读“—”无0/部分总数；刷新失败保上次快照并提示；新失败属待处理；仅可见页面刷新，离开/退出停止；旧响应不污染 | Agent独立 / E+R |
| BB-071 P1 G1/G2/G4 | 三业务不同状态从工作台进度/结果，切筛选后refresh/返回/编辑 | 链接指准确run/成果与合适tab；dashboard origin/type/status保留；不误开旧success/新空草稿；三业务逐项验 | Agent独立 / E+R |
| BB-072 P0 G2/G4/G5 | M1 running/paused/awaiting_input/终态未续改；晚到picker/drop/delete/source edit；显式继续修改 | 上传/删除隐藏或禁用、源字段只读；所有迟到事件零写请求；列表可刷新；终态明确继续修改仅解锁下一轮，不改旧snapshot；M4行为见BB022 | Agent独立 / E+R |
| BB-073 P0 G2/G3/G4/G5 | 未过期钱包available=100000,reserved=0→4500预留→成功/失败/cancel；获取失败/账号切换；与ledger核对 | sidebar/手机主额=available+reserved，预留时仍100000；细项95500+4500；成功总95500，未过期failed/cancel恢复100000；0预留隐藏；错误显示未同步不假0。过期赠送分支按BB056，不要求user-cancel凭空恢复expired可用额 | Agent独立 / E+R |
| BB-074 P0 G2/G3/G4/G5 | 八档编制分类/配置；annual包含最新interim、重复期间、source已覆盖期间、0新增年、>3年、迁移1年、参考企业/缺源metadata；0余额、涨价、激活、旧trial | 全八档如1.3；期间去重且只计同目标企业source尚未覆盖annual，参考企业不减目标期间；纯内容0新增年=interim17900，>3年按现行分类封顶，迁移1年仍migration；缺源信息INPUT_REQUIRED不默认159900；配置恰好8档正有界整数。零余额UI阻断+API402/零run，改价重确认；激活不改wallet/追补，其他flag不误开 | Agent独立 / E+R |
| BB-075 P1 G1/G2/G4/G5 | 长用户名/侧栏退出，新账号简化，settings弹窗/深链/Escape，320–1920 | 用户名只读/电话脱敏；无username-edit；设置子区正确、Escape关且焦点返回；充值桌面4列手机2列；无横溢/退出遮挡；账号异步隔离 | Agent独立 / E+R |
| BB-076 P1 G4 | 用候选Docker构建前端，核对新增CSS依赖/上下文/白名单/最终镜像与部署资源 | 所有引用样式存在且编译进production包；运行资源hash对应manifest/镜像；无开发服务通过但正式构建缺CSS/页面失样式 | Agent独立 / E+R+O |

### 4.8 本轮审查补齐的业务闭环

| ID / P / Goal | Test case：准备与操作 | Pass criteria | 执行 / 层 |
|---|---|---|---|
| BB-077 P0 G1/G2/G5 | 隔离账号修改密码/单个与全部其他session撤销；注销预览后新queued任务、错误确认、有效注销与两标签；找回未配置/已配置条件 | 错密码/短密码/不一致/429不改凭证或误退出；正确改密保当前会话、撤其他会话、旧密码失败；撤销仅本人且重复幂等，另owner不受影响；active任务包括预览后新任务阻止注销且零变更；有效确认注销后全会话/标签清理，云资料/成果访问撤回、旧登录拒绝，保留必要账务/审计，purge scheduled不宣称已远程删本地导出。找回按4.9既有协议，不假写线上已开 | Agent独立 / E+R |
| BB-078 P1 G1/G2/G5 | 三业务创建/编辑合法项目；列表按名称/发行人搜索、kind/status/archive筛选/分页；归档/恢复；资料删除、active任务阻止项目删除及有效重复删除 | 创建/编辑后重开值准确且无业务执行/费用；列表完整、owner隔离、返回保筛选；归档可恢复且不误cancel/重跑，dashboard计数复用BB069；active时delete拒绝且资料仍可读；终态合法删除后访问/下载权限撤回与清理计划准确，重复删除幂等，另owner不变；不杜撰未实现的回收站/恢复已删除项目 | Agent独立 / E+R |
| BB-079 P0 G2/G3/G5 | paused/awaiting_input按真实reason展示；paused允许resume/自动恢复；trial guard、pending provider reconciliation、未解决旧source、重复暂停/终态/非paused resume、重复点击及丢响应 | API仅paused可resume；awaiting_input/其他非paused拒绝INPUT_REVISION_CONFLICT，terminal拒绝ALREADY_TERMINAL；pending reconciliation和未解锁旧source拒绝CAPABILITY_NOT_READY，trial_limit重新验额度；允许恢复仅requeue同run/input/hash/原资金策略，无新预留/重复已完成调用；未解除或反复暂停不自动循环重排，普通paused的显式resume按4.9，不一概拒绝；旧poll不覆盖新状态；需新材料走明确新版本，不原地改旧M1 snapshot，不把服务故障说成文件损坏 | Agent独立 / E+R |

### 4.9 必须逐分支记录的高风险补充

| Case | Subcase / 精确oracle | 源码与可复用测试依据 |
|---|---|---|
| BB-077 找回 | disabled：无support配置或无有效精确account_recovery operator，UI/API如实未开放。enabled：仅事先verified原渠道与有效operator可发单次reset；过期/重发旧token/错purpose/越权/超预算拒绝且不锁正常登录；成功全旧session失效而项目/run保留；reset事务/outbox失败全部回滚；并发旧密码登录不留下旧有效session。token不进持久前端存储/请求日志/审计 | [account-recovery.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/account-recovery.ts)、[account tests](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/account.test.ts)、[recovery tests](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/account-recovery.test.ts)；operator是隔离fixture，不向真人发消息 |
| BB-056 按量QA | 锁定config下低于/等于/超过cap；多实际attempt、cached token费率；confirmed_not_sent；cached字段缺且影响费率；重复settle/补usage。按真实cost与系数向上取整、上限cap，差额仅释放一次；unknown不猜0、不以4,500固定文书代替QA策略；parse不收费 | [m4-billing.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/m4-billing.ts)、[m4-workspace.pg.test.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/m4-workspace.pg.test.ts)；边界补例仍需实现，不声称文件已有全部分支 |
| BB-056 赠送过期 | 成功按locked allocation扣；平台failed与user-cancel各验跨expiry；仅平台失败按协议补偿过期held赠送、7天/一次，原expiry保留；user-cancel不延长赠送。对账available/reserved/consumed/compensated，不套用BB073未过期100000 fixture | [billing.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/billing.ts)、[billing.pg.test.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/billing.pg.test.ts)、[0099](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/db/migrations/0099_m4_fixed_document_credits.sql) |
| BB-057 补账 | callback到账写失败→主动query；callback-query竞争；query的order/merchant/currency/amount/txn冲突与owner；停止新充值后旧合法到账。每原订单一个purchase lot/grant，状态/到账同事务，原金额不改，paid终态不回退 | [payments.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/payments.ts)、[payments.pg.test.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/payments.pg.test.ts)；生产支付未接通不阻无关文书发布，隔离协议回归仍保留 |
| BB-007 容量 | 字节/文件数刚好上限/超过、最后槽并发；满额仅同owner/project/role/media/size/hash且未删除原件复用。容量算术可用synthetic metadata，不冒充500MiB运输实测。unified_v1零parse；legacy仍保留辅助parse兼容，不能因旧test断言parse=5就删test或套到新原件政策 | [upload-reuse.test.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/upload-reuse.test.ts)、[新原件测试](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/original-material-upload.test.ts)、[legacy容量测试](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/upload-capacity.test.ts)、[原件决定](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/docs/product-decisions/2026-10-07-pdf-original-upload.md) |
| BB-078/079 生命周期 | 项目归档/恢复/删除与run恢复分别验证，不能用dashboard计数或running页面代替动作事务；resume的reason分支按当前queue实现，legacy输入保留 | [project-list.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/project-list.ts)、[data-policy.spec.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/web/tests/data-policy.spec.ts)、[queue.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/queue.ts)、[project-execution.spec.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/web/tests/project-execution.spec.ts) |
| BB-079 reason差异 | pending provider reconciliation禁止公共resume；trial_limit重验额度/禁用/kill switch；未解决发行人源必须新input。legacy material_parse_pending仅材料不再pending后自动同run重排；context_too_large不自动恢复，显式resume可能接受但不承诺成功；其他capability_not_ready可允许重排，不能强制所有阻碍均同步拒绝。settlement_pending不接受公共resume | [queue.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/api/src/queue.ts)、[runtime.ts](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/apps/worker/src/runtime.ts)；API/worker/UI结果分别记录 |

这些是明确业务风险的边界，不扩到未开放功能。existing suite候选不是全部断言已经自动化的保证，执行前需要精确case name与oracle对应。

生成内容使用结构化关键事实/范围/来源/条款/禁止项 oracle，不要求模型逐字一致。关键断言必须全部通过；平均主观分不能掩盖资金、身份、数值或程序事实错误。

### 4.10 从工程机制到真实用户行为

每个开放模块先执行[正常旅程UX-N01–06](user-scenarios.md#正常场景)，复用成果与账务再选择异常及中断子例。准备/上传、提交响应、服务端运行、系统paused、取消竞争和下载的中断预期分别记录，不能笼统写“断网后继续”。

Human先只收到业务任务和资料，自主尝试；主持人记录动作、困惑、辅助和新需求，再用步骤脚本复现。Agent可通过浏览器模拟用户路径，并核对run/input/ledger；这不替代Human体验、真实Word/WPS或真实设备关机。UX-A03“暂停补料原任务继续”需求已确认，源码调查显示功能与费用设计缺口，实际尝试时须暴露它们，不能由现有材料锁/取消新建测试通过抵消。

场景ID与BB/U关联是追踪关系，不代表原79组已有全部业务断言。每步写用户目标、预期/实际反馈、输入版本、run、费用和证据，分别报告测试执行完成、用户目标是否达成、缺口及U影响。

## 5. Daily bug bash schedule / tasks

以下是执行安排设计，时间为 Asia/Shanghai；尚未创建定时任务、派发团队消息或运行每日付费任务。角色由团队认领：QA主持；Agent执行工程；前端负责UI；API/平台负责账務与部署；worker/算法负责生成恢复；业务审核负责内容；客户端审核负责Word/WPS。

每日Human窗口从[用户任务卡](user-scenarios.md)选择一个业务目标，先观察无引导完成情况，再围绕实际发现的漏料、费用疑问或恢复困难跟随探索；不只核对预设按钮。Agent同日复现并核对任务/账务。日报除G1–G5外增加功能缺失、设计缺口、绕路/辅助与owner；23场景按scope/diff轮转，不每日全跑或重复真实生成。

### 5.0 从现在到用户测试：准入优先

准备齐全后的排程目标是**1–2个工作日内完成U并开始邀请试用**，实际以真任务、环境、资料与缺陷结果为准，不承诺当前已具备条件。

| 顺序 / 计划窗口 | 任务 | 完成就进入下一步，不等待什么 |
|---|---|---|
| T0前2小时 | 冻结实际试用URL/版本/功能/市场与资料；核flags/余额/日志；Agent先启动各开放模块真实旅程，同时跑隔离工程检查 | 不等待未部署助手或未接通充值；未覆盖功能不交用户试用 |
| T0当天主体窗口 | 并行跑6.0的7个检查包，复用真实成果/账务；修复阻碍后定向复验 | 不等全历史PR对账/全量CI接入；真实生成按实际timeout/预算继续，未完成不记pass |
| 真实成果可用后30–60分钟有效操作 | 一位业务用户跑代表旅程；业务人员快速抽查关键事实；一个主要Word/WPS客户端打开代表成果 | 不等完整专业签认、另一客户端全矩阵或全部8组合 |
| U全部必跑子例通过当天 | 开始小批受邀用户测试，交清晰任务与反馈入口；Agent记录run/账务/错误并处理阻碍 | 不等待五日bug bash轮转结束；无需为了凑完整报告延迟首批用户 |
| 用户测试期间 | 按5.1日程triage→修复→定向复验；夜间扩回归、历史清单与R验收并行 | 新发现P0或试用核心P1立即暂停受影响入口，修复复验后恢复 |

资料/环境/权限/预算不足或真实任务失败时，记录阻碍、owner、下一动作；可独立通过U的模块先进入限定试用，涉及共享权限/资金/任务基础设施的P0不能靠拆scope绕过。

### 5.1 每个工作日固定节奏

| 时间 | Task | Owner角色 | 当日交付 |
|---|---|---|---|
| 09:30–09:45 | 读最新master/develop与线上版本差异，核对flags/价格/迁移，收昨夜CI/缺陷 | QA+发布+Agent | 当日版本manifest、变更影响、环境/预算/待部署清单 |
| 09:45–10:15 | 快速smoke与受影响历史P0；完整历史P0安排夜间/RC，生产只读 | Agent+API/worker | 快速报告/受影响长套件job链接；环境失败与产品失败分开，未结束不记pass |
| 10:15–11:00 | 一位业务用户跑当日主题连续旅程；Agent提供来源/版本/费用证据；专业/客户端疑点交对应审核人 | 业务用户+Agent，按需专业/客户端 | 最短复现、trace/截图、文件hash；机械检查不固定双人重复，真实长任务另窗继续 |
| 11:00–11:20 | Triage去重/P级/影响范围/owner/永久reproducer | QA+模块owner | P0立即处理；P1当日明确修复/阻碍；P2/P3排期 |
| 14:00–15:00 | 修复与补永久回归，保留旧fail/候选pass；并审查相邻风险 | 模块owner+Agent | fix commit/PR、test ID、可靠fixture/oracle |
| 16:00–16:45 | 定向复验+相邻功能+smoke；内容/客户端问题由对应Human复验 | Agent+Human | verified/reopened、本轮真实版本/原始报告 |
| 17:00–17:20 | 按G1–G5汇总发布门/日报；候选是否晋升，待迁移/部署/验收分开 | QA+发布+业务/运营 | 五项目标分别报告pass/fail/blocked/not_run、证据与P0/P1、明日任务、发布声明范围 |
| 夜间/候选更新后 | 隔离环境完整历史回归、PG/Azurite/Linux/production build/关键浏览器 | Agent+CI | 原始报告、skip/todo统计；真实模型按预算/影响触发，不每次PR全跑 |

快速工程 smoke：版本/健康BB-001/002；身份拒绝BB-004；原件完整回执BB-010；确认前零执行/单击与同key重放BB-025/044/064/066；不足余额/未配置拒绝BB-052/053；当前run快照与材料锁BB-022/072；恢复导航与余额BB-041/070/073。按3.6执行包各选一条代表子例，不将整组异常矩阵标为已跑。其余BB-008/014/017/019/024/026/034/045/049/058/061及新增BB-077–079按diff追加定向子例；全历史P0夜间及RC完整执行，资金/权限/执行/恢复变更对应P0合入前先跑。

生产只读smoke：BB-001/002/005/041/076的观察子例、既有授权成果状态与钱包可读；资源/下载hash按3.6触发。它不等于当天新生成E2E；不在生产制造跨账号泄漏、重放扣费、删资料或崩溃。

### 5.2 首轮五工作日主题（与用户测试并行，不是准入等待期）

D1为团队实际启动日，D2–D5按工作日顺延；填入真实日期与执行人，不预填通过结果。

| 相对工作日 | 重点Goal | Agent任务 | Human任务 | Exit criteria |
|---|---|---|---|---|
| D1 | G1业务完成、G2流程 | 最新源码/线上差异、原件与材料表单；BB001–012/019–022/025–028/076 | 连续准备四文种；检查原件回执与一键入口理解 | 本日版本审计明确；计划/环境准备完成，记录实际开始日期 |
| D2 | G1业务完成、G2流程、G3积分 | 全站助手确认卡/付费QA/clean续改/材料锁与暂停恢复；BB061–068/072/074/079，BB023–034 | 跨页未发送文字/编辑卡/旧成果内容续改；QA概念与口径审阅，Agent复算 | 三业务确认前零执行，正确底稿/17900分类，输入/QA费用准确；恢复原run不新扣 |
| D3 | G1业务完成、G2流程 | 8组合真实生成、代表v1→v3与M1/M3正向闭环；BB013/016/018/035–041/059；分批09:30–17:00，复用成果 | 四文种与M1/M3专业审阅、Word/WPS；深交所/立项模板授权确认 | 8组合及M1/M3真实闭环证据齐；缺资料/预算/交付记blocked；长任务另窗验收 |
| D4 | G3积分、G5可靠性 | fault/互斥/retention/固定4500/八档/钱包/支付沙箱；BB043–050/052–058/073–074 | 取消/失败/待核余额理解与账单；验证充值禁用不误导 | 重复执行/超支/重复扣费/泄漏0；unknown区分计费；P0/P1已处置 |
| D5 | G4回归；复核全部五项目标 | fix对账/完整回归、dashboard/account/项目生命周期、迁移/镜像/触发回退；BB060/069–071/075–078 | 三业务完整客户旅程、结果导航/设置、签对应验收层；删除/注销机械分支仅Agent隔离测试 | unmapped fix=0；五项目标状态与证据齐；工程/专业/部署门分别签认 |

后续每周循环五主题并按diff优先：助手/UI→确认卡/草稿/dashboard；API/账务→全部资金P0/旧任务；worker/Skill/knowledge/template→受影响真实组合与专业/Word；迁移→旧数据/0100/active run/回退。真实8组合在首次统一验收、相关RC及模型/Skill/模板/生成/恢复变更时执行；常规日只读旧成果或预算内代表任务，不能把每日bug bash变成无预算批量生成。

### 5.3 缺陷记录与关闭

Bug记录包含：Issue/BUG ID、severity、发现SHA与环境、fixture/hash、最短步骤、expected/actual、影响、run/input/request/call/ledger、安全trace/截图、owner、fix SHA、永久test ID、复验版本/报告、Human复验（需要时）。

工程fix关闭：可信旧版失败证据→候选定向通过→相关历史回归→registry追加证据；危险旧问题不需在生产再造。内容/客户端问题保留相应Human复验。按仓库约定，工程切片的Issue关闭可以依据工程测试与主链通过；真实模型/专业/Word/WPS分别跟踪最终统一验收，不能假写已签认。

## 6. Release baseline 与永久防回归

交付件：[回归登记](regression-registry.json)、[发布基线模板](release-baseline-template.json)。本轮登记是已知修复与新增行为的起始清单；不是仓库全历史修复已完整审计，也不是已通过receipt。

### 6.0 U门：受控邀请用户测试的最小准入

先冻结**实际运行的试用版本与范围**，不默认邀请所有79组功能。可优先准备M1、M3、四文种材料和可用免费帮助；按实际核验的部署/开关决定是否纳入助手、新账号布局、付费QA和充值。2026-10-08未部署/未启用的历史状态不能替代执行时核验。若选择旧已部署版本，证据必须对应该运行版源码/配置，不能引用新master测试冒充旧线上通过。后台运行版本仍需可追溯核对；本轮并未完成该核对或实际准入测试。

| U检查包 / 执行者 | 必跑子例（复用原ID，不要求整组全部分支） | 准入pass criteria |
|---|---|---|
| U-A 版本与入口 / Agent | BB001/002/005/076：试用URL、运行Web/API/worker、相关迁移/flags/价格、health/ready/heartbeat、入口/CSS | 版本/配置可追溯，实际入口可用；未开放项反馈准确。仅核本试用版本相关迁移，不为尚未上线助手强制先做0100 |
| U-B 各开放模块真实闭环 / Agent | BB003/006/013/016/029/033/035/078：登录/原件/项目共用旅程；M1一条真实双Word、M3一条真实报告；四文种开放时各一个授权市场真实正文+说明；可见QA入口一条免费帮助/恢复/导出 | 每个开放模块从有效资料到真实结果/下载/账务成功。四文种是4个代表组合，不以一份摘要代表全部，也不要求先完成沪深8组合；M1新编/更新若采用不同生产路径则各补一个代表。真文件供其他包复用 |
| U-C 权限与输入安全 / Agent | BB003/004/028/050/072：两个授权隔离账号，跨owner读/下载/写/execute拒绝；退出/过期清理；来源version/hash；M1材料锁；当前worker原件/knowledge只读与越界拒绝 | 零泄漏/越权/旧账号污染；读取准确原件，锁定snapshot不改；worker现成定向隔离测试通过，不先全跑提示注入/危险链接组合 |
| U-D 明确执行与幂等 / Agent | BB014/025/026/044：M1展示报价/明确确认、变更旧quote拒绝；材料一点击；double click/丢execute响应沿同key回读 | 确认规则准确；每key一个run/hold，不重复已完成call，重读不重下单。助手若进入scope，再补BB061/063–066/068的归属/项目隔离、卡前零文书执行、stale卡、确认/QA cap，不把未部署助手当必跑 |
| U-E 实际计费 / Agent | BB052–056/073/074：当前启用模式；M4 4499/4500、不同key争钱包、双文件后一次4500、缺文件不结算、fixed unknown审计、failed/cancel释放；M1实际tier与八档分类工程例；余额主额 | 价格/预留/消费准确，不超支或重复扣；固定价和按量各按协议。M3按实际flag；未配置QA/充值只验拒绝/返回不自启。当前改动涉及按量/过期lot/支付协议时追加对应高风险分支，不能遗漏直接受影响项 |
| U-F 关键恢复 / Agent | BB010/041/044/047/048/079：lost complete核对；运行中reload/重登→同run，成果仍可下载；已完成call的checkpoint恢复、cancel-success竞争工程例；可面向用户的paused原因与resume | 不丢输入/成果、不重复call/账务，终态不倒退；恢复路径明确。按量成功settle＋差额release合法，各一次；未知调用不盲重发。故障注入在隔离环境，不先在真实模型上逐故障全跑 |
| U-G 受影响修复 / Agent | registry内本范围与当前diff相关的已知P0/P1；包括资金/权限/误执行/底稿/恢复及BB017/026/070/072/073/074/076适用断言 | 选定永久断言100%通过，有当前运行版报告、fix映射和未覆盖项理由；不能把已知共享P0移出scope过门。全历史inventory与unmapped=0在完整发布baseline跟踪，不阻已满足本门的试用 |

7包按机制选必要子例，多个包共用同一次真实run/文件，不能把覆盖ID数量当独立执行次数。全部适用必跑子例须pass、无blocked/not_run/skip；已知共享P0或试用核心P1未修复则不能进入U。仅其他独立功能未完成时，明确限制范围后先试用已通过模块。

**U必须Human快速预检（不是完整R签认）：**

- BB051-U：一位业务用户完成至少一条代表旅程，能理解准备、费用/确认、进度、结果、下载与回看；无死路或持续协助才能操作的阻碍。
- BB013/016/036/037-U：对本轮开放的代表输出快速抽查发行人/市场/期间、关键数值/条款、限制/待核项及明显虚构程序事实；Agent提供来源定位。已发现关键事实错误不能进入U。专业深审在用户测试及R阶段继续。
- BB039-U：在邀请用户主要使用的一个真实Word或WPS客户端打开代表M1双稿、M3报告及M4成果，确认可读/可编辑、无修复警告或空白成果；另一客户端及完整修订/目录/分页矩阵留R。现成同hash结果可复用。

以上目标为30–60分钟有效操作，生成等待另算；若发现阻碍需修复后复验，不能以时间到代替pass。U子例结果单独登记，不把BB036/037/039/051整组R结果改成pass。用户测试重点由Human真实任务与反馈驱动，Agent负责观察、复算、恢复、复现与回归。

**U不用等待的后续工作：**全历史fix清单完备、全部79组/全异常矩阵、真实沪深8组合、两客户端完整矩阵、全专业签认、所有CI接入与未启用支付上线。它们继续保留在E/R/专项任务；一旦发现涉及试用范围的P0/P1，仍会阻断U或暂停相应试用。

### 6.1 完整发布候选冻结一份不可变manifest

1. 候选repo/branch/full SHA/tree、Web/API/每类worker image digest、bundle/CSS hash、环境/URL/实际观察时间；源码/部署回执/运行观测分别存。
2. migration ledger逐项到0100：0098文种/knowledge、0099固定文书价、0100助手；flags、CLI/model/provider/Skill/knowledge/template版本与hash；不存凭据。
3. 每task计费模式/price version/8档价/cap/锁价，充值/review/QA实际开关；旧按量/旧trial快照单列。
4. synthetic/授权真实fixture manifest、hash、事实与财务oracle、旧协议/旧订单快照；原件不可覆盖。
5. 完整fix来源清单、fix→case→suite/case name/人工脚本映射，CI/PG/browser/Linux/真实call/账本/专业WordWPS报告；各层pass/fail/blocked/skip/not_run分开。
6. 批准范围/声明、P0/P1、P2例外owner与期限、备份/旧镜像/active run兼容回退演练、批准人/时间。

本计划源码参考需要0100；2026-10-08历史线上回执仅到0099。执行时重新核对实际ledger。升级前后不能将两套ledger混填。旧计划的“收费M4待启用/仅0097”已过时，不能继续用作本次发布门。

### 6.2 全部bug fix的永久登记规则

- 首次建立baseline完成全历史merged fix PR、bug issues、直接fix commits/reverts对账；之后每RC只审计上次批准SHA→候选SHA增量及revert，校验全registry持续完整，不重复阅读全部历史PR。每fix至少一个永久case，**unmapped_fix_count必须为0**。首次全历史未完成仍保持`inventory_complete=false`，不能用39条声称全覆盖。
- 登记bug ID/full fix SHA、复现步骤/fixture hash、精确case name或Human脚本、旧fail/候选pass证据、最近通过版本、owner；每RC重新执行全部适用永久工程断言，不继承旧工程pass。Human未变更文件/知识的审批仅按3.6的hash与依赖规则引用；受影响项必须复验。
- U1–U7保留资料/要求/底稿/范围/执行/历史可靠性目标；按最新表单和确认卡修改oracle。原始“常驻聊天/自然话语直接执行”不继续强制；旧决策存为legacy版本，不能抹去兼容测试。
- 明确产品决定改变行为时版本化oracle：原字节上传替代深检；核查/法律开放；固定文书4500替代新文书按量；旧run仍验原协议。不因失败删测试、降断言、扩大skip或自动更新golden。
- PR门：build/contracts+受影响模块+对应历史fix/相邻负例。Release门：全部适用历史fix、旧M1/M3/account/账务、Linux、production build、关键浏览器、版本/迁移。
- 任何新增fix先补最小稳定reproducer；资金/权限/意外执行/恢复类bug追加并发/丢响应负例。专业bug由Human定位oracle，Agent只能自动核对可确定的部分。

### 6.3 发布通过标准

每个候选按第2章G1–G5分别登记目标状态和证据。所选门的适用关键断言通过才能晋升；不能用模块跑通抵消积分错误或掩盖回归/bad case失败。U/E/R分别登记；U通过即可开始其限定用户测试，R尚待验时不声明全部业务验收完成。

| 门 | Pass criteria | 结论与限制 |
|---|---|---|
| U 用户测试准入（本轮优先） | 6.0七包适用必要子例＋Human短预检全部通过；实际试用版本/功能/资料明确；已知共享P0和试用核心P1清零；反馈/run/账务/错误可追踪 | 即可启动限定小批受邀用户测试；不等待完整E/R，但不能声明全部发布/专业验收完成 |
| E 工程候选 | build/contracts；全部适用历史回归/PG/Azurite/Linux/Python/unit/关键Playwright/真实API联调100% pass；必跑0fail/blocked/skip/todo、P0/P1清零；迁移/旧数据/active run兼容；BB060触发时完整回退（当前0100触发）；production镜像完整 | 可声明指定工程范围通过；延时未确认阈值仅测量；不等于专业或全部真实模型完成 |
| R 最终统一验收 | 引用同候选E报告，不重跑全部真实模型故障矩阵；首次授权8组合正文/说明、代表M1/M3和受影响续改；固定/已启用按量实际账务、关键事实/专业/Word/WPS通过；正式模型/Skill/沙箱/预算可核对。后续RC依据批准baseline与diff补受影响真实证据 | 可声明适用开放范围完成统一验收；未启用支付/QA验禁用负例及E沙箱协议，不要求不存在的线上交易；未变更且hash/依赖适用的Human证据可引用并登记 |
| O 实际部署/观察 | 实际Web/API/worker SHA/digest与批准manifest对应；migration/flags/价格/health/heartbeat；public hash；三业务入口/已有成果/余额只读smoke；即时、30分钟、次工作日观察 | 可声明指定版本实际部署并健康；仅GitHub合并/首页200/旧截图不够 |

必跑skip不能借缺PG/Linux/browser跳过；范围外N/A需有明确理由及禁止执行负例。P2仅按owner/影响/期限接受；关键事实/资金/权限问题不能降为P2豁免。本计划设计更完整的release验收，尚未修改CI或批准发布。

基线JSON的`required_test_ids_by_gate`是各门的**逻辑覆盖池**，选定scope/subcase后才生成本候选`required_test_ids`。R覆盖池包含E的前提；`additional_execution_test_ids_by_gate.real_acceptance`单列真实/Human增量，`reused_engineering_test_ids`引用同候选E证据。每个结果写明实际执行或证据引用、subcase、SHA/config/fixture/run/file hash；不能把整个case的多分支因一条代表pass而全部通过。纯UI PR跑定向套件，RC跑全部适用永久工程回归，真实生成与完整回退依触发矩阵安排。

U池38个ID只表示七包与短Human预检用到这些case的必要子例；不是38组全分支执行要求。U的必跑清单以`user_testing_admission.packages.required_subcases`、实际scope/diff追加项与`human_preflight`为准；各自保留结果。U通过时79组整体、E/R/Human完整版仍可not_run，不能为了报告整组pass再重复全部矩阵。

### 6.4 最新CI覆盖与四项实施任务

| 现状 | Release需要补齐 | 对应case |
|---|---|---|
| M4 core 对develop/master有API/worker/Python/Web unit；已加knowledge/fixed-billing/project-assistant PG；dashboard unit已在glob | 接关键Playwright与真实API导航联调；fixture通过不等于后端/模型通过 | BB019/025/061–075及既有上传/结果/恢复 |
| M2 fixed credits 仍只对develop；含原件/spool，但M4的billing子集不足 | master候选补整套M2支付/原件/worker/reconciliation gate | BB006/007/010/017/053–058/074 |
| M2原件/spool部分PG/Azurite测试可条件skip；workflow无M4式0skip/todo检查 | 有效专用PG/Azurite环境+0skip/todo计数门；保留raw TAP/退出码 | BB006/010/056/057 |
| M4全量migrate，ledger显式regex仅匹配*_m4_*，不显式列0100 | manifest/迁移门单独核对0100助手表、旧会话/卡兼容；不是误称0100完全无CI | BB001/017/061/060 |

### 6.5 可复用命令（本轮未执行）

在冻结候选源码根目录，依workflow准备专用PG/Azurite、Python依赖和迁移。先build再用dist测试；保留原始报告与skip/todo统计。

~~~bash
npm ci
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web

node --test --test-concurrency=1 \
  apps/api/dist/m4-knowledge.test.js \
  apps/api/dist/m4-workspace.pg.test.js \
  apps/api/dist/m4-fixed-billing.pg.test.js \
  apps/api/dist/authoring-task-kind.pg.test.js \
  apps/api/dist/project-assistant.pg.test.js \
  apps/api/dist/billing.pg.test.js \
  apps/api/dist/review-billing.pg.test.js

node --test --test-concurrency=1 \
  apps/worker/dist/m4-runtime-skills.test.js \
  apps/worker/dist/m4-stages.test.js \
  apps/worker/dist/m4-pipeline.pg.test.js \
  apps/worker/dist/model-generation-router.test.js

python -B -m unittest discover -s python/tests -p 'test_m4_*.py' -v

node --test --test-concurrency=1 \
  packages/contracts/dist/source-prospectus.test.js \
  packages/contracts/dist/signature-assessment.test.js \
  apps/api/dist/billing-classification.test.js \
  apps/api/dist/billing.pg.test.js \
  apps/api/dist/review-billing.pg.test.js \
  apps/api/dist/payments.pg.test.js \
  apps/api/dist/upload-safety.test.js \
  apps/api/dist/original-material-upload.test.js \
  apps/api/dist/upload-spool.test.js \
  apps/worker/dist/m2-paid-worker.test.js \
  apps/worker/dist/provider-reconciliation.test.js \
  apps/api/dist/generated-word-delivery.test.js

npm test -w @bondbuddy/web -- \
  project-assistant.spec.ts dashboard-status.spec.ts \
  m4-workspace.spec.ts account.spec.ts data-policy.spec.ts \
  upload.spec.ts project-execution.spec.ts \
  project-conversation.spec.ts review-workspace.spec.ts \
  prototype-workflow.spec.ts artifact-page.spec.ts --workers=1
~~~

以上复用现有测试，仍需补本计划中尚未自动化的oracle/故障分支/真实API联调；不能仅执行这些文件就推定79个逻辑用例全通过。新增BB077–079复用account/account-recovery/project-list/queue/data-policy，并补缺少的断言；legacy parse测试保留自己的版本范围。部署门读取受控运行元数据，不从公共包倒推后台版本。

来源：[M4 CI](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/.github/workflows/m4-core-pr.yml)、[M2 CI](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/.github/workflows/m2-credits-pr.yml)、[M3 Linux](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/.github/workflows/m3-linux-pr.yml)、[M3 CLI](https://github.com/ITSophiaXu/BondBuddy/blob/a6fa7eb030f7f9bc4c803176b2aacf38d35642b6/.github/workflows/m3-cli-review-pr.yml)。

### 6.6 发布后观察与回退

发布后立即、30分钟、次工作日追加同manifest证据：版本/health/ready/worker、public资源、旧任务恢复、未知usage与reserved账目、既有授权成果/余额只读。观察/刷新不能新建收费任务。

发生P0、重复执行/扣费、错误底稿导致关键结论、历史丢失或核心P1时，按验证过的方案暂停新执行入口并切回兼容镜像；保留active/待核任务处理和审计。迁移只新增，不回撤0098–0100，不用全库恢复覆盖后来数据；新助手/固定价协议不能让不兼容旧worker接手。回退策略按BB060触发在staging演练、版本化写入manifest；后续无相关变更可引用该策略/hash并登记兼容判断。

## 7. 下一批可执行任务：先准入，再继续完整验收

| 顺序 | Task | 完成标准 |
|---|---|---|
| 1 | 冻结实际运行试用版本/范围、授权资料、可用积分/真实模型预算与反馈方式 | Web/API/worker/相关ledger/flags可核对；尚未部署助手不假写已可用，不阻已有模块准备 |
| 2 | 并行运行U七包，真实任务先启动；修复阻碍并定向复验 | 各开放模块真实闭环、关键安全/积分/恢复/受影响修复证据齐；不等待全历史对账 |
| 3 | Human短预检并登记U决策；U通过当天开始小批受邀用户测试 | 代表流程/关键事实/主客户端可试用；任务、反馈、缺陷owner可追；本轮尚未邀请或执行 |
| 4 | 用户测试期间补全CI、全历史fix对账/永久case映射与夜间回归；新助手/0100另按上线流程推进 | 完整发布baseline仍要求inventory_complete、unmapped=0与全部适用回归；新功能单独满足准入后再加入试用 |
| 5 | 补另一市场授权资料、完整8组合/专业/WordWPS，签E/R/O完整证据 | 完整发布/专业/部署结论分别记录，不能用U通过替代 |

本轮审查保留原76个ID与修复断言，新增3个必要业务闭环，共79个逻辑用例；其余缺口补进已有case，重复执行改为6个共享包。历史测试、真实probe及部署评论仅为参考；旧300秒真实文书超时不改写成成功。当前公共健康/页面观察仅证明读取时状态；源码审查和文档校验不代表产品用例通过。

## 8. 本轮review结论与剩余实施缺口

| Review发现 | 已修正 | 如何避免再增加无效工作 |
|---|---|---|
| 同一次提交/账本/文件被多个ID重复执行 | 3.6六个共享包；独立断言与subcase结果保留 | 同run/hash证据复用，不反复真实生成或重复专业审阅 |
| 正向闭环与生命周期缺失或只写得很概括 | 新BB077账号、BB078项目、BB079恢复；扩BB003注册、BB013/016/018完整业务旅程 | 沿真实已实现入口，三组新增均Agent独立，无新增Human机械门 |
| 钱包/支付/容量/故障标准过宽，易漏高风险分支 | BB007/047/048/054/056/057/074与4.9明确临界、竞争、过期、补账和cap | 测独立机制，避免文种×故障×价格全组合；legacy与新协议各保留正确oracle |
| 每日/发布要求过重或阈值未批准 | 精简smoke/单人业务体验；R复用E、回退按变更触发、延时先测量 | 首次统一真实验收、当前0100演练和全部适用永久工程回归继续保留 |

本次review依据已核实的候选源码、产品决定与现有测试，已处理上述确定缺口；它不证明全部测试已实现或全部历史bug已映射。release前仍需完成：全历史fix对账、精确subcase→自动suite/人工脚本映射、79组中适用断言的实际运行和Human签认。回归清单仍39条、inventory_complete=false，全部产品结果not_run。审查过程记录未随仓库交付；团队以当前可复核执行证据为准。

v6按用户本轮目标新增U门和1–2工作日准入优先排程；79组及65/3/11责任分配保留。当前仅修订计划，U七包和Human预检尚未执行，因此只能说计划支持快速准入，不能说现在已经可邀请用户。
