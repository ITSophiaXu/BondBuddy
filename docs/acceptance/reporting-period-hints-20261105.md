# 报告期异常就地提示：开发验收记录

状态：开发和自测完成；尚未纳入统一本地集成版，用户未验收。代码完成，尚未部署，待统一发布。

## 固定版本与范围

- 开发基线：`ab36573f2f59c9bea7e77a7b6006b2325fdb4fdb`（develop）。
- 原型 commit 和实现 commit 均为 `5b135ea4`。本记录后续提交仅补交接，不改变产品实现。
- 原型：`product-prototype/public/project-workspace.js`、`reporting-period-hints.js`、`source-prospectus.css`。
- 已迁移页面：募集书更新的项目信息／材料页、侧边 BondBuddy 更新表单。关联 #361，用户本次要求为新增提示的依据。
- [产品决定](../product-decisions/2026-11-05-reporting-period-hints.md)：明确原稿／目标期间比较；财务文件名只给出可能的期间线索，不宣称已读取正文；不自动更改日期或阻断执行。

## 验证结果

Windows、Node 24.22.1、Microsoft Edge；独立工作区。使用真实前端代码、合成文件和严格模拟 HTTP，未连接生产、真实数据库、Blob、模型或账务。

| 检查 | 结果 |
|---|---|
| contracts、domain、rule-pack-registry、rule-applicability-context、API TypeScript 编译 | 通过；供 web 测试类型引用，未启动后端服务 |
| web TypeScript 和 Vite build | 通过；仍有既有的大 bundle 提示 |
| 契约样例 | 179 项公开 + 12 项内部样例及恢复／冲突／用量不变量通过 |
| 数据生命周期样例 | 4 项通过 |
| 单元检查 | 19/19：期间提示、报告窗口、表单及已有材料处理行为 |
| 浏览器检查 | 23 个不同用例最终通过：本次材料／目标提示 6、助手提示 1、原稿信息引导 9、格式选择 7 |
| 原型、页面截图 | 1440×1000 和 390×1000 下原稿、财务材料、目标报告期三个区域的文案与组件尺寸一致；已人工查看截图 |
| Git diff 与原型 JS 语法 | 通过 |

覆盖：两种异常同时出现；不读取 profile／不新增解析请求；无自动保存和自动执行；正常明确开始可锁定原输入；原稿和目标分别修改、保存和刷新；输入焦点不丢失；另一项目区域不被更新；新文件上传完成立即提示；同期、旧期、空期间、无效日期、版本／hash 不匹配、文件下载日期和多期间文件名不误报；用户文件名转义；移动端换行。

实际分批运行的浏览器用例合计 23 个，无跳过。截图脚本的定位及 `innerText` 换行比较在初次执行失败后修正，最终截图用例定向通过；产品逻辑用例最终均通过。

复现入口（从仓库根目录先安装锁定依赖、编译上述依赖包，再在 `apps/web` 执行）：

```text
node ../../node_modules/typescript/bin/tsc --noEmit
node ../../node_modules/vite/bin/vite.js build
node ../../node_modules/typescript/bin/tsc -p tsconfig.test.json
node --test dist-test/reporting-period-hints.test.js dist-test/reporting-window.test.js dist-test/update-form.test.js dist-test/material-processing.test.js
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5198
```

另一个终端设置 `BB_E2E_BASE_URL=http://127.0.0.1:5198` 和 `BB_E2E_BROWSER_CHANNEL=msedge`，运行：

```text
node ../../node_modules/@playwright/test/cli.js test reporting-period-hints.spec.ts assistant-period-hints.spec.ts authoring-source-guide.spec.ts source-format-template.spec.ts --output=../../work/period-hint-results
```

5198 是自动化测试的前端服务入口，依赖测试脚本拦截 API；不是已经交付的本地集成验收版。停止时结束该 Vite 进程即可。

## 同尺寸原型对照

组件在相同页面环境、相同可用宽度下比较文案及实际宽高。完整上下文截图展示实际就地位置。用户要求之外的原型偏离：无；手机端将原稿保留状态移到下方，避免挤窄原稿区域，与原型原稿独占宽度保持一致。

| 区域／视口 | 原型组件 | 实现组件 | 实际页面上下文 |
|---|---|---|---|
| 原稿／1440 | [原型](reporting-period-hints-20261105/prototype-source-1440.png) | [实现](reporting-period-hints-20261105/implementation-source-1440.png) | [页面](reporting-period-hints-20261105/context-source-1440.png) |
| 原稿／390 | [原型](reporting-period-hints-20261105/prototype-source-390.png) | [实现](reporting-period-hints-20261105/implementation-source-390.png) | [页面](reporting-period-hints-20261105/context-source-390.png) |
| 财务材料／1440 | [原型](reporting-period-hints-20261105/prototype-material-1440.png) | [实现](reporting-period-hints-20261105/implementation-material-1440.png) | [页面](reporting-period-hints-20261105/context-material-1440.png) |
| 财务材料／390 | [原型](reporting-period-hints-20261105/prototype-material-390.png) | [实现](reporting-period-hints-20261105/implementation-material-390.png) | [页面](reporting-period-hints-20261105/context-material-390.png) |
| 目标期间／1440 | [原型](reporting-period-hints-20261105/prototype-target-1440.png) | [实现](reporting-period-hints-20261105/implementation-target-1440.png) | [页面](reporting-period-hints-20261105/context-target-1440.png) |
| 目标期间／390 | [原型](reporting-period-hints-20261105/prototype-target-390.png) | [实现](reporting-period-hints-20261105/implementation-target-390.png) | [页面](reporting-period-hints-20261105/context-target-390.png) |

## 集成交接

无数据库迁移、公共契约、新依赖、API、worker 或费用变更；不依赖财务列更新 PR #901。仅交付本次 UI 改动，不触碰客户任务。

在统一本地测试版中，用合成原稿填写 2026 年 6 月末、目标填写 2025 年末，并上传名为“合成2026年半年度财务报表.pdf”的材料，核对两个就地提示及目标区域汇总。再分别改正原稿、目标期间，核对即时消失、保存恢复和既有执行行为。文件名没有明确期间时，本次功能不会发现仅存在于报表正文的较新期间。

最终统一验收待办：集成到固定版本后由用户操作验收；真实报表正文识别和真实财务生成效果不在本 UI 切片的验证结论内。统一发布 chat 按独立授权上线。
