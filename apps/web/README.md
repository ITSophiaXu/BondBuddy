# M1 项目工作台（#10 首个集成切片）

沿用 `product-prototype/public/` 的绿色、纸色与侧栏布局，使用 Vite、原生 ES modules 和 TypeScript，逐页接入 M1 `/api/v1`。浏览器只使用现有公共契约，不新增生产 API 或数据库迁移。

已实现：已有用户名密码账号登录/退出、Cookie 会话刷新、本人真实项目分页列表、已加载项目的名称搜索和最近修改排序、新建更新项目、名称/发行人自动保存、刷新/重新登录恢复，以及 409 冲突和网络失败的明确反馈。没有写入 localStorage/sessionStorage 的项目、密码、令牌或演示成果；其他标签页登录/退出会清除当前页面的个人数据。

## 启动

需要 Node.js **22.12+**（或更新的受支持版本）、PostgreSQL 和已运行迁移的 M1 API。从仓库根目录执行：

```sh
npm ci
npm run build
npm run migrate:api   # 使用独立开发数据库的 DATABASE_URL
npm run start:api
```

API 按 `apps/api/README.md` 配置 `DATABASE_URL`、`BB_ALLOWED_ORIGIN` 与 `BB_TERMS_VERSION`。`BB_ALLOWED_ORIGIN` 必须精确等于浏览器 origin（协议/主机/端口）。这里使用已有账号；注册、找回和账号设置 UI 不属于该切片。不要使用旧原型的演示账号。

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

默认运行独立草稿状态测试，真实 API 测试明确跳过。完整浏览器测试需要**专用合成测试数据库**，会通过真实注册 API 创建随机测试账号和项目。不可指向生产环境。

```sh
npx playwright install chromium
BB_E2E_LIVE=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 npm run test:web
```

`BB_E2E_TERMS_VERSION` 必须匹配专用 API 的 `BB_TERMS_VERSION`。测试使用真实 PostgreSQL、认证、项目和版本 API；仅网络失败案例人为阻断 PATCH。浏览器在本地合成环境接受自签名证书，不代表生产 TLS 已验收。截图和失败上下文写入系统临时目录，不进入仓库。测试覆盖连续编辑的串行保存、冲突不覆盖、失败保留输入、跨账号 404、刷新/重新登录、会话刷新和跨标签退出。

## 尚待交付的 #10 范围

- 列表接口当前只返回名称、ID、草稿修订号和更新时间。本切片不把它们伪装成任务状态；搜索/排序仅作用于已加载项目，页面明确显示范围，提供继续加载。
- 全局名称/发行人搜索、类型/状态筛选、最近成果和归档/恢复，需要 Felix 扩展正式查询与变更契约。不能用本地缓存模拟云端归档。
- 表单只保存现有 API 支持的名称和发行人；#11 负责完整业务表单。完整材料列表及草稿附件恢复仍需接口，不能把重新选择本地文件说成恢复成功。
- 材料、识别、对话和真实执行尚未开放，页面没有可执行的占位按钮。用户端不出现募集书库、相似稿推荐、充值或演示账务。
- 登录页使用已有账号，不提供未经验证的找回流程；#9 负责账号管理。会话彻底失效后清除页面内个人数据，只有已保存内容能够恢复。
- #10 保持开放。前端可联调不等于 #7/#8 已通过生产、保留期限、Blob 或完整 M1 上线验收。

## 复用与交接

视觉来源：`product-prototype/public/styles.css` 与 `favicon.svg`；原型 JSON 存储、演示认证、积分和内存队列均未接入新页面。`src/api.ts` 是页面唯一 HTTP 客户端；DTO 从 `@bondbuddy/contracts` 推导。后续页面复用它，避免复制鉴权和版本逻辑。

草稿 PATCH 带 `If-Match`，自动保存串行提交；新输入不被旧请求响应覆盖。409 不自动重试或合并，不改变任务输入快照。网络错误不盲目重放创建操作；如果创建响应丢失，用户需回到项目列表确认是否已创建，服务端创建幂等契约仍待补齐。
