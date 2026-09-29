# M1 原型工作台与连续项目工作区

#18 / #361 UX-05 的右侧区域现在通过本人项目的 `GET/POST /projects/{id}/messages` 保存和分页恢复用户原话；同一请求 ID 的重试保留未确认的输入，编辑用预期消息版本且历史版本可回查。创建项目前的输入只在本页暂存，创建后需明确发送。旧 `supplementary_notes` 仍保留在草稿/输入中，明确标记为旧版补充，不冒充已发送的消息。启动前重新读取精确消息集合 ref，与全部 `requirement_message_ids` 一起锁定 input revision；运行中修改只影响下一版，旧 run 不变。浏览器合成回归与原型同尺寸桌面/窄屏对照见 [UX-05 记录](ux-evidence/issue-18-conversation/README.md)。API 仍仅 `save_only`，无助手回复、意图执行、流式恢复或用量归因；不能将此切片作为完整 #18/#35 验收。

#370 已按用户确认恢复年份＋季度末，删除目标期间编辑器、额外执行卡片及上传政策长文；开始按钮回到材料步骤页脚，置灰原因来自当前材料/上传/恢复/任务状态。旧期间原样保留，不从截止日自动确认完整期间；生产转换依赖已交接 #76/#17。见 [#370 对照与录屏](ux-evidence/issue-370/README.md)。

#361 已将 `product-prototype/public/` 的工作台、导航、创建→材料两步、四类材料区及持续右侧协作布局迁移到真实 Vite 页面；直接导入原型 CSS。开始更新由一个主操作编排现有保存/预检/执行 API，实际有待确认条件时就地确认；进度和成果在同一项目查看。完整来源对照、必要差异、运行测试及剩余依赖见 [PROTOTYPE-MIGRATION.md](PROTOTYPE-MIGRATION.md)。下方历史章节记录各服务能力，旧“保存版本→检查→开始”三按钮及登录落入项目列表的交互已由本次替换。

沿用 `product-prototype/public/` 的绿色、纸色与侧栏布局，使用 Vite、原生 ES modules 和 TypeScript，逐页接入 M1 `/api/v1`。#11 在已有页面、API client 和保存流程中扩展完整业务表单；对应契约集中在 `packages/contracts`，数据库新增 `0013_m1_update_project_details.sql`。

已实现：已有用户名密码账号登录/退出、Cookie 会话刷新、本人真实项目分页列表、全量名称/发行人搜索、类型/任务状态筛选、最近活动排序及归档/恢复、新建更新项目、完整草稿自动保存，以及 409 冲突和网络失败的明确反馈。项目页从公共契约读取固定材料分区；每个文件单独创建上传会话、传输原始字节、等待服务端核验并完成登记。浏览器 XHR 上传事件提供真实字节进度，100% 后保持“正在保存和核验”，直到 API 返回 `MaterialResponse`。每个文件可独立重试或取消；结果不确定时先刷新服务器记录，避免盲目重传。没有写入 localStorage/sessionStorage 的项目、密码、令牌、文件字节或演示成果；其他标签页登录/退出会清除当前页面的个人数据。

## #11 更新表单

- 历史稿仅回答有/没有，选填分组默认展开。发行市场及发行方式导入共享枚举；DFI 在交易商协会下，不增加独立注册问卷。切换市场清除不适用选项并保留其他输入。
- 单独保存申报/注册总额与本期发行规模（十进制字符串＋元/万元/亿元）；未定值为 null。债券、机构、评级与增信安排允许自由描述，不预建品种一/品种二或要求联席机构。
- 六类资金用途按需增删，分别填写金额、标的及具体安排，并显示适用材料提示。右侧“补充说明与写作要求”随草稿保存；#18 的真实多轮对话仍待接入。
- 前后端共同验证日期、金额精度及发行金额不超过已知注册总额。POST 缺省填 canonical defaults；PATCH 省略 `update_details` 保留原值，提供时完整替换。新 input revision 包含这些用户输入，已锁定快照不变。
- 创建期间禁止重复提交，离开未保存的新建表单会提示。串行保存采用深值比较，忽略数据库 JSONB 对象键顺序但保留资金用途数组顺序；409 不自动重试，保留本页内容供复制，明确放弃后才能加载新版。

`#/account` 账号设置页见下文 #9 一节。

## #12 上传后的解析状态与历史稿信息

项目材料页区分“服务器已确认保存”和后台解析状态。直接读取 #149 的 `parse-job`，展示排队、内容解析、历史稿识别、待确认、等待 OCR、失败与取消，不使用模拟百分比。历史稿结果单独显示原市场、原发行方式、年度/中期报告期、口径与最新截止日，保留原文和不确定性，不覆盖本次目标。

状态与识别结果从服务端恢复；重开项目、刷新和重新登录继续读取同一材料版本。离开项目/退出账号清理轮询及在途请求，隐藏页面暂停轮询，返回时先验证账号。失败后“重新读取状态”仅查询，不自动重传、重解析、校正、生成或收费。材料列表更新保留文件选择控件，避免恢复/上传进度更新吞掉选文件事件。

详见 [MATERIAL-PROCESSING-ACCEPTANCE.md](MATERIAL-PROCESSING-ACCEPTANCE.md)。#153 已补持续 worker、OCR hook 和旧任务回填 CLI；#17/#35 仍需部署验证，#14 需实际 OCR 环境验收，#76 源信息校正和真实材料验收也仍是相关场景的交付条件。

## 启动

需要 Node.js **22.12+**（或更新的受支持版本）、PostgreSQL 和已运行迁移的 M1 API。从仓库根目录执行：

```sh
npm ci
npm run build
npm run migrate:api   # 使用独立开发数据库的 DATABASE_URL
npm run start:api
```

API 按 `apps/api/README.md` 配置 `DATABASE_URL`、`BB_ALLOWED_ORIGIN` 与 `BB_TERMS_VERSION`。`BB_ALLOWED_ORIGIN` 必须精确等于浏览器 origin（协议/主机/端口）。登录页可切换到注册表单：先读取公开的 `GET /api/v1/auth/agreement`（未配置 `BB_TERMS_VERSION` 时返回 503 `CAPABILITY_NOT_READY`，注册保持关闭），提交时带上该协议版本，成功后直接进入工作区。人工找回 UI 见下文 #9。不要使用旧原型的演示账号。

另一个终端启动前端：

```sh
BB_API_PROXY_TARGET=http://127.0.0.1:3000 npm run dev:web
```

Vite 默认仅监听 `127.0.0.1:5173`，代理保留浏览器 Origin。API 的 Cookie 始终为 Secure；推荐本地 HTTPS。可通过 `BB_WEB_TLS_CERT`、`BB_WEB_TLS_KEY` 指向已有本地证书文件，并把 API 的 `BB_ALLOWED_ORIGIN` 设为 `https://127.0.0.1:5173`。不要为调试去掉生产 Cookie 的 Secure 属性。证书和私钥不入库。

生产应由 Nginx 在同一 HTTPS origin 提供 `apps/web/dist/` 与 `/api/v1` 代理。Vite 是开发服务，不直接对外部署；本切片没有变更生产部署。

## 验证

#11 的本机真实 API 验收步骤、结果和限制见 [FORM-ACCEPTANCE.md](FORM-ACCEPTANCE.md)。最终锁文件使用既有声明范围内可获取的 rolldown 1.2.9（及配套 bindings、oxc types）、fast-uri 4.1.5、@types/node 22.20.3；原锁文件相应版本在本机配置的镜像返回缺失。公开 npm 地址保留，未改依赖声明范围；已使用 npm ci 复验。

```sh
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
npm run test:web
```

`test:unit` 使用 Node 测试市场联动、空值/日期/金额、嵌套字段保存、JSONB 键顺序、409 与旧请求隔离。`test:web` 默认运行既有草稿状态测试和拦截 `/api/v1` 的合成浏览器上传与账号设置测试。上传测试验证三个文件中一个失败时另外两个仍保存、100% 后延迟保存状态、单文件重试/取消、合成项目事件恢复和账号隔离；这些测试不访问真实 API，也不构成 live acceptance。真实 API 浏览器测试明确跳过。完整浏览器测试需要**专用合成测试数据库**，会通过真实注册 API 创建随机测试账号和项目。不可指向生产环境。

```sh
npx playwright install chromium
BB_E2E_REAL_API=1 BB_E2E_LIVE=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 npm run test:web
```

`BB_E2E_TERMS_VERSION` 必须匹配端口 3000 专用 API 的 `BB_TERMS_VERSION`。Vite 代理 `/api/v1` 到该 API；project-events 测试使用真实 PostgreSQL、真实登录/上传接口和 Azurite Blob，关闭整个浏览器上下文后重新登录，并检查删除后不会恢复为已保存材料。既有 `BB_E2E_LIVE=1 BB_E2E_BASE_URL=...` 项目与账号测试独立覆盖 Cookie/API 流程。浏览器的本地 TLS 验证不代表生产 TLS 已验收。截图和失败上下文写入系统临时目录，不进入仓库。

## #10 项目管理与相邻功能边界

- `GET /projects` 在本人未删除项目中执行全量名称/发行人字面包含搜索，按类型、实际任务状态和归档状态筛选；`q/kind/status/archive/limit/cursor` 统一定义在 `ProjectListQuery`。默认只显示未归档项目，每页 50、最多 100 条；按最近草稿/当前任务活动及 ID 倒序，用保留数据库微秒精度的不透明游标继续加载。修改筛选会清空游标，刷新保留 URL 中的筛选；中文输入法组合期间不提交半截搜索。
- 无 run 的项目显示草稿；有非终态 run 时优先显示它，否则显示最新 run 状态。最近成功成果独立查询，后续失败不会隐藏旧成功 Word。点击下载再经既有 owner/grant/hash 检查，不发起模型或新任务；列表元数据不冒充文件当前可下载性。
- `POST /projects/{id}/archive` 设置归档状态；重复提交相同状态无新事件。归档/恢复与对应 outbox 同事务提交，不更改草稿修订、输入快照、运行任务、材料、成果或下载授权。新增迁移 `0043_m1_project_archive.sql`；公开 DTO 的新增展示字段为兼容性可选字段，当前服务端始终返回。
- 完整表单由 #11 接入持久化；原稿识别只读展示见上文 #12，源目标难度计算与执行门禁仍待完整联调。上传页面使用 `/projects/{id}/events` 的项目游标发现当前材料，再通过 owner-scoped material read 读取明细。服务端只在材料字节校验并持久化后写入终态 `material.upload_progress`；分页最多 100 条，已删除材料不出现在恢复结果中，缺失 Blob 的材料读取返回 404。若恢复失败，页面清除恢复列表而不保留过期的“已保存”状态。默认 browser fixture 拦截 API，是合成 UI 验证；`project-events.integration.spec.ts` 在本地 PostgreSQL/Azurite API 下关闭浏览器上下文并重新登录，验证真实 API/Blob 恢复与删除隐藏。
- 服务端上传会话、原始字节 PUT 和完成登记已有 API 路由。上传去重与格式边界证据见 `UPLOAD-ACCEPTANCE.md`，原生 DOCX 上传后识别/去重/恢复证据见 `MATERIAL-PROCESSING-ACCEPTANCE.md`。真实缺页/缺附注判断、扫描件 OCR 自动接入、大文件压测及授权材料准确率仍未完整验收；不宣称杀毒或扫描认证，也不启动全文更新。
- 识别结果已接入只读展示；源信息校正、多轮对话和真实执行尚未开放，页面没有可执行的占位按钮。用户端不出现募集书库、相似稿推荐、充值或演示账务。
- 登录页提供登录与注册，不提供未经验证的找回流程。会话彻底失效后清除页面内个人数据，只有已保存内容能够恢复。
- #10 的项目管理可按下述独立验收；#12/#14/#18/#34 的解析质量、多轮对话、真实生成和 Office 兼容性仍属于各自验收，不由项目列表代替。#7/#8 已关闭。

### #10 验证（2026-09-26）

`apps/api/src/project-list.test.ts` 在独立 PostgreSQL 16/Azurite 上覆盖 62 项分页及微秒相同的游标、跨页发行人/字面特殊字符搜索、类型/任务状态、归档账号隔离/幂等/事务回滚、运行中归档不取消，以及新版失败后旧成功 DOCX 的真实下载。合成数据仅在测试库内生成。

`tests/project-management-live.spec.ts` 通过真实 API 创建 52 个合成项目，搜索第一页以外的发行人、筛选/刷新、上传 PDF、归档，再关闭整个浏览器上下文后重登/恢复项目与已保存字段/材料。复用 `live.spec.ts` 验证改名保存、409 保留本地输入、账号隔离与窄屏；`project-events.integration.spec.ts` 验证持久材料重登恢复及删除隐藏。1440×960 和 390×844 已检查，无横向溢出。Browser 插件未提供，使用仓库 Playwright；未部署到生产，不代表全文生成或 Windows Office 验收。

运行方式与上面的 live 环境相同，聚焦命令：

```sh
BB_TEST_DATABASE_URL=... BB_TEST_AZURITE_CONNECTION_STRING=... node --test apps/api/dist/project-list.test.js
BB_E2E_LIVE=1 BB_E2E_REAL_API=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 BB_E2E_TERMS_VERSION=synthetic-web-test-v1 npm test -w @bondbuddy/web
```

`tests/project-execution.integration.spec.ts` 按当前项目流程选财务截止年份/季度末（不会据此确认完整报告期），创建项目并上传合成 PDF；材料页的“开始更新”自动保存草稿、锁定材料版本并预检。预检存在待处理条件时，页面保留一次明确的继续提交确认，然后测试提交并关闭整个浏览器上下文、重新登录以恢复同一 run。测试仅使用隔离 PostgreSQL 16、Azurite、API 的 `createServer({ enableRunStaging: true, enableRunRuntime: false })` seam，以及 `upload-safety.samples.ts` 中的合成 PDF。断言覆盖财务截止日与未确认报告期快照、输入材料版本、数据库中的同一幂等键/run、唯一暂停事件及 `capability_not_ready` 原因；它不启动 worker、模型或 Word 生成，也不构成用户更新任务链路验收。`enableRunStaging` 是测试进程内设置，不是生产环境开关。未启用真实 runtime 的服务端 execute 仍按设计返回 `501 CAPABILITY_NOT_READY`；具备真实 queue/runtime 的测试环境必须隔离并有相应非生产授权，不能复用本测试的 staging 结论。

复用共享 Azurite 时，这个用例会向 `bondbuddy-private` 写入随机账号/项目路径下的合成 PDF；它不会清空容器或删除其他对象。需要完全自动清理时使用下方独立临时栈，且不要对共享 Azurite 执行 `down` 或清空操作。

先在空闲的本机端口启动专用临时栈，并应用当前迁移；不要设置预发/生产连接串：

```sh
docker compose -f deploy/local/compose.yaml -p bondbuddy_issue13_execution up -d --wait
DATABASE_URL=postgresql://bondbuddy_local@127.0.0.1:55433/bondbuddy_local npm run migrate:api
npm run build
```

另一个终端用本地 HTTPS 证书启动 Vite（证书应信任 `127.0.0.1`，不入库）：

```sh
BB_WEB_TLS_CERT=/path/to/local-cert.pem BB_WEB_TLS_KEY=/path/to/local-key.pem npm run dev:web
```

运行专用测试：

```sh
BB_E2E_REAL_API=1 BB_E2E_EXECUTION_STAGING=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
BB_E2E_TERMS_VERSION=synthetic-web-test-v1 \
BB_TEST_DATABASE_URL=postgresql://bondbuddy_local@127.0.0.1:55433/bondbuddy_local \
BB_TEST_AZURITE_CONNECTION_STRING=UseDevelopmentStorage=true \
npm test -w @bondbuddy/web -- tests/project-execution.integration.spec.ts
```

The live test requires the local HTTPS origin `https://127.0.0.1:5173` or an equivalent loopback hostname on port 5173. It rejects remote hosts and alternate ports before registering its synthetic account, so the browser cannot send test credentials to a remote web server.

此用例执行真实 Fastify `/api/v1` 路由、PostgreSQL 写入及 Azurite 材料保存，但故意将 run 留在测试 staging 暂停态。#326 非生产测试通道及 #19 候选运行时现已合入 `develop`；#35 另行记录了预生产授权 run 的浏览器关闭/重登恢复和同 `execution_request_id` 幂等证据。该本地用例不提交测试 grant，也不覆盖这些部署路径、真实模型用量、Word 交付或 #79 日志。#13 仍待预生产 DOCX/XLSX 持久 parse-snapshot 脱敏审计；扫描 OCR 由 #14 验收，含签名 Widget PDF 继续按安全策略拒绝并由独立切片评估。不得把本地 paused run 当作预发/生产 capability、模型用量或 Word 交付证据。

完成后可运行 `docker compose -f deploy/local/compose.yaml -p bondbuddy_issue13_execution down` 停止并移除本测试自己的容器和网络（不要加 `-v`）。该 Compose 文件将 PostgreSQL 与 Azurite 数据目录挂到容器 tmpfs，没有命名卷；容器删除后测试账号、项目、材料字节和 run 记录不保留。

## #9 账号设置页

`#/account`（侧栏“账号设置”）只调用 #100 已实现的 `/api/v1/account*` 路由，不新增契约或迁移。

- 账号信息：用户名、旧手机号掩码、注册时间、密码最近修改时间、已接受与当前协议版本，以及 `BB_SUPPORT_CONTACT` 客服入口（未配置时显示尚未公布）。服务端值一律按文本渲染。页面说明需要事前绑定的人工找回，并显示其当前可用状态。
- 登录会话：只显示服务端返回的本人会话，并标出当前会话。可以撤销单个其他会话或全部其他会话，完成后重新读取列表；当前会话只能通过“退出”结束。
- 修改密码：提交前在本地校验 12–128 字符、无控制字符以及两次输入一致。`403 PASSWORD_INVALID` 只提示当前密码错误，不当作会话过期；429 提示稍后重试；成功后显示服务端实际撤销的其他会话数。网络中断时说明结果未确认。
- 注销：先读取预览，列出将删除或停止访问的数量、依规保留的记录类别、本机导出文件不受影响，以及 M1 不涉及余额退款。有未结束任务时只显示阻断原因和所属项目链接，不显示注销表单。确认需要输入用户名（不区分大小写）、密码并勾选知情确认；提交时遇到 409 会重新读取预览。成功后清除页面内个人数据，通知其他标签页退出，再显示服务端返回的注销结果。网络中断时不宣称已注销。
- 旧手机号账号（`username` 为 null）没有可验证的密码，页面不提供改密或注销表单。

`tests/account.spec.ts` 用拦截 `/api/v1` 的合成 fixture 覆盖以上分支、CSRF 回传、服务端文本的 HTML 转义、窄屏无横向溢出，以及会话失效后回到登录页。`tests/account-live.spec.ts` 属于 `BB_E2E_LIVE` 套件，用真实 API 和 PostgreSQL 验证：被撤销的会话以及改密后的其他会话返回 401，注销后无法登录、用户名不能再次注册，另一账号不受影响。两个 live 套件共用 `tests/live-helpers.ts` 中的注册/登录辅助函数。

人工找回流程已于 2026-09-26 定稿，见 [02 第 2.7 节](../../product-prototype/product-specs/02-注册登录与账号.md#27-m1-人工找回与身份核验定稿-v1)：单客服、事前绑定渠道核验、用户自行通过一次性链接设密。恢复渠道绑定、客服工具、公开申请与重置页已接入；只有客服已配置且存在有效专用角色时显示找回入口。运行、接口与双浏览器验收见 [#9 运行说明](../../docs/ACCOUNT-RECOVERY.md)。注销后的物理清理已由服务端 `deletion:lifecycle` 实现，页面数据期限以当前 `/data-policy` 配置为准。

## 复用与交接

视觉来源：`product-prototype/public/styles.css` 与 `favicon.svg`；原型 JSON 存储、演示认证、积分和内存队列均未接入新页面。`src/api.ts` 是页面唯一 HTTP 客户端；DTO 从 `@bondbuddy/contracts` 推导。后续页面复用它，避免复制鉴权和版本逻辑。

草稿 PATCH 带 `If-Match`，自动保存串行提交；新输入不被旧请求响应覆盖。409 不自动重试或合并，不改变任务输入快照。网络错误不盲目重放创建操作；如果创建响应丢失，用户需回到项目列表确认是否已创建，服务端创建幂等契约仍待补齐。

## #14 OCR 原页核对

材料行可打开识别核对页，查看受权 worker 已生成的结果、原页片段及版本化用户校正。读取、图片与写入均走同源 owner API；没有结果时明确显示不可查看。用户校正不等于审计确认。真实 Tesseract、存储、预算和运行说明见 [OCR 交接](../../python/OCR-HANDOFF.md)。自动预检调度和下游事实消费仍待接入，不在上传后偷偷启动全文 OCR。

核对列表按每组最多 500 条浏览全部已返回记录，并可按原件页码和原始识别文字筛选；重复文字及空白单元格不再被前 500 条截断。翻页/筛选保留右侧未保存输入，切换具体记录仍提示放弃确认。原页读取失败可原地重试，保留输入且图片成功显示前禁止保存；切换记录或离开页面清理旧图片回调。所有操作沿用现有 `OcrReview` / `OcrCorrectionRequest`，不启动新的 OCR，不改变部分覆盖、幂等键、校正版本或 `user_asserted` 状态。

校正保存返回 409 后锁定保存，保留文字、期间、单位、口径及依据；“读取最新校正”展示服务器最新版本的全部校正字段，明确核对后才可手动再次保存。新保存采用最新 `expected_revision` 和新幂等键，响应丢失重试仍沿用相同键。再次冲突须重新核对；材料版本、识别快照/hash 或记录身份改变时不自动迁移旧输入。读取失败可重试，切换记录/离页/会话变化忽略迟到结果；最新用户校正仍不等于审计确认。

独立交互回归：`npm test -w @bondbuddy/web -- ocr-review.spec.ts`，覆盖 600 条重复/空白记录、筛选/翻页、原页失败重试及迟到响应、未保存输入、保存响应丢失后的幂等重试、刷新恢复、409 最新版本对照/显式再提交、重复冲突、读取失败与迟到响应、快照变化拒绝迁移和窄屏。HTTP/PNG 均为 synthetic；真实 Tesseract/PG/Blob 的 `ocr.integration.spec.ts` 仍需按 OCR 交接单独启用，不能用这组测试替代真实数字准确率或完整 #14 验收。

## #34 成果摘要与 Word 下载

项目列表的“查看成果与下载”进入 `#/artifacts/{artifact_id}`，读取现有 `ArtifactResponse`、所属成功 `RunResponse` 和本人项目。页面展示该成果对应的输入版本、本轮替换/表格增列计数及待人工确认清单；修订版、清洁版、有效基线分别下载。历史成果缺少 `word_delivery` 时只提供通用 Word 下载，不猜测文档类型或已核验状态。来源核对保留原文件和有效基线 SHA-256。

每次点击重新获取该文件的短期授权，再通过统一 API client 读取同源、精确成果路径的文件；读取期间禁用重复点击。仅接受完整 HTTP 200 响应，并在浏览器计算收到字节的 SHA-256，与本次授权元数据比对后才交给下载。404、503、206 部分响应、网络中断、响应类型或哈希异常均显示失败并允许重试，不把授权过期当作生成失败。离开页面、重新读取或账号切换取消在途请求，并阻止校验结束后的迟到下载；临时 Blob URL 在使用后或页面销毁时释放，不持久保存下载 grant、文件或个人数据。下载完成文案只表示浏览器已接收文件，不承诺用户已保存到本机。下载不提交 execute/resume 或模型请求。

项目列表的“下载最近成果”复用相同的字节校验、错误提示和临时文件生命周期，核对列表成果 ID/run/版本及 run 的所属项目与成功终态；不再直接跳转短期授权 URL。文件失败时留在列表重试；刷新、筛选、导航或账号切换取消未完成读取，分页重绘期间同一成果仍保持禁用，避免重复下载。下载文件名含成果版本，最新任务失败不会替换原成功成果。

页面 URL 可以重新打开同一成果；新 run 失败时项目列表仍通过既有 `latest_artifact` 指向旧成功成果。项目名称采用当前项目名称，输入版本采用该成果绑定 run 的版本。

同一项目工作区的“历史成果”读取 `GET /api/v1/projects/{project_id}/artifacts?limit=20&cursor=...`，按服务端游标加载全部仍可获取的成功 Word 版本；新任务运行或失败不遮蔽旧成功成果。目录以输入版本、完成时间与任务编号区分每次执行；`primary_artifact.version` 只标为“文件版本”，不伪造项目级连续 vN（当前每次新 run 的文件版本通常均为 1），下载文件名带精确 artifact ID 防止不同运行互相覆盖。三件套分别列出修订版、清洁版和有效基线；旧单件成果只标“Word 成果”，不能推断为新稿或修订版。生产 `succeeded` 与持有有效授权的内部测试 `test_completed` 按公共契约明确标注不同通道，内部测试稿始终标注“未经专业审核·不得对外使用”。列表只提供已检查成果的元数据，每次点击先重读项目所属 run 和该成果，再取得新短期授权、校验文件字节；撤销、删除、哈希损坏、跨项目、会话失效与分页错误显示失败，不触发新的生成。列表刷新和切换项目会终止旧请求；浏览器不缓存 grant。

目录 API 当前只列 `task_kind=update` 的成功 run，所以浏览器只在更新项目显示这份目录；#18/#33 的无历史新编项目继续保留消息、执行与当前成果区，不把更新目录的空结果误说成新编没有成果。无历史新编的完整历史发现属于后续 API/生成范围。

本目录在 [#85 连续项目工作区](../../product-prototype/design-previews/update-workspace.fragment.html)的进度与成果位置增加历史版本卡片；#85 完成态本身只展示当前 vN 成果，**目录是需产品负责人确认的布局补充**，不能以测试通过替代确认。桌面与窄屏同尺寸截图、源 commit 和逐项偏离见 [#34 对照记录](ux-evidence/issue-34-history/README.md)。

验证命令（干净工作区先完成依赖包构建，已有浏览器集成测试依赖 API 的 dist）：

```sh
npm ci --include=dev
npm run build
npm run test:unit -w @bondbuddy/web
npx playwright install --with-deps chromium
npm test -w @bondbuddy/web -- artifact-page.spec.ts
```

`artifact-page.spec.ts` 使用明确的合成 HTTP/文件字节夹具，覆盖三份下载、摘要转义、最新任务失败后旧成果读取、刷新恢复、404/503 重试与新授权、非成功 run 拒绝展示、未列明待确认项、会话失效、跨来源/错误成果链接拒绝、异常内容类型和导航中断；同时检查 1440×960、390×844 布局。`artifact-history.spec.ts` 另外验证同项目多次成功、旧单件、分页、失败/活动任务、无历史/外人项目、403/404/422/503 与身份失效、测试通道隔离、损坏字节及切项目迟到响应，并核对 API client 的游标/limit 查询。这些测试不验证真实模型、数据库/Blob、Word 内容或 WPS 兼容性。#31/#32/#33 完整产出、#35 预发真实链路及 #146 Windows WPS/Word 实机矩阵仍是 #34 开放范围；本 UI PR 不关闭 #34。

列表入口额外覆盖损坏字节/206/503 拒绝及新 grant 重试、run 不匹配或未成功时不读字节、导航/刷新/跨页账号切换取消，以及分页重绘不重复下载。既有 `project-management-live.spec.ts` 的真实 API/PG/Blob 成功成果用例仍须在独立 live 环境运行；合成测试不替代它。
# #12 上传补充验收

上传的条件分区、排队、复用版本与原 session 恢复行为，以及本次取得的真实数据库/浏览器证据，见 [UPLOAD-ACCEPTANCE.md](./UPLOAD-ACCEPTANCE.md)。接口仍复用公共契约；页面不会把文件传完或保存完成当作源信息识别完成。

2026-09-26的[预发真实浏览器验收记录](../../docs/acceptance/issue-11-12-preprod-2026-09-26.md)覆盖市场联动、DFI空额度保存、重登恢复和授权任丘DOCX上传解析。解析流程完成但画像仍needs_confirmation，不能据此关闭#12/#31。Windows下bundle-secrets检查通过当前Node启动本地Vite入口，保留原有全部canary断言，不依赖npx命令封装。

## #18 保存输入与显式任务提交（2026-09-27）

本节记录最初接线能力；#370 已删除额外的材料选择、完整期间、用途/法规日和目标确认 UI。当前主操作直接固定本次安排下的已保存材料，省略可选 target_confirmation，保留服务端 unconfirmed 和真实预检条件；旧不可变输入、期间与任务不改写。单独保存草稿/材料/补充说明不会提交任务。

预检显示 ready / needs_confirmation / blocked 的实际结果及本地化原因；局部待核不变为已验证事实。blocked 时可明确“提交任务并等待条件齐备”，由现有 API/worker 再验证并暂停；这不绕过执行门禁。任务状态及真实事件原因在同页读取，每五秒更新未终态任务；刷新/重登从 owner 项目列表（完整分页）定位任务，再读取 run 与事件游标，保留此前成功成果入口。未成功的 run 不显示成果已生成。

客户端仅复用 InputRevisionCreateRequest/Response、PreflightRequest/Response、ExecuteRequest、RunResponse/EventsResponse。执行键是 project_id/input_revision/input_hash 的 SHA-256 派生稳定键；重复点击、响应丢失重试和重新打开同一输入均重放同一个请求。input_manifest_ref 使用 input_hash、workspace_id 使用 project_id 作为稳定客户端关联值；服务端仍以认证 owner 与数据库 input revision 为权威，不信任客户端清单路径。新内容需要新 input revision；旧 run/hash 不变。已锁定的授信补充沿用精确版本引用并明确标示用户提供，不能静默丢失或提升为已核事实；补充版本编辑仍由后续 #18 切片接入。

输入版本 POST 尚无幂等契约，响应丢失后禁止盲目重发，先刷新并核对服务器版本。刷新读回的旧版本必须明确选用，不能自动把它当作当前草稿；输入、材料或目标控件变化使已有预检失效。离页/账号变化取消请求，迟到响应不回写。

独立验证：`npm test -w @bondbuddy/web -- project-execution.spec.ts`。真实 Chromium 中的 HTTP 均为 synthetic，覆盖固定版本/目标、阻塞原因、响应丢失、重开重放、并发点击、409、迟到预检、账号切换、分页恢复及窄屏。未做真实 API/PG/Blob/供应商或 Word/WPS 验收。本机没有 Docker/PostgreSQL，#35 仍需部署后走真实浏览器链路。#18 持久消息、多轮回复、流式中断及消息 prompt/job 追溯仍是独立缺口；本切片不自动关闭 #18。
