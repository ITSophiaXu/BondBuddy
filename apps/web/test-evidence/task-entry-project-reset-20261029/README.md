# 侧栏任务入口不沿用上一个项目

基线：`c7d0c42a58c467c999f9c565a7355aaef37079bf`（develop）。实现为本 PR 的 `apps/web/src/main.ts`；本次用户明确要求切换任务时重新选择或新建项目。

## 行为与视觉核对

- 从已有复核结果点击任一侧栏任务，URL 仅保留该任务入口，不含旧项目、返回项目、报告或任务编号。
- 项目选择列表没有默认选中项，下一步禁用；可新建项目或明确选用另一项目。返回原复核结果时仍能定位原报告与执行记录。
- 同一项目内的文件、问答续办、核查历史、免费导出及充值返回继续携带明确上下文。
- 实现截图：`implementation-1440.png`、`implementation-390.png`；手机展开菜单：`menu-390.png`。已查看，标题、单选项、新建项目、禁用的下一步均可见，无横向裁切或重叠。
- 既有原型 `product-prototype/public/project-entry.html`（上述基线 commit）对照：`prototype-1440.png`、`prototype-390.png`。原型是文件生成的项目选择页，截图显示用户主动选择后的状态；实现证据是诚信核查未选择状态。沿用相同侧栏、选择列表、搜索及底部操作布局；诚信核查既有三步提示保留。本次仅导航行为与「开始工作」提示改变，用户为确认人，未修改原型布局。

## 验证方式和边界

Windows / Node / Edge headless。Vite 从本独立工作区在 127.0.0.1:5317 运行；Playwright 拦截 HTTP 并使用合成项目及报告，没有连接生产数据库、调用模型、实际核查或支付。

依赖复用本地已安装包，两个工作区的 `package-lock.json` SHA-256 相同：`61b7a0eb3df7b45c0c7a760b5d0325eb531e94d49c29b5fb2797ae0e9fa02d59`。各工作区包指向本分支并重新构建，不复用旧业务编译产物。

- 完整 TypeScript 构建（contracts/domain/rule-pack-registry/rule-applicability-context/api/worker/web）及 Vite 生产构建通过；Vite 保留既有大 chunk 提示。
- 契约：49 项测试、171 个合成示例、12 个内部资料库示例及 4 个生命周期示例通过。
- 新增任务入口回归：3 项通过；其中桌面与手机分别遍历全部五类入口，核对不预选、不自动提交、后退恢复；另验证新建空表单、选择另一项目及再次切换。
- 既有项目选择布局/原型：16 项通过，覆盖 1440/390/320 宽度、底部按钮、搜索、选择及分页。
- 既有充值导航：4 项通过。
- 既有项目内导航：3 项通过，覆盖问答续办/历史、核查历史/免费导出和生成文件的准确任务。以上各组最终共 26 项通过；不是首次整轮全绿。

浏览器命令（在 apps/web，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5317`、`BB_E2E_BROWSER_CHANNEL=msedge`）：

```text
node ../../node_modules/@playwright/test/cli.js test review-workspace.spec.ts --grep "completed review starts|after review, integrity"
node ../../node_modules/@playwright/test/cli.js test project-entry-layout.spec.ts --grep "project selector"
node ../../node_modules/@playwright/test/cli.js test billing-navigation.spec.ts scene-navigation.spec.ts
```

首轮冷启动超时和截图脚本缺少 import 已修正；新增测试改为按复核页实际规范化后的项目/报告/任务参数检查后退。已有问答导航测试需先点击「准备下一轮」展开续办区，已补上该用户操作；问答产品代码未改变。保留这些测试调整记录，不把首次失败描述为通过。

状态：开发和自测完成后交付统一集成；用户尚未验收，尚未部署。无依赖或迁移变化，仅需发布 web。
