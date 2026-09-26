# M1 项目工作台（#10 / #11 / #12 集成切片）

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

API 按 `apps/api/README.md` 配置 `DATABASE_URL`、`BB_ALLOWED_ORIGIN` 与 `BB_TERMS_VERSION`。`BB_ALLOWED_ORIGIN` 必须精确等于浏览器 origin（协议/主机/端口）。登录页可切换到注册表单：先读取公开的 `GET /api/v1/auth/agreement`（未配置 `BB_TERMS_VERSION` 时返回 503 `CAPABILITY_NOT_READY`，注册保持关闭），提交时带上该协议版本，成功后直接进入工作区。找回 UI 属于 #9。不要使用旧原型的演示账号。

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

## #9 账号设置页

`#/account`（侧栏“账号设置”）只调用 #100 已实现的 `/api/v1/account*` 路由，不新增契约或迁移。

- 账号信息：用户名、旧手机号掩码、注册时间、密码最近修改时间、已接受与当前协议版本，以及 `BB_SUPPORT_CONTACT` 客服入口（未配置时显示尚未公布）。服务端值一律按文本渲染。页面说明目前没有自助找回，也没有客服重置入口。
- 登录会话：只显示服务端返回的本人会话，并标出当前会话。可以撤销单个其他会话或全部其他会话，完成后重新读取列表；当前会话只能通过“退出”结束。
- 修改密码：提交前在本地校验 12–128 字符、无控制字符以及两次输入一致。`403 PASSWORD_INVALID` 只提示当前密码错误，不当作会话过期；429 提示稍后重试；成功后显示服务端实际撤销的其他会话数。网络中断时说明结果未确认。
- 注销：先读取预览，列出将删除或停止访问的数量、依规保留的记录类别、本机导出文件不受影响，以及 M1 不涉及余额退款。有未结束任务时只显示阻断原因和所属项目链接，不显示注销表单。确认需要输入用户名（不区分大小写）、密码并勾选知情确认；提交时遇到 409 会重新读取预览。成功后清除页面内个人数据，通知其他标签页退出，再显示服务端返回的注销结果。网络中断时不宣称已注销。
- 旧手机号账号（`username` 为 null）没有可验证的密码，页面不提供改密或注销表单。

`tests/account.spec.ts` 用拦截 `/api/v1` 的合成 fixture 覆盖以上分支、CSRF 回传、服务端文本的 HTML 转义、窄屏无横向溢出，以及会话失效后回到登录页。`tests/account-live.spec.ts` 属于 `BB_E2E_LIVE` 套件，用真实 API 和 PostgreSQL 验证：被撤销的会话以及改密后的其他会话返回 401，注销后无法登录、用户名不能再次注册，另一账号不受影响。两个 live 套件共用 `tests/live-helpers.ts` 中的注册/登录辅助函数。

仍未关闭：人工找回流程需产品/合规定稿；注销后，被输入快照引用的材料、成果文件字节和 prompt 正文的物理清理属于服务端生命周期；数据保存期限、删除时限与备份清理文案需等 `packages/contracts/WEB-DATA-LIFECYCLE.md` 的发布决定后替换。

## 复用与交接

视觉来源：`product-prototype/public/styles.css` 与 `favicon.svg`；原型 JSON 存储、演示认证、积分和内存队列均未接入新页面。`src/api.ts` 是页面唯一 HTTP 客户端；DTO 从 `@bondbuddy/contracts` 推导。后续页面复用它，避免复制鉴权和版本逻辑。

草稿 PATCH 带 `If-Match`，自动保存串行提交；新输入不被旧请求响应覆盖。409 不自动重试或合并，不改变任务输入快照。网络错误不盲目重放创建操作；如果创建响应丢失，用户需回到项目列表确认是否已创建，服务端创建幂等契约仍待补齐。

## #14 OCR 原页核对

材料行可打开识别核对页，查看受权 worker 已生成的结果、原页片段及版本化用户校正。读取、图片与写入均走同源 owner API；没有结果时明确显示不可查看。用户校正不等于审计确认。真实 Tesseract、存储、预算和运行说明见 [OCR 交接](../../python/OCR-HANDOFF.md)。自动预检调度和下游事实消费仍待接入，不在上传后偷偷启动全文 OCR。
# #12 上传补充验收

上传的条件分区、排队、复用版本与原 session 恢复行为，以及本次取得的真实数据库/浏览器证据，见 [UPLOAD-ACCEPTANCE.md](./UPLOAD-ACCEPTANCE.md)。接口仍复用公共契约；页面不会把文件传完或保存完成当作源信息识别完成。
