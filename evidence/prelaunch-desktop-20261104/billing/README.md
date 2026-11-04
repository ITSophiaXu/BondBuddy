# 桌面支付与账号页修复验证（2026-11-04）

实现与本轮原型读取基线：`7f3c4ac77ef2128a5c9793bc31a20f2b8c84c9e5`。产品修复提交为 `ecfd757407a499026df487f2ab01486687ad860b`，最终账号页回归在相同产品源码的提交前工作树执行。本记录不表示已部署、完成真实支付验收或获得产品/发布确认。

| 问题 | 修复后验证的合成场景 | 覆盖限制 |
| --- | --- | --- |
| 付款未结束却无法改选，或结果未知时误建第二单 | 仅当前交互绑定的待付款订单提供“取消本次付款并重新选择”；服务端确认旧单结束后才能换套餐、金额或支付方式。关闭仍待确认、网络失败、重载及跨标签页时保留同一付款意图，不创建替代订单。 | 未调用真实商户支付/关单接口；原型无此操作，见下方待确认偏离。 |
| 开单明确被拒绝后仍被旧意图锁住 | 已持久化拒绝的订阅请求在刷新后仍可识别；用户确认该请求未创建订单后，才可另选充值。未知结果继续保留旧请求。 | 只对可证明未开单的持久化拒绝恢复；历史上无订单且无拒绝凭据的 v1 意图仍保守阻断，不能声称全部历史意图已恢复。 |
| 付款与关单同时完成时，已付款结果丢失或待执行任务未恢复 | 付款胜出显示已支付，返回准确的原等待任务且只恢复一次；不创建替代订单。旧单已确认结束后，即使后续账号读取失败，仍保留已结束结果。 | 浏览器使用 synthetic 路由与订单，不等于真实支付通知、数据库或 worker 联调。 |
| 账号轮询打断充值、退款输入或阅读 | 聚焦 input/textarea/select、IME 组合输入及打开的对话框期间继续取数，但延后被动整页重绘；恢复空闲或显式操作时更新。充值值/光标、退款控件、实际质量说明输入及展开的扣费规则保持。 | 自动化覆盖 Edge 桌面；静态原型没有 API 轮询和 IME 重绘，截图不能证明此行为。 |
| 离开账号页后支付异步回调把 URL 改回账号页 | 分别延迟关单和刷新支付后的历史读取，在此期间点击“更新募集书”；释放响应后仍保留目标页面及 `#update`，同一订阅 POST 仅一次。 | 只覆盖这两条已定位的异步导航路径。 |

最终浏览器回归由主 agent 在本轮最终账号页 diff 上执行（Windows、Edge，1440×960 viewport）：

```powershell
# apps/web；独立 Vite 服务 http://127.0.0.1:5176
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_E2E_BASE_URL='http://127.0.0.1:5176'
npm exec playwright -- test tests/subscription-account.spec.ts --output .test-output/final-subscription
# 49 passed / 0 failed，1.5m，exit 0
```

该套件也覆盖订阅/月付年付、精确充值金额与积分、未知结果/跨标签幂等、续费/停止续费、原订阅权益与退款依据、套餐升级及任务恢复。浏览器账务数据和写请求均由测试 fixture 构造；目录中的图片也不来自生产账户。

此前已独立完成的定向回归如下；它们与最终 49 项重叠，不累计为额外通过数：

```powershell
# apps/web；独立 Vite 5178
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_E2E_BASE_URL='http://127.0.0.1:5178'
npx playwright test tests/subscription-account.spec.ts --grep 'account polling|actual quality explanation' --reporter=list
# 3 passed / 0 failed，12.9s，exit 0

# apps/web；独立 Vite 5181
$env:BB_E2E_BASE_URL='http://127.0.0.1:5181'
npx playwright test tests/subscription-account.spec.ts --grep 'leaving during the .* payment history refresh' --reporter=list
# 修复前：2 failed，均为预期 #update 实际 #/account
# 加入历史读取后的页面有效性检查后：2 passed / 0 failed，10.2s，exit 0
```

早期辅助 fixture 调整中出现的等待超时与标题定位错误未作为产品缺陷计数。主 agent 另已执行仓库 build 与 `check:contracts`，均 exit 0；本目录的 49 项不是后端支付数据库回归计数。

## 截图来源与原型对照

原型页面为 `product-prototype/public/account-credits.html?subscription=1`，交互脚本 `product-prototype/public/subscription-account-prototype.js`，样式 `subscription-billing.css`、`subscription-experience-prototype.css`；本轮读取版本为上述基线 `7f3c4ac77`。实现入口为 `apps/web/src/subscription-billing-page.ts`，测试为 `apps/web/tests/subscription-account.spec.ts`。

以下复用当日 `outputs/prelaunch-desktop-20261104/` 的合成截图，逐张查看后原字节复制，未裁切、缩放或修改原型。截图 helper 使用 `page.screenshot({fullPage:true})`；原始截图运行的完整终端命令未保留，因此不重构该命令，也不把旧截图当作最终竞态回归的截图证据。全部以 1440×960 viewport 采集，但 **PNG 的实际全页尺寸不同**；准确尺寸、来源与 SHA-256 见 [screenshots.json](screenshots.json)。

| 截图 | 实际 PNG 尺寸 | 证明的可见状态 |
| --- | --- | --- |
| [实现：月付与充值](subscription-final-monthly-1440.png) | 1440×2364 | `sample_user` 合成账号、充值输入 12.18 元及将到账 1,218 积分。 |
| [原型：月付与充值](subscription-final-prototype-monthly-1440.png) | 1440×1838 | 静态 `owner_a`、脚本硬编码的脱敏示例手机 `+86138****5678`；页面明确标注合成原型，不连接真实账户/支付。 |
| [实现：原付款结束](prelaunch-payment-closed-1440.png) | 1440×2747 | 合成订单 `subscription-order-1` 已过期，显示可重新选择套餐、金额或支付方式。 |

图片中的用户名、余额、订单号、项目名、手机号占位及记录均来自本地 fixture/静态原型；未包含真实账号凭据、会话令牌、客户材料或客户资料。未复制同源目录中的线上账户 JPG。

对照沿用账号信息/余额卡、月付年付切换、套餐卡、按需充值及折叠规则的位置。原型和实现的示例账号、导航、说明文案、历史记录及全页高度存在差异；全页截图中的固定侧栏位置还受采集时滚动影响。因此这组原始全页图不能替代仓库要求的同尺寸逐屏视觉验收。

**待产品确认的偏离：** 静态原型点套餐即模拟付款成功，充值也直接模拟到账，没有待付款二维码、关单、重新选择、未知结果、持久化拒绝或异步导航竞态。新增“取消本次付款并重新选择”按钮及其确认/未知/终态状态提示未找到对应已批准原型，仍待产品负责人确认；本记录没有确认人，也不视为已批准。规则展开和输入保留符合原有阅读/输入流程，但静态截图无法验证动态刷新细节。未修改原型来制造一致性。

本轮未覆盖手机、真实付款/退款/关单、支付渠道通知、生产账号账务写入、真实模型调用或客户材料；不得据此宣称正式收费链路已经端到端验收。
