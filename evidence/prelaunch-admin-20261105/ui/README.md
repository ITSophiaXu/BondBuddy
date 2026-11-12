# 桌面管理导航与恢复排查证据

基线：`3bb7baf12dba1c75465e9c5dd71ef7b073c176a9`。所有账号、任务、金额、素材上下文和 HTTP 响应为 synthetic；浏览器访问独立本地 Vite 端口，使用已安装 Chromium 1243 的新临时 profile。未调用生产管理写入、商户、充值、退款或模型。

修复管理页顶部链接跳回产品首页、退出不发送请求、503 退出无反馈、产品助手在管理页泄漏四项。pending 退出禁连击，503 后保留当前页面并可重试；助手只移出页面，原实例、完整输入、引用、成果上下文及未完成 view PUT 保留，返回产品页重新 mount。

| 轮次 | 列出的测试 | pass | fail | 说明 |
|---|---:|---:|---:|---|
| first-red | 5 | 0 | 5 | 浏览器缓存路径缺失；测试体执行 0，单列基础设施错误 |
| behavior-first-red | 5 | 0 | 5 | 实际点击跳到 #/；退出 POST 0；助手可见 |
| navigation-logout-only | 5 | 3 | 2 | 链接和正常退出绿；503 无 alert、助手泄漏仍红 |
| final-evidence-green | 5 | 5 | 0 | 四项 UI 修复及同尺寸截图绿；早于新增趋势用例 |
| review-cost-scale-final-ten | 10 | 10 | 0 | 原 4 项 + 新 5 项恢复/导航 + 1 项十四日趋势；skip/unexpected/flaky 均 0 |

十四日 fixture 从 2026-10-23 至 2026-11-05，只有两天有任务，合计 3 个用户日，日均 0.2；零日不画柱。独立截图审查在旧十项绿色轮发现小额正成本柱高度为 0，保留 `cost-scale-discovery-before.png` 及当轮源码指纹。修复后同一第十项增加正成本柱非零及 0.0001/0.0002 USD 高度比例 2 的断言；最新截图见 `calendar-and-cost-after.png`。旧九项、早期十项和完整 trace 留在 ignored 本地原目录，未用它们绑定最终源码。

最终运行记录六个相关源码/CI 文件执行前后字节 SHA256；`manifest.json` 另记 LF-normalized SHA256。API 指纹用于标识候选，浏览器中的 API 均为 fixture；真实 PG 聚合验证见相邻 `../trend/` 证据。完整本地 build exit 0 的日志在 `full-build-first.log`，最终合并树的 Node 22 CI 尚需执行。

Desktop CI 新增独立步骤执行完整 admin spec，保留原 journeys、权限和 timeout，使用 line + JSON 并要求非空、逐项终态 passed、无 skip/unexpected/flaky；本地原样执行该 guard 接受十项报告，拒绝人为构造的 skipped/空报告。检测器验证不计入产品测试数量。

全部关键截图均 1280×720；修前 JPEG 是原 trace 最后一帧的原字节拷贝，来源与 SHA256 在 manifest 中。仅复制指定日志、元数据和九张截图，没有复制完整 trace、浏览器 profile、node_modules 或其他本地资源。

当前 public 原型目录检索 `运营管理看板|运营看板|ADMIN CONSOLE|admin/dashboard` 在 HTML/JS 中无匹配；`dashboard-v2.html:8,38` 和 `dashboard-status.html:214` 是个人工作台，非管理员控制台。本次以已合入的 3bb 管理外壳为修前对照，仅修复已存在操作，未宣称与独立管理员公开原型对齐。

上述是本地功能/体验证据，不能代替真实支付、真实模型、生产权限验收或最终收费放行。
