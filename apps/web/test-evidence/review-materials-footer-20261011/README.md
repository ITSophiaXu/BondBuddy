# 复核材料页底部 UX 修正

2026-10-11，按用户本次红框截图调整。开发基线：`e2cba46b1a8b73978bf11c5417df5f5c2af1f58c`。

提交前已 rebase 到最新 `develop 3faa8367`，该集成版本的 web TypeScript、Vite 和相同 9 项交互再次通过。新增基线只涉及并行 QA 修正，本页底栏源码未发生冲突；原型及布局源码 commit 为 `8f45184d`。GitHub hosted checks 未启动，annotation 明确为账户付款失败或 spending limit 原因，不能计为通过；以上为本地实测证据。

材料分区后不再重复显示三个复核维度和“助手已采纳要求”。左侧保留简短准备状态，右侧将“与助手讨论”和“开始复核”组成一组，主操作位于最右侧；手机两个按钮并排占满可用宽度。运行时提示当前任务进行中，上传未完成时仍保留具体状态并禁用开始。

- 实现：`apps/web/src/review-workspace.ts`、`review-workspace.css`。
- 对照原型：`product-prototype/public/review-materials-footer.html`，与实现同次提交；仅展示本次调整的底部区域，支持准备、上传中、失败、运行中状态。
- 用户本次截图与明确要求为布局变更确认依据。旧 `review-v2` / `workspace-ux` 原型的范围标签和已采纳要求区在本切片由新原型替代；其他页面交互不在本次调整范围。
- 已保存要求仍由原有助手记录，并出现在执行确认中。API、输入版本、任务确认、计费和数据库均无变化。更新页已合并的 #660 同样把主按钮置于右侧，本次修正复核页的三元素分散排列。

## 验证

Windows / Node 24.19.0 / Chromium，使用现有 owner-aware synthetic HTTP fixture，不访问真实账号，不发起真实模型、复核或支付。

- web TypeScript 和 Vite 生产构建通过。初次类型检查因独立工作区缺少 API dist 失败；编译既有 API 依赖后通过。
- contracts 构建、171 个公开示例、12 个内部示例、4 个生命周期示例及 40 项契约测试通过。
- 现有 `review-workspace.spec.ts` 9/9 通过：桌面/手机讨论草稿恢复、直接上传重试、桌面/手机完整上传保存队列、草稿保存重试、桌面/手机明确收费提交与积分不足、响应丢失幂等重试。
- 复用现有 fixture 作一次性截图复验，未增加镜像实现的永久测试。1826 / 1440 / 1100 / 900 / 768 / 390 / 320 px 均无横向溢出；主按钮右边缘与底栏右边缘对齐，两个按钮同排且高度不小于 44px。
- 有要求和无要求均不再显示冗余区；有要求时执行确认仍显示“核对财务摘要引用。”，未创建任务。运行中开始禁用而讨论仍可用。
- 原型/实现以相同浏览器视口、相同内容可用宽度截图。各宽度的操作栏高度一致，参见 `measurements.json`；已人工查看桌面和手机图，无设计偏离。

命令（使用现有本地依赖）：`node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit`；`node node_modules/vite/bin/vite.js build apps/web`；在 `apps/web` 下通过 `BB_E2E_BASE_URL=http://127.0.0.1:5196` 执行现有 Playwright，用例筛选为 `unified review materials|upload queue keeps|direct upload retries|paid review reserves|paid review response loss|draft-save retry`。

## 同尺寸底栏对照

| 屏宽 | 原型 | 实现 |
|---|---|---|
| 1826 | ![原型](prototype-footer-1826.png) | ![实现](implementation-footer-1826.png) |
| 1440 | ![原型](prototype-footer-1440.png) | ![实现](implementation-footer-1440.png) |
| 1100 | ![原型](prototype-footer-1100.png) | ![实现](implementation-footer-1100.png) |
| 900 | ![原型](prototype-footer-900.png) | ![实现](implementation-footer-900.png) |
| 768 | ![原型](prototype-footer-768.png) | ![实现](implementation-footer-768.png) |
| 390 | ![原型](prototype-footer-390.png) | ![实现](implementation-footer-390.png) |
| 320 | ![原型](prototype-footer-320.png) | ![实现](implementation-footer-320.png) |

页面上下文：[桌面](implementation-page-1826.png)、[手机](implementation-page-390.png)、[320px](implementation-page-320.png)、[运行中](implementation-running-320.png)。

开发 PR 与部署分别记录，不以本地通过代表已上线。关联 #47、#361，父 Issue 的其他验收事项保留。
