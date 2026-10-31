# 精简导航、屏幕适配与账户余额 · 2026-10-31

状态：开发和自测完成，代码完成，尚未部署，待统一发布。用户实际验收未记录；本目录不是已启动的本地集成验收环境。

用户本次截图与明确要求：积分余额从导航移到“我的账号”；短屏下诚信核查不能被余额卡片挡住；去掉 BondBuddy 和“我的账号”独立菜单项，点击头像区域进入账户。此次确认覆盖旧常驻余额和助手侧栏入口原型。开发基线为 `6efbb5fcc342c21561f1397523dbcc1c5d7b9354`；初次余额与适配实现/原型为 `059cb4b3904a8333b6cdf63191ea839577c47042`；最新入口精简实现与原型均为 `6dd06f18874f69839b5e0c1d49d0d209161434f4`，本目录截图对应此最新源码版本。

## 交付行为

- 桌面侧栏及手机顶部不再显示积分卡片，不再创建全局余额轮询器。
- 侧栏不再显示 BondBuddy 和“我的账号”独立菜单项。底部头像与用户名是同一个账户链接，支持点击和键盘 Enter；有“我的账号”悬停提示和当前页状态，保留充值返回原工作的上下文。退出按钮位于链接外，BondBuddy 保留右下角图标及打开/收起/恢复功能。
- 我的账号继续显示可用积分、预留明细、充值与消费记录，新增含预留的余额合计；旧积分、订阅积分及人民币服务余额均保留各自的单位和口径。恢复网络也刷新账户；离开账户或退出登录停止账户轮询。
- 侧栏整体滚动，各入口保持自然高度及至少 44px 行高。低于 800px 收紧留白，低于 650px 隐藏工作空间装饰卡；不隐藏业务入口。
- 961–1200px 宽度使用 220px 侧栏；960px 及以下使用可展开菜单，账号卡片改为单列。顶栏面包屑允许换行，正文按可用宽度重排。
- 回归发现旧材料生成入口将字符串 `"0"` 差额当作积分不足；改为 `int64(shortage) > 0n`，保留原自动计费例外和正差额拦截。旧余额断言改由账户余额测试及任务自身状态/扣费回执覆盖。
- 新样式已加入 Docker 构建白名单和 COPY 输入。无 API、契约、数据库迁移、依赖或价格变更，无生产操作。

## 同尺寸截图

原型：`product-prototype/public/navigation-responsive.html`，共享 `navigation-responsive.css`；实现入口：`apps/web/src/main.ts`、`billing-page.ts`、`subscription-billing-page.ts`。

| 视口 | 实现 | 原型 |
| --- | --- | --- |
| 1366 × 768 | [实现](implementation-navigation-1366x768.png) | [原型](prototype-navigation-1366x768.png) |
| 1093 × 614 | [实现](implementation-navigation-1093x614.png) | [原型](prototype-navigation-1093x614.png) |
| 390 × 844 | [实现](implementation-navigation-390x844.png) | [原型](prototype-navigation-390x844.png) |
| 844 × 390 | [实现](implementation-navigation-844x390.png) | [原型](prototype-navigation-844x390.png) |

8 张图片均由最新入口精简回归重新生成，替换了初次截图，并已目视核验。对照范围为左侧导航、头像账户入口、断点、账户信息位置及余额口径。原型简化了账号设置/工作空间图标、既有充值内容和右下角助手，实现继续使用现有完整组件和助手留白；这些不是本次功能删除或未接线页面。横屏高度不足时整列滚动，账号与退出仍可滚到并操作。

## 验证

### 最新入口精简回归（源码 `6dd06f18`）

- `tsc --noEmit`、Vite 生产构建通过；构建仍有既有单包大于 500 kB 的提示。
- 浏览器单轮 35 通过、1 跳过。跳过的是既有可选旧版积分历史截图测试；其余账户、充值导航、助手开关和手机焦点测试全部通过。
- 账户测试分别点击用户名和头像，并检查键盘 Enter 激活、当前页标记、独立退出按钮及头像点击不触发退出。原 14 组窗口尺寸矩阵现在均通过头像进入账户；助手在 5 组尺寸下通过右下角图标打开、收起、恢复草稿和重载，侧栏均不再出现助手入口。
- 这是合成浏览器测试。临时 Vite 服务在检查完成后已停止，不是向用户交付的本地集成验收入口。

在 `apps/web` 启动独立 Vite 服务后，本轮命令为：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5417'
$env:BB_NAV_EVIDENCE_DIR='test-evidence/sidebar-responsive-20261031'
node ../../node_modules/@playwright/test/cli.js test tests/account.spec.ts tests/billing-navigation.spec.ts tests/project-assistant.spec.ts --grep 'account.spec.ts|billing-navigation|assistant closes to the bottom-right|mobile assistant keeps focus' --reporter=line --max-failures=3
node ../../node_modules/typescript/bin/tsc --noEmit
node ../../node_modules/vite/bin/vite.js build
```

### 初次余额与适配验证历史（源码 `059cb4b3`）

- 初次 `tsc --noEmit`、Vite 生产构建通过；构建有既有单包大于 500 kB 的提示。
- 前端单元全量 962 项：961 项首次通过，新增共享 CSS 未进入 Docker 白名单的 1 项失败已修复；对应构建资源检查 2/2 复验通过。没有将分次复验描述为单轮全绿。
- 浏览器合计覆盖通过 74 项，1 项旧版积分记录截图为可选测试并跳过。最终组合运行 72 通过、2 个显示断言失败；修正“已停止”文案及“可用 + 预留”总额断言后，两项定向复验通过。较早试跑还修正了旧账户夹具的 string-int64 协议、金额格式、隐藏菜单定位和旧记录文案；一次并行构建时的页面加载超时在最终运行未复现。
- 视口矩阵：1920×1080、1440×900、1366×768、1280×720、1093×614、1024×600、960×600、853×480、800×600、768×1024、390×844、320×568、844×390、1024×400。这 14 组指浏览器实际显示网页区域的测试宽高，页面通过响应式布局适配连续变化的尺寸。1093×614 和 853×480 覆盖常见缩放后的有效 CSS 视口，不声称实际操控了系统缩放设置。
- 导航测试检查 `elementFromPoint` 命中诚信核查、点击后路由/激活状态、项目问答可视性、短屏滚动至账号、菜单关闭及文档无横向溢出。账户测试覆盖余额合计、可用/预留、零值、请求失败不写零、网络恢复、定时刷新、离页停止轮询与退出清理。
- 同时通过账户设置、充值返回原工作、订阅/退款/续费、旧版文件生成开始及正差额拦截、任务终态、暂停续跑和任务扣费回执的合成浏览器回归。

运行方式（仓库既有依赖）：在 `apps/web` 启动 Vite，设置 `BB_E2E_BASE_URL` 指向该独立服务后，用 Playwright 运行 `account.spec.ts`、`billing-navigation.spec.ts`、`subscription-account.spec.ts`，以及 `m4-workspace.spec.ts` / `project-execution.spec.ts` 中涉及移除钱包的回归用例。设置 `BB_NAV_EVIDENCE_DIR=test-evidence/sidebar-responsive-20261031` 可重建本目录的对照截图。

测试使用 Chromium 和合成 HTTP API；没有真实模型、支付、生产数据或生产服务变更。后续由集成测试 chat 纳入固定版本供用户操作验收，再由统一发布 chat 按有效授权发布。
