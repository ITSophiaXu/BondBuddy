# 订阅与充值账户：界面验证

2026-10-29。Windows、Node v24.22.1、Edge headless、Vite http://127.0.0.1:5184。验证工作树基于 `3e844b1`，包含本轮尚未提交的修改。数据、订单、订阅授权和退款均为 synthetic HTTP fixture；没有真实商户扣款、真实渠道授权或模型调用，也未验证专业成果或真实付费意愿。

## 已实现

- 账户及导航钱包改为积分口径，分别展示订阅、永久充值和其他有效额度。任务积分与订阅实付金额分别显示。
- 三档月订阅为199元/21,000积分、499元/55,000积分、999元/114,000积分，每批90天。低频用户保留按需充值，1元=100积分，无批量加赠。
- 付款未知时保留同一套餐和请求号重试；未核实到账不显示已到账，不发送客户端金额、积分或价格版本作为订阅定价依据。
- 现有单次收款渠道不冒充自动续费能力。真正返回渠道授权链接后仍显示待授权，查询核实后才显示已开通。取消续费保留已购有效额度。
- 订阅整期退款界面显示实际订阅付款金额，金额只读，资格由服务端判断；申请受理不显示已原路退款。
- 有效本账户等待意图与已核实支付同时存在时，自动返回原业务页面。原页面复用原请求执行；外账号、无效或过期本机意图不会启动。该恢复需要本机页面参与，未实现关闭浏览器后的服务端后台续跑。
- 原commercial和历史积分界面保留；新模式由订阅catalog的enabled控制，接口缺失按旧部署处理，接口错误不伪造订阅/余额。

## 验证命令与结果

以下最终两组命令均从仓库的 `apps/web` 目录执行，使用已启动的 Vite 服务。

```powershell
$env:PATH='C:\Users\lezhai\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin;' + $env:PATH
$env:BB_E2E_BASE_URL='http://127.0.0.1:5184'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test subscription-account.spec.ts automatic-task-billing.spec.ts commerce-account.spec.ts --output "$env:TEMP\bb-final-billing-browser-web"
node ../../node_modules/@playwright/test/cli.js test project-execution.spec.ts project-assistant.spec.ts workpaper-batch.spec.ts file-generation-workbench.spec.ts --grep 'automatic (authoring|assistant|workpaper|file package)' --output "$env:TEMP\bb-final-task-browser-web"
```

- 第一组：**19 passed，0 failed，0 skipped，39.0 秒**。其中 `subscription-account.spec.ts` 10 项、`automatic-task-billing.spec.ts` 4 项、`commerce-account.spec.ts` 5 项，一次整组全部通过。
- 第二组：**5 passed，0 failed，0 skipped，15.7 秒**。覆盖文件包一次业务点击直接执行、助手第一次发送即提交一次、募集书一次点击执行且无金额弹窗、募集书零余额保存原请求并展示准确积分差额、底稿按服务端单价一次点击执行。
- 两组共 **24 个不同浏览器用例通过**。订阅及账户用例涵盖未配置渠道、三档展示、同请求重试、小额精确充值、取消续费、整期现金退款、渠道授权核实、命名任务恢复、外账号隔离及新旧原型；原商业账户的单位展示、范围反馈、未定价项和同单支付重试也已回归。
- 首次从仓库根目录执行第一组时，两个原型用例因测试使用 `resolve('../../product-prototype/public')` 而找不到文件（`ENOENT`）。随后按仓库脚本要求改用 `apps/web` 工作目录，将完整第一组重新运行，结果为上述 19/19；没有通过跳过用例取得通过结果。
- 本轮此前运行的 contracts 构建、Web/API TypeScript `--noEmit` 和 `git diff --check` 均通过。早先测试文件中的 Vite 绝对导入路径问题已修复；最终全包构建和数据库测试以主任务统一验收记录为准。
- 最终两组功能回归没有重拍下列截图，也不代表重新完成了视觉检查。

## 视觉证据

实现使用现有账户页结构，新订阅区域沿用积分卡片、价格卡和历史记录样式。共享样式位于`product-prototype/public/subscription-billing.css`，实现由`apps/web/src/subscription-billing-page.css`引入；原型入口`account-credits.html?subscription=1`。

|视图|实现|原型|
|---|---|---|
|1440×960视口、整页|[实现](ui/subscription-account-1440.png)|[原型](ui/subscription-account-prototype-1440.png)|
|390×844视口、整页|[实现](ui/subscription-account-390.png)|[原型](ui/subscription-account-prototype-390.png)|

已查看实现桌面和手机截图，修正深色积分卡中的来源分项对比度；手机页面无水平溢出。原型有明确合成提示、静态历史，实际页面有真实接口加载和反馈入口，账户样例身份不同。这些是已记录的演示差异，不代表真实用户已签认全部视觉效果。

## 尚需最终统一验收

正式商户订阅收款、渠道签约代扣、自动续费后台调度、真实退款、专业任务和付费行为均不由本组HTTP界面测试证明。测试没有评估套餐支付意愿或60%税后利润目标。
