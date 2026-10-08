# 状态优先工作台验收（2026-10-08）

用户在本会话明确选择第一个“状态优先”方案。关联 #361；本切片不关闭父 Issue 或 #448。

- 原型与实现源码 commit：`b4062853ffc81248f4dba2405fbd0c42d2d91d01`；基线 develop `947628b7`。
- 原型：`product-prototype/public/dashboard-status.html`，从用户已确认的方案提取，不再包含第二个备选方案。
- 已迁移页面：工作台、更新/复核/材料任务从工作台进入后的导航及返回链接。任务执行、计价和交付规则不变。

## 同尺寸对照

| 视口 | 已确认原型 | 实现 |
|---|---|---|
| 1440 × 960 | [原型](prototype-1440.png) | [实现](implementation-1440.png) |
| 390 × 960 | [原型](prototype-390.png) | [实现](implementation-390.png) |

两侧均在同一视口由 Edge 截取；以上为同尺寸首屏，`*-full.png` 保留原始全页截图。截图使用 synthetic 账号、项目、余额和任务，无客户内容。

逐项对照：
- 保留待处理/进行中/已完成卡片、紧凑开始入口和统一任务列表，按类型/状态筛选。
- 正式页沿用当前站点的侧栏宽度、字体、账号与积分位置，保持用户先前确认的全站外壳；原型外壳只作示意。
- 原型“失败”细分扩展为“未完成”，如实覆盖停止、暂停、未启动和内部测试稿；不把旧成功成果算为本次完成。
- 正式页增加真实发行人、最近更新时间、复核版本记录、刷新与分页；状态阶段使用服务端已有公开字段，不虚构百分比或 ETA。全部数量按未归档项目当前/最近任务计数，非累计作业次数。
- 原型的示例新建/详情页说明跳转目的；正式页复用已上线的创建、进度、Word 成果与三维复核结果，不实现新的业务页。
- 手机上状态卡细分标签允许整段换行，避免数字单独落行；320/390/1024/1440 宽度无横向溢出。

## 验证

Windows / Node 22.14 / Edge，API 由测试拦截为 synthetic 数据。

- `npm run build`：全仓构建通过，保留既有 bundle 大小提示。
- `npm run check:contracts`：167 公共 + 12 内部示例、4 生命周期示例、29 OCR + 11 发行人绑定测试通过。
- `npm run test:unit -w @bondbuddy/web`：88/88 通过，无跳过。
- 针对性 Playwright：13/13 通过，无跳过。覆盖跨页统计/失败不显示部分总数、刷新保留旧快照并报错、三类准确任务跳转、旧成果不能替代本次失败、刷新/编辑/标签切换/返回保持导航和筛选、加载错误、新建导航、原全部项目入口、窄屏与积分。

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5198'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
# 从 apps/web 运行
node ../../node_modules/@playwright/test/cli.js test dashboard-status.spec.ts m4-workspace.spec.ts review-workspace.spec.ts project-execution.spec.ts prototype-workflow.spec.ts --grep 'totals include|failed later|task state actions|dashboard material|dashboard review|dashboard update|all-projects update|creating an update|project loading and error'
```

初次材料失败导航测试误断言“失败”，页面既有文案为“本轮未完成”；修正测试后通过，不改变产品失败语义。旧全量 `test:web` 不是单元测试命令，误启动后已停止，未列为通过。

当前证据是本地实现/自动化与原型对照。生产部署版本、正式站点验证和用户原账号体验分别在 PR/Issue 记录；不将 synthetic 浏览器测试当作真实模型、真实下载内容或用户验收。
