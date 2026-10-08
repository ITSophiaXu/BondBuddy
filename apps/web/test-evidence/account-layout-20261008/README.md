# 账号页布局重设计

用户在 2026-10-08 明确要求“重新设计布局”，本次据此同步修改前端与[账号原型](../../../../product-prototype/public/account-credits.html)。两者基线均为 develop `ff3f7fcd554a6805f1139fcca4f218a6035951e8`（前次精简 PR #611）；新原型与实现位于同一源码提交，提交号登记在本 PR 和前端 Issue #361。

## 布局与对照

| 区域 | 本次布局 | 决策依据 |
| --- | --- | --- |
| 顶部 | 页面标题与一个账号设置按钮 | 用户要求重新设计，保留此前收起低频操作的要求 |
| 账户概览 | 基本信息与深绿色积分卡并排；手机端上下排列 | 基本信息仍仅账户名、绑定手机号 |
| 充值 | 桌面四列，窄屏两列；金额、积分、按钮对齐 | 缩短页面并明确阅读顺序 |
| 使用说明 | 默认折叠的单行说明入口 | 保留扣费、有效期和退款信息 |
| 账号设置 | 弹窗内使用紧凑的可展开列表 | 登录会话、密码、找回、数据和注销功能保留 |

用户名仍为只读登录名；零预留积分不展示，非零预留仍解释成功扣除及失败/取消返还。未改变支付、账号接口或计费规则。

| 视口 | 前次布局（#611） | 新原型 | 新实现 |
| --- | --- | --- | --- |
| 1360×900 | [旧实现](../../../../docs/acceptance/account-simplify-20261008/implementation-account-1360.png) | [原型](prototype-after-1360.png) | [实现](implementation-account-1360.png) |
| 390×844 | [旧实现](../../../../docs/acceptance/account-simplify-20261008/implementation-account-390.png) | [原型](prototype-after-390.png) | [实现](implementation-account-390.png) |

截图均为上述视口的全页截图。新原型和实现的账号页主内容一致；原型保留既有侧栏，侧栏演示入口、用户区和余额卡与实现的既有差异不在本次范围内。此次布局变化由用户当前要求授权，无新增业务流程。

补充截图：[无预留积分](implementation-account-zero-1360.png)、[手机账号设置](settings-mobile.png)、[长账户名和大额余额](long-values-mobile.png)。

## 验证

环境：Windows、Node 22.14.0、Playwright Chromium。账号 `owner_a`、手机号、积分及 API 响应均为 **synthetic** 测试数据。

- `BB_E2E_BASE_URL=http://127.0.0.1:5188 npm test -w @bondbuddy/web -- account.spec.ts data-policy.spec.ts`：10/10 通过。覆盖基础信息、设置弹窗及焦点返回、密码、会话、注销、积分预留、支付订单返回原项目和旧数据说明链接。
- `npm run build -w @bondbuddy/web` 和 `npm run build`：通过。保留已有的大体积 JavaScript chunk 提示。
- `npm run check:contracts`：167 个公开合成样例、12 个内部样例、4 个数据生命周期样例及 40 项契约测试通过。
- 对实现的静态快照检查 320、390、768、1024、1360、1920 像素视口；页面、字段和数值无横向溢出。长账户名 `account_name_with_32_characters_x` 及 `1,150,000` 积分通过手机端检查。
- 实际打开更新后的原型，在 1360×900 和 390×844 检查布局、说明展开、设置打开、密码展开、Escape 关闭及焦点返回，均通过。

未运行真实 API/数据库账号测试，未修改真实账号或支付数据；未部署。
