# M1 项目工作台（#10 首个集成切片）

沿用 `product-prototype/public/` 的绿色、纸色与侧栏布局，使用 Vite、原生 ES modules 和 TypeScript，逐页接入 M1 `/api/v1`。浏览器只使用现有公共契约，不新增生产 API 或数据库迁移。

已实现：已有用户名密码账号登录/退出、Cookie 会话刷新、本人真实项目分页列表、已加载项目的名称搜索和最近修改排序、新建更新项目、名称/发行人自动保存，以及 409 冲突和网络失败的明确反馈。项目页从公共契约读取固定材料分区；每个文件单独创建上传会话、传输原始字节、等待服务端核验并完成登记。浏览器 XHR 上传事件提供真实字节进度，100% 后保持“正在保存和核验”，直到 API 返回 `MaterialResponse`。每个文件可独立重试或取消；结果不确定时先刷新服务器记录，避免盲目重传。没有写入 localStorage/sessionStorage 的项目、密码、令牌、文件字节或演示成果；其他标签页登录/退出会清除当前页面的个人数据。`#/account` 账号设置页见下文 #9 一节。

## 启动

需要 Node.js **22.12+**（或更新的受支持版本）、PostgreSQL 和已运行迁移的 M1 API。从仓库根目录执行：

```sh
npm ci
npm run build
npm run migrate:api   # 使用独立开发数据库的 DATABASE_URL
npm run start:api
```

API 按 `apps/api/README.md` 配置 `DATABASE_URL`、`BB_ALLOWED_ORIGIN` 与 `BB_TERMS_VERSION`。`BB_ALLOWED_ORIGIN` 必须精确等于浏览器 origin（协议/主机/端口）。这里使用已有账号；注册和找回 UI 不属于该切片。不要使用旧原型的演示账号。

另一个终端启动前端：

```sh
BB_API_PROXY_TARGET=http://127.0.0.1:3000 npm run dev:web
```

Vite 默认仅监听 `127.0.0.1:5173`，代理保留浏览器 Origin。API 的 Cookie 始终为 Secure；推荐本地 HTTPS。可通过 `BB_WEB_TLS_CERT`、`BB_WEB_TLS_KEY` 指向已有本地证书文件，并把 API 的 `BB_ALLOWED_ORIGIN` 设为 `https://127.0.0.1:5173`。不要为调试去掉生产 Cookie 的 Secure 属性。证书和私钥不入库。

生产应由 Nginx 在同一 HTTPS origin 提供 `apps/web/dist/` 与 `/api/v1` 代理。Vite 是开发服务，不直接对外部署；本切片没有变更生产部署。

## 验证

```sh
npm run build
npm run check:contracts
npm run test:web
```

默认运行草稿状态测试，以及拦截 `/api/v1` 的合成浏览器上传与账号设置测试。上传测试验证三个文件中一个失败时另外两个仍保存、100% 后延迟保存状态、单文件重试/取消、合成项目事件恢复和账号隔离；这些测试不访问真实 API，也不构成 live acceptance。真实 API 浏览器测试明确跳过。完整浏览器测试需要**专用合成测试数据库**，会通过真实注册 API 创建随机测试账号和项目。不可指向生产环境。

```sh
npx playwright install chromium
BB_E2E_REAL_API=1 BB_E2E_LIVE=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 npm run test:web
```

`BB_E2E_TERMS_VERSION` 必须匹配端口 3000 专用 API 的 `BB_TERMS_VERSION`。Vite 代理 `/api/v1` 到该 API；project-events 测试使用真实 PostgreSQL、真实登录/上传接口和 Azurite Blob，关闭整个浏览器上下文后重新登录，并检查删除后不会恢复为已保存材料。既有 `BB_E2E_LIVE=1 BB_E2E_BASE_URL=...` 项目与账号测试独立覆盖 Cookie/API 流程。浏览器的本地 TLS 验证不代表生产 TLS 已验收。截图和失败上下文写入系统临时目录，不进入仓库。

## 尚待交付的 #10 范围

- 列表接口当前只返回名称、ID、草稿修订号和更新时间。本切片不把它们伪装成任务状态；搜索/排序仅作用于已加载项目，页面明确显示范围，提供继续加载。
- 全局名称/发行人搜索、类型/状态筛选、最近成果和归档/恢复，需要 Felix 扩展正式查询与变更契约。不能用本地缓存模拟云端归档。
- 表单只保存现有 API 支持的名称和发行人；#11 负责完整业务表单。上传页面使用 `/projects/{id}/events` 的项目游标发现当前材料，再通过 owner-scoped material read 读取明细。服务端只在材料字节校验并持久化后写入终态 `material.upload_progress`；分页最多 100 条，已删除材料不出现在恢复结果中，缺失 Blob 的材料读取返回 404。若恢复失败，页面清除恢复列表而不保留过期的“已保存”状态。默认 browser fixture 拦截 API，是合成 UI 验证；`project-events.integration.spec.ts` 在本地 PostgreSQL/Azurite API 下关闭浏览器上下文并重新登录，验证真实 API/Blob 恢复与删除隐藏。
- 服务端上传会话、原始字节 PUT 和完成登记已有 API 路由。相同内容去重、按内容/签名伪扩展名、加密/超限/缺页的完整用户提示、扫描件 OCR 和材料识别尚未由本 UI 端到端验收；该切片不宣称杀毒或扫描认证，也不启动全文更新。
- 识别、对话和真实执行尚未开放，页面没有可执行的占位按钮。用户端不出现募集书库、相似稿推荐、充值或演示账务。
- 登录页使用已有账号，不提供未经验证的找回流程。会话彻底失效后清除页面内个人数据，只有已保存内容能够恢复。
- #10/#8/#12 保持开放。合成上传 UI 测试不等于真实账号、Blob、保留期限、事件恢复、备份或完整 M1 上线验收。

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
