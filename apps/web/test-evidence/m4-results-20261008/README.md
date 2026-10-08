# 材料生成：进度与成果 UX 验收

原型及运行版源码 commit：`39afefb3`。参考募集书基线：`51ea9b67` 的 `project-execution.ts` / `task-progress.ts` / `artifact-page.ts`。补充原型 `product-prototype/public/material-results.html` 可在本地打开，用 hash 选择 running、failed、succeeded。

确认依据：用户当前要求“材料生成的结果页面 UX 需要 refine，参考更新募集书的生成状态和结果页面的 UX”。沿用已有阶段条、浅绿状态区、下载卡、继续修改及折叠来源详情。M4 正文/说明的名称保持真实，无额外业务规则或新导航偏离。

| 状态 | 桌面原型 / 实现 | 手机原型 / 实现 |
| --- | --- | --- |
| 生成中 | [原型](prototype-running-desktop.png) / [实现](implementation-running-desktop.png) | [原型](prototype-running-mobile.png) / [实现](implementation-running-mobile.png) |
| 失败 | [原型](prototype-failed-desktop.png) / [实现](implementation-failed-desktop.png) | [原型](prototype-failed-mobile.png) / [实现](implementation-failed-mobile.png) |
| 已完成 | [原型](prototype-succeeded-desktop.png) / [实现](implementation-succeeded-desktop.png) | [原型](prototype-succeeded-mobile.png) / [实现](implementation-succeeded-mobile.png) |

同一 Edge、1440×1100 / 390×844 视口，截取相同宽高的内容区域。固定顶栏仅在内容截图中隐藏以免遮住标题；320px 另做溢出检查。原型静态 synthetic，实现使用 owner-scoped synthetic HTTP fixture；不冒充真实模型结果。标题、阶段、状态文案、按钮位置、下载卡和折叠详情逐屏核对，无设计偏离。最后一次证据重采样仅修正原型滚动条宽差。

验证：
- `npm run build`、`npm run check:contracts` 通过；最终源码通过 web build。
- Edge 首次运行材料、募集书执行、成果下载：93 通过，4 项募集书固定文案断言失败。恢复原募集书文案后，材料全量和四项受影响场景 28/28；阅读位置及下载回归 3/3。累计 102 个不同场景均通过，未跳过。
- 初次材料 25 场景覆盖：固定价格与失败反馈、保存与上传、不可变输入、真实阶段、暂停/等待/失败/取消、关闭标签后恢复、完成与刷新、同一 run 双文件下载、字节不符拒绝/重试、不混用旧说明、旧稿不抢焦点、滚动与展开状态保留、手机布局。
- 下载授权、hash、版本校验继续执行；下载/继续修改不自动编制，没有提交付费模型任务。

部署和回滚记录附发布 PR。本次只确认前端交互和工程行为，不代表文档专业内容已审核。

集成基线更新为 `db79fa99`（#594 一键生成、成功后扣费和钱包刷新）。冲突解决仅合并状态显示与充值提示，保留一键执行。对应源码 `39afefb3`，截图已按集成版本重采样。

最终准确集成复验：`m4-workspace.spec.ts` + `project-execution.spec.ts` + `account.spec.ts` 共 **86/86 通过、0 跳过**（含材料 30 场景）。另有此前通过的成果下载 28/28。最新前端 build 通过；契约与后端代码未变，沿用本轮通过的全包 build / contracts。
