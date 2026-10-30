# 商业计费前端验证证据

基线：`develop@5d24d5d`。参考原型和实现截图对应 `feat/commercial-billing-20261028` 的代码提交 `18e2a21`；后续提交仅补充本证据索引。两边均使用该提交中的源码及合成响应，尚无产品负责人对差异的确认。原型入口为 `product-prototype/public/account-credits.html?commerce=1`，默认入口仍保留旧积分演示。

## 截图范围

所有截图都是合成演示。Playwright 拦截并返回合成 `/api/v1` 响应；余额、历史记录、范围报价、工作项和报价 ID 均为测试数据。未调用真实数据库、模型、商户付款或文档生产，不证明真实充值到账、专业内容验收或 60% 利润率。

三张截图使用相同的桌面 viewport：1440 × 960。账户两图采用全页截图，页面高度不同；不表示逐像素对齐。原型与实际应用的导航和页面构成也有差别。

| 文件 | PNG 实际尺寸 | 可查看的内容 |
| --- | --- | --- |
| [commerce-account-implementation-1440.png](commerce-account-implementation-1440.png) | 1440 × 1580 | 实际账户页、人民币余额、设计参考金额、混合历史单位、商户未接入状态、原范围问题反馈入口 |
| [commerce-account-prototype-1440.png](commerce-account-prototype-1440.png) | 1440 × 1289 | 当前分支参考原型；合成状态，付款按钮禁用 |
| [qa-scope-confirmation-1440.png](qa-scope-confirmation-1440.png) | 1440 × 960 | 实际问答回复确认弹窗；已核范围、工作项、服务端总价 ¥123.40、交付与原范围修正规则 |

便于同尺寸对照另保留两份 1440 × 960 账户裁图：[实现 viewport](commerce-account-implementation-1440-viewport.png)、[原型 viewport](commerce-account-prototype-1440-viewport.png)。这两图由上方全页原图裁取；原图保留完整内容。

已逐张视觉检查。诚信核查、逐文件同步、编制和复核有自动化断言，本目录未为这些页面额外截图。仅验证此处桌面呈现，未据此声明移动端完成视觉验收。

## 复现

从仓库根目录执行（当前 Windows 环境使用已安装的 Edge）：

```powershell
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_UX_EVIDENCE_DIR=(Resolve-Path evidence/commercial-billing-20261028/ui).Path
npm test -w @bondbuddy/web -- commerce-account.spec.ts commerce-task-scopes.spec.ts
npm test -w @bondbuddy/web -- project-execution.spec.ts review-workspace.spec.ts file-generation-workbench.spec.ts --grep 'commercial scope'
```

首条命令生成三张图片。图片没有真实支付二维码；本地二维码渲染由独立合成测试验证。

## 已执行验证

商业计费新增 12 项 Playwright 用例通过（4 项账户、5 项范围任务、3 项编制／复核／批次）。关键断言包括：

- 只有服务端启用新模式才显示人民币；旧历史行依据各自元数据保留积分单位。
- 待核范围的零金额不视作免费，没有执行按钮且不创建任务；已核报价先显示工作项与总价，取消确认不执行。
- 问答总价、诚信核查总价及各文件独立报价均直接取服务端结果，不按类别固定价或题数推导。
- 原已付问题范围补料／修正沿用原单；改为新事实后重新报价；同版本已付检查可复用为已核零价。
- 批次验证不同文件金额 ¥23.81 / ¥82.91，总价 ¥106.72，提交各自报价 ID。
- 充值按精确金额创建；不确定结果重试沿用同一请求 ID；WeChat 原生链接在本地编码为二维码。未接入商户时无可执行付款。
- 已付成果可反馈已采用、原范围问题或未采用；不承诺提交反馈即自动退款。

旧流程定向回归 6 项均通过：一致性确认 1 项、诚信核查延续 2 项、问答延续 3 项。曾发现旧流程提前保存及乘法金额文案回归，已恢复旧行为后复验；最后一项问答回归与两项商业问答一起复跑，3/3 通过。

构建使用 `npm run build -w @bondbuddy/web`，已通过（有既有大包体提示）。单元测试使用 `npm run test:unit -w @bondbuddy/web`；价格格式化已拆到无 DOM、CSS 或 API 依赖的纯模块，避免 NodeNext 测试加载浏览器代码。完整单元测试实际执行 883 项，882 项通过，唯一失败为既有部署上下文缺少 `workpaper-entry.css`；集成负责人补齐 Docker COPY 与忽略白名单后，该资产测试定向复验 1/1 通过，未再次全量执行 883 项。
