# M1 更新项目表单（#11）

第一个 Vite + TypeScript 页面，复用 `product-prototype/public/styles.css` 和 `project-workspace.css`。仅访问同源 `/api/v1`，不访问原型 JSON 服务。市场、发行方式、金额单位、资金用途和 DTO 从 `@bondbuddy/contracts` 导入。

## 启动

Node.js 22、npm 10+，仓库根目录：

```sh
npm ci
npm run build
npm run check:contracts
npm run test:web
```

按 `apps/api/README.md` 启动 PostgreSQL 16、设置 `DATABASE_URL` 并运行 `npm run migrate:api`（本次新增 `0009_m1_update_project_details.sql`）。项目表单不调用 Blob。

API 环境：`PORT=3100`、`BB_ALLOWED_ORIGIN=http://127.0.0.1:4321`，然后 `npm run start:api`。另一个终端运行 `npm run dev:web`，访问 `http://127.0.0.1:4321/#update`。默认端口 4321，避免占用原型的 4320；`BB_API_PROXY` 可改 API 的目标地址，代理保留浏览器 Origin。浏览器需支持安全 loopback cookie；非本机联调必须使用 HTTPS，不能移除 Secure/HttpOnly/CSRF 保护。生产部署须把静态 `apps/web/dist` 与 `/api/v1` 放在同一个 HTTPS origin 下。

当前只有已有账号登录入口。测试账号可通过既有 `/api/v1/auth/register` 注册（用户名、12–128 位密码、与服务器 `BB_TERMS_VERSION` 一致的 `accepted_terms_version`）；不要在公共环境预置测试密码。注册界面的交付仍在 #7。

## 已实现和交接

- 有/没有历史稿；默认展开的可选分组；市场与方式联动；DFI 与其他协会方式在同一个下拉中。
- 未定额度为 null，真实 0 保留，最多六位小数、单独单位；不同单位精确比较，真实日历日期校验。
- 债券与承销安排用自由文本；无默认品种一/二，不要求联席主承销商。六类资金用途可逐行添加，提示对应资料。
- 右侧补充说明随草稿保存。它是用户输入字段，不是已确认事实；没有伪造 AI 回复。多轮讨论、提示词执行日志仍交接 #18/#79。
- 真实账号下创建、乐观锁保存、分页打开已有项目和地址刷新恢复。草稿允许信息不全；空名称保存为“未命名更新项目”。保存不创建 run。
- 保存失败保留本页内容；409 展示本页/服务器逐字段对比，用户明确选择后才覆盖或载入，后续再次冲突仍检查 revision。
- 过期登录时草稿仅暂存在内存，同账号重新登录可继续；换账号丢弃旧草稿。无 localStorage 客户材料缓存。未保存离开有提示，显式退出清空本页信息。

项目选择器仅作为 #11 保存/恢复入口，不是 #10 完整项目列表。#12 材料上传、原稿识别、#18 多轮对话、预检、#16 真实模型、#79 上线日志门槛和 Word 交付均不因此完成。不会显示模拟更新进度或“生成成功”。完整 #11 验收仍依赖 #8 持久层联调、页面验收以及公共契约和迁移评审。

## 验证

`npm run test:web` 覆盖 11 种组合、跨市场保留信息、DFI 恢复、空值/精确金额/日期，以及 cookie、CSRF、If-Match、刷新会话和失败不盲目重发。

设置 **专用、可丢弃** PostgreSQL 16 测试库 `BB_TEST_DATABASE_URL`，运行 `npm run test:api`。新增 `update-project.test.ts` 无 Blob 依赖，验证完整字段保存、旧客户端省略字段保留、完整替换清空、真实精度检查、409/422 不写入、owner 隔离、不可变快照/hash/outbox。未设置数据库时数据库用例明确 skip，不能作为通过。

浏览器验收：登录 → 创建交易商协会/DFI 草稿（额度留空，单承销商、多用途、右侧补充）→ 保存 → 刷新/退出重登恢复；切换上交所只清除不适用方式；两页面修改同一项目，后保存者看到差异；窄屏检查表单。所有验收样本须标记合成，不能据此宣称真实募集书更新上线。

### 本次本机验证记录（2026-09-24，未验收）

- Windows / Node 24.19.0：contracts、domain、API、worker、web 和 web 测试 TypeScript 编译通过。部署基线 Node 22 尚待复验。
- 契约：50 个合成样例通过；前端逻辑/API client：7 个测试通过；API：3 个测试通过、7 个数据库/Blob 用例跳过（包括新增 round-trip 用例）。
- 完整 Vite 打包被本机沙箱阻止；升级权限时审批服务返回 `model_not_supported`，未执行。浏览器视觉和完整保存恢复验收尚未进行。
- 独立 PostgreSQL 16.14 已初始化，但创建实际测试数据库及迁移步骤被同一审批故障阻止；没有数据库验收结果。
- 依赖锁文件为新增 Vite 更新。原锁定 `fast-uri@4.2.1`、`@types/node@22.20.4` 在可用镜像不存在，重新解析到原声明范围内的 `4.1.5`、`22.20.3`；没有改变已有包的声明范围。锁文件保留公共 npm 下载地址。应在团队 Node 22/CI 环境复跑 `npm ci` 和完整构建。

恢复权限后先完成 PostgreSQL 16 数据库测试与浏览器验收，再按 AGENTS 的要求提交面向 develop 的 PR，由受影响的 UI/API/契约负责人 review；当前不得关闭 #11。
