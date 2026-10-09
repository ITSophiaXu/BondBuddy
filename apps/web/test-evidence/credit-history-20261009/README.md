# #630 账号积分消耗与充值记录

原型 product-prototype/public/account-credits.html 和实现均为本 PR source commit。Windows / Node 22.14 / Edge；截图及 API 数据均为 synthetic，不代表真实支付或真实用户账本。

- `npm run build`、`npm run check:contracts`：通过（171 合成契约样例）。
- `node --test apps/api/dist/credit-history.test.js`：1/1。覆盖返回白名单、账本金额、微秒游标、分页上限、非法及跨账号/类别游标。初测发现 query limit 必须为字符串，修正契约后通过。
- apps/web：`BB_E2E_BASE_URL=http://127.0.0.1:5639 BB_E2E_BROWSER_CHANNEL=msedge BB_HISTORY_EVIDENCE_DIR=test-evidence/credit-history-20261009 npx playwright test tests/account.spec.ts`：12/12。含消耗/预留/释放、支付四状态、分页、刷新保留已展开页及任务详情、读取失败与空状态、重试、刷新到账和余额、退出清理、原账号设置/余额回归。
- 既有 billing.pg.test.ts / payments.pg.test.ts 增加真实 PostgreSQL 读回：实际测试任务的冻结/成功结算/失败释放/冲正、分页无重复、归属与游标隔离、重复支付回调后的两笔订单积分与余额 72,500 对账、人工发分不列作支付订单。由 PR Linux CI 运行；本地 Docker 未启动，未把跳过当作通过。

图片 implementation/prototype × consumption/recharge × 1440/390，尺寸为 1440×960 与 390×844。逐图检查了列表文字、金额、状态、任务/订单入口、窄屏换行及无横向溢出。记录区与原型一致；生产既有常驻钱包、最新侧栏导航、移动顶栏和助手未从较早账号原型回退，这些是已批准的既有页壳差异。本次记录布局由用户 #630 要求补齐。

0102 仅新增查询索引。历史接口只读，不启用支付渠道、不发分、不创建任务、不补扣历史费用。最终统一验收待办：生产账号历史账本读回、实际支付商到账及扣费后状态刷新，生产部署/版本/回滚另行记录。
