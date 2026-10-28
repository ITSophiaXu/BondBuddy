# 成果计费界面验证（2026-10-28）

截图采集基线：`c4369b2207f30a41991155c5a64d312db1d3eb7b` 加本次提交中的工作区改动。本证据不代表已发布或真实商户验收。

## 自动验证

- `npm run build -w @bondbuddy/web`：通过；Vite 提示现有主 bundle 大于 500 kB。
- `npm run build -w @bondbuddy/worker`：通过。
- `npm run test:unit -w @bondbuddy/web`：890 通过，0 失败，含历史 v1 续做缓存新增回归。
- 设置 `BB_E2E_BROWSER_CHANNEL=msedge` 后执行 `npm run test -w @bondbuddy/web -- commerce-account.spec.ts commerce-lifecycle.spec.ts commerce-task-scopes.spec.ts`：最终完整复跑 21 通过，0 失败，46.4 秒。
- `git diff --check`：通过；工作区有 Git LF/CRLF 转换提示。

定向浏览器测试覆盖人民币与历史积分分别展示、未定价不能视为免费、ready 零金额与 pending 零占位区分、服务端原价/已购覆盖/应付明细、历史计价版本、拒价/重新报价/退款申请的原请求重试，以及 QA、关联文件检查和同步的范围确认。上述为合成 HTTP 测试，不连接支付商户、真实退款或模型。

## 真实浏览器视觉验收

通过 computer-use 技能和浏览器控制，在 Edge 检查真实生产构建。视口以页面 `innerWidth/innerHeight` 读取确认，分别为 1440×960 与 390×844。截图为视口截图，滚动条属于浏览器画面；没有缩放或拼装截图。临时视口覆盖已重置，研究标签已关闭。

`preview.mjs` 仅在 127.0.0.1:5184 提供静态生产构建与合成 GET 响应；非 GET 请求返回 405，不向真实 API 转发。目录读取真实 contracts 的价格与规则，报价与账户记录均为合成数据。可在仓库根目录运行 `node apps/web/test-evidence/pricing-20261028/preview.mjs` 复查。

检查结果：

- 账户基本信息、可用余额和已预留余额可读；桌面并排、手机纵向排列。
- 原范围已购覆盖明确展示无需新增付费；原价 99 元、覆盖 99 元、应付 0 元完整可见。
- 补差报价展示服务端给出的原价 99 元、覆盖 39 元、应付 60 元；待报价显示“金额待核”，不显示免费执行。
- 已存历史报价仍显示 `outcome-cny-20261028-v1`，没有被当前目录版本覆盖。
- 390px 初验发现目录标题继承 nowrap 导致宽度 473px。已修复标题换行、手机目录单列与长标识断词，复验 `scrollWidth=375 <= innerWidth=390`，无横向溢出。桌面 `scrollWidth=1425 <= innerWidth=1440`。
- 诚信核查目录明确“待定／暂未开放”，没有零元价格或执行入口。

最终浏览器截图：

| 范围 | 桌面 | 手机 |
| --- | --- | --- |
| 实际账户 | [account-actual-1440.jpg](account-actual-1440.jpg) | [account-actual-390.jpg](account-actual-390.jpg) |
| 原范围覆盖明细 | [quotation-covered-actual-1440.jpg](quotation-covered-actual-1440.jpg) | [quotation-covered-actual-390.jpg](quotation-covered-actual-390.jpg) |
| 补差明细与待报价 | [quotation-upgrade-actual-1440.jpg](quotation-upgrade-actual-1440.jpg) | [quotation-upgrade-actual-390.jpg](quotation-upgrade-actual-390.jpg) |
| 长标题与未定价目录 | — | [catalog-actual-390.jpg](catalog-actual-390.jpg) |
| 现有原型账户 | [account-prototype-1440.jpg](account-prototype-1440.jpg) | [account-prototype-390.jpg](account-prototype-390.jpg) |

## 原型对照范围与限制

对照使用仓库现有 `product-prototype/public/account-credits.html?commerce=1`，未修改原型。账户标题、基本信息卡、绿色余额卡与充值说明沿用现有视觉体系。实际页面以已有账户入口承载报价列表，没有为本改动新增导航。

原型包含账户余额、充值和“先确定范围，再确认总价”说明；没有接口驱动的报价列表、零补款明细和补差状态。因此这些新增状态只有实际构建验收，不能声称与原型逐像素一致。实际产品的导航与数据、历史记录本来就比静态原型完整，账户卡宽度也受产品布局约束。

本轮未验证真实模型生成、真实商户支付/退款、自动语义范围识别、专业内容验收或真实运营报价效率。零金额任务的队列、结果复用和账务验证由 API/worker 定向测试单独覆盖；此目录只记录前端与视觉证据。

目录中既有 `.png` 来自先前定向 Playwright 证据；本轮最终人工视觉验收以以上 `.jpg` 为准。
