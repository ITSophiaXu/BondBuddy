# 更新募集书操作栏随内容滚动

2026-10-13 用户截图反馈：底部“上一步 / 开始编制”所在操作栏应在填写内容滚到底部后才看到，不应一直悬浮。该要求覆盖 2026-10-04 的准备阶段吸附设计；本次用户为交互变更确认人。关联 #361。

基线：`develop 6cd5d2cb`。原型及实现共用样式的修复 commit：`55fe62c1ff7857e9513462177663069d97cd5fe0`。

- 原型：`product-prototype/public/authoring-actions.html`、`project-workspace.js`；共用样式 `project-workspace.css`。
- 实现：`apps/web/src/main.ts` 导入同一份 `project-workspace.css`，操作栏本已排在材料和补充说明后面。
- 删除准备阶段的 sticky 定位、底部偏移、层级和浮动阴影，同时移除手机底部偏移及短屏例外。现有网格、按钮大小、提示和执行行为保留。
- 无 API、worker、数据库迁移或依赖变更。

## 验证

Windows、Node 24.19.0、Edge Chromium；依赖复用同锁文件的本地安装，工作区包指向本分支。使用现有 `project-execution.spec.ts` 合成 HTTP 夹具，未连接生产服务、数据库或调用模型。临时截图脚本复用既有 fixture/setup，没有新增自动化用例。

- 全部 7 个 workspace 的 TypeScript 检查/编译及 Vite 网页生产构建通过。保留现有单包超过 500 kB 的构建提示。
- contracts：171 个合成示例、12 个内部示例、4 个生命周期示例及 40 项既有测试通过。
- 既有浏览器定向回归 **3/3 通过**：积分不足保留输入及充值返回、一次开始及结算刷新、试用零扣费提示。
- 7 种状态/屏幕组合，分别检查顶部、中部、底部，共 21 组坐标；均为 `position: static`，顶部/中部不进入视口，底部完整显示，操作栏与填写内容保持 20 px 间隔，无横向溢出。原始坐标见 [geometry.json](geometry.json)。
- 桌面 1440×960；平板 768×1024；手机 390×844；小屏 320×740；短屏 844×390。桌面及手机同时检查空材料禁用和已准备可开始状态。

复验命令（从 `apps/web`，以本分支 Vite `127.0.0.1:5193` 为目标）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5193'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/project-execution.spec.ts --grep 'credit visibility: one click|credit visibility: trial explains|M2 shortage preserves' --reporter=line
```

## 原型与实现对照

同尺寸原型/实现均使用上述修复 commit 的共享布局。原型仅展示操作栏，没有完整表单；完整滚动位置用实现截图和坐标核对。原型保留其历史扣费文案，实际页面沿用当前按进度扣减文案，这一既有文字差异不属本次定位调整。操作栏尺寸、按钮对齐和换行未新增偏离。

| 视口/状态 | 页面顶部 | 页面底部 | 操作栏原型 |
|---|---|---|---|
| 1440×960 空材料 | [实现](empty-desktop-top.png) | [实现](empty-desktop-bottom.png) | [原型](prototype-1440.png) |
| 1440×960 可开始 | [实现](ready-desktop-top.png) | [实现](ready-desktop-bottom.png) | 同上 |
| 768×1024 可开始 | [实现](ready-tablet-top.png) | [实现](ready-tablet-bottom.png) | — |
| 390×844 空材料 | [实现](empty-mobile-top.png) | [实现](empty-mobile-bottom.png) | [原型](prototype-390.png) |
| 390×844 可开始 | [实现](ready-mobile-top.png) | [实现](ready-mobile-bottom.png) | 同上 |
| 320×740 可开始 | [实现](ready-small-top.png) | [实现](ready-small-bottom.png) | — |
| 844×390 可开始 | [实现](ready-short-top.png) | [实现](ready-short-bottom.png) | — |

## 交付状态

开发和自测完成。代码完成，尚未部署，待统一发布。尚未纳入统一本地集成测试版，用户尚未验收；本目录合成界面验证不代表真实上传、生成、模型效果或计费端到端验收。
