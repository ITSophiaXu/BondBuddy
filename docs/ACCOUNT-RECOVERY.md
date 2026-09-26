# #9 人工找回运行说明

产品规则以 [02 第 2.7 节](../product-prototype/product-specs/02-注册登录与账号.md#27-m1-人工找回与身份核验定稿-v1) 为准。用户和客服使用同一个 Web 应用，不接入短信/邮件发送供应商；确认码、重置链接及完成通知由指定客服通过已经核验的联系渠道人工发送。

## 开启条件

1. 部署包含 `0044_m1_account_recovery.sql` 的 API/Web，并应用新增迁移。迁移不授予任何人客服权限，也不补造历史联系记录。
2. 配置真实 `BB_SUPPORT_CONTACT` 和同源 HTTPS 的 `BB_ALLOWED_ORIGIN`。
3. 经既有运维授权流程，为指定客服的真实 `user_id` 配置 `account_recovery` 角色。可复用 `apps/api/src/log-ops.ts` 的 `grantOperator` / `revokeOperator`（写入授权人、原因和时间）；不复用 `log_reader`、`log_operator` 或 `prompt_viewer`。不要开放公网自助赋权接口。
4. 保持既有 `deletion:lifecycle` 定时任务运行；它同时清除过期绑定申请的联系方式/确认码和过期重置授权，180 天后清理工单元数据，1 天后清理限流窗口。账号注销在原事务内立即清除恢复联系方式和未完成授权。

只有客服入口已配置且至少一名有效账号具备该角色时，`GET /api/v1/auth/recovery/info` 才报告 enabled。普通用户的 `self_service_recovery=unavailable` 保持兼容：本能力是人工核验后的恢复，并非无人核验的自助找回。

## 三步操作

- **先绑定。** 用户在“账号设置 → 账号找回”填写邮箱或原客服会话标识，并验证当前密码。把页面中的绑定编号交给客服。客服在同页的“客服找回工具”选择绑定申请、读取编号，并把生成的确认码发到记录里的联系方式；用户在原登录页面填码确认。申请最长 24 小时，确认码最长 30 分钟；更换确认成功前旧绑定继续有效。
- **申请和核验。** 忘记密码的用户从登录页进入“联系客服找回”，填写用户名、取得工单号，再向客服说明问题。已存在/不存在/未绑定账号均返回相同的“已收到申请”形式，重复申请复用未结工单。客服按工单号读取申请时锁定的原联系记录，从原渠道确认本次工单后勾选确认并签发链接。没有事前有效绑定、记录已变更、工单过期或权限不足时拒绝签发。
- **重置和告知。** 客服只把链接发送到显示的原联系方式。用户自行设置新密码；成功后所有旧会话及未使用授权失效，必须重新登录。客服再次读取原工单会看到已重置提示，再通过原渠道通知用户。重发确认码/链接会作废旧值，页面只在当次签发响应显示秘密，不支持找回已显示的明文。

客服不要索取密码、身份证或客户材料，不要在 GitHub 工单中粘贴联系记录、确认码或链接。客服仍须实际完成原渠道核验，不能因为系统能签发链接就跳过人工确认。

## 接口与数据

公共 schema、类型、渠道枚举、期限及事件类型均在 `packages/contracts/src/account-recovery.ts`，并接入生成的 OpenAPI。

| 路由（省略 /api/v1） | 边界 |
|---|---|
| GET /auth/recovery/info | 公开能力和客服信息，无账号信息 |
| POST /auth/recovery/requests | 同源 JSON；用户名只用于受控定位，统一回执和账号/来源限流，不锁正常登录 |
| POST /auth/recovery/reset | 同源 JSON；只认随机单次 token 和新密码，不接受调用者指定 user_id |
| GET /account/recovery | 本人绑定掩码、待确认状态和自身客服权限 |
| POST /account/recovery/bindings | 真实会话、Origin/CSRF、当前密码复验 |
| POST /account/recovery/bindings/{id}/confirm | 本人会话、Origin/CSRF、码/账号/用途/期限/原凭据绑定 |
| GET /admin/account-recovery/bindings/{id}；POST .../code | 专用客服角色；按用户给出的精确编号读取和签发，读取也留审计 |
| GET /admin/account-recovery/tickets/{id}；POST .../issue | 专用角色；原绑定必须早于申请且仍有效，签发必须明确确认原渠道 |

新表仅保存恢复绑定、工单和独立限流计数。随机 token 32 字节，确认码 9 字节，数据库只存 SHA-256 哈希；新密码使用既有 Argon2id 参数。恢复失败计数与登录失败计数隔离；已有密码复验仍复用原账号/来源限流。所有恢复接口 no-store，HTTP 请求地址不携带 token；链接放在 fragment，页面读取后立即移除，不写 Web Storage。

更新凭据、消费 token、撤销会话及 recovery.password_reset outbox 同事务。认证先锁账号再读取最新凭据，避免旧密码登录跨过重置事务；普通改密、注销通过新增触发器作废未完成恢复授权。绑定更换也作废旧渠道的工单/链接。重置不改 user_id、项目、材料、run 或账务。

审计/outbox 只含内部账号、工单/绑定引用、操作者和动作，不包含联系方式、确认码、密码或链接。`code_issued` 只表示系统已生成确认码，不表示客服已发送。

## 验证与限制

`apps/api/src/account-recovery.test.ts` 以真实 PostgreSQL 会话验证：绑定与账号隔离、未知账号统一回执、未绑定不能找回、原渠道确认、过期/重复/改用途拒绝、重发失效、角色撤销、改密/注销联动、独立限流、事务失败完整回滚及重置与旧密码登录的确定性并发竞态。

`apps/web/tests/account-recovery-live.spec.ts` 用用户/客服两个独立浏览器环境走真实 Cookie/API/PostgreSQL 全流程，另一个旧用户会话验证 401；确认码和渠道回复为**合成的人工交接**，不声称验证了真实人的身份或发送了真实邮件。链接只在浏览器 fragment 中传递，测试检查 HTTP URL 和 Web Storage 不含 token，截图检查桌面及窄屏。

```sh
BB_TEST_DATABASE_URL=... node --test apps/api/dist/account-recovery.test.js apps/api/dist/account.test.js
BB_E2E_RECOVERY=1 BB_E2E_LIVE=1 BB_E2E_BASE_URL=https://127.0.0.1:5173 \
  BB_E2E_TERMS_VERSION=synthetic-web-test-v1 BB_TEST_DATABASE_URL=... npm test -w @bondbuddy/web
```

仅指向专用合成数据库；浏览器测试会为其合成客服账号授予测试角色。该测试不授予生产权限。Browser 插件未提供，使用仓库 Playwright。生产启用和实际人工渠道运营随部署配置落实，本提交不把部署或身份核验操作自动化。
