# 编制开始后的材料只读提示（2026-10-08）

关联 #361。用户指出开始编制后不能更新材料，而“随时查看与补充”会误导用户。本次直接采用该要求：开始前明确补齐时限；任务提交后，材料区和任务入口统一改为只读查看。沿用现有“继续修改”进入下一轮的流程，不新增页面或执行步骤。

实现源码 commit：`b321fc345f9df6f2f093d862ea12d5d3d6a3ba8b`，最终基于 develop `bd9dd010`（相比最初验收基线 `b296aa1a` 新增 Docker 上下文检查和账号侧栏显示修复；材料区逻辑未变化，合并前重新构建并复验关键场景）。原型对照采用该基线的 `product-prototype/public/project-workspace.js`，其最近修改 commit 为 `5b8de087984438b9729adb710b79cdc534d915ce`。本次未修改原型。

| 状态 | 桌面 1440×960 | 手机 390×844 |
| --- | --- | --- |
| 基线原型材料页 | [原型](prototype-desktop.png) | [原型](prototype-mobile.png) |
| 开始编制前 | [实现](preparing-desktop.png) | [实现](preparing-mobile.png) |
| 编制中展开材料区 | [实现](running-desktop.png) | [实现](running-mobile.png) |
| 显式继续修改 | [实现](next-version-desktop.png) | [实现](next-version-mobile.png) |

逐屏核对：

- 保留现有创建／材料步骤、四类材料分区、刷新和页尾开始按钮的位置。开始前新增“请在开始编制前补齐材料；开始后材料锁定，仅可查看”。
- 编制开始后，折叠栏显示“材料已锁定，仅可查看”，展开标题改为“查看项目材料”，任务按钮改为“查看材料”。隐藏上传引导、文件选择及删除入口，禁用原稿信息修改；细分类别折叠栏改为查看措辞。
- 运行、暂停、等待输入以及已结束但尚未点击“继续修改”时均保持锁定。刷新材料或重新打开页面后仍只读。读取材料列表的刷新入口保留。
- 任务结束并点击现有“继续修改”后才恢复下一轮编辑，说明新材料用于下一轮，旧任务输入及已有成果保留。
- 基线原型没有在同一材料区表达运行后只读状态；本次状态提示及控件可用性偏离由本会话用户于 2026-10-08 的明确要求确认。侧栏、积分入口、已保存材料及原稿信息的其他差异是现有迁移差异，不在本次变更范围。
- 已查看桌面和手机截图，标题及状态正常换行，无横向溢出。

验证环境：Windows、Node 22.14、Edge、独立 Vite 端口 5597。API、文件与账号均为 **synthetic**，没有真实模型调用、上传客户材料或计费。

- `npm run build`、`npm run check:contracts` 通过。契约检查包含 167 公共样例、12 内部样例、4 生命周期样例、29 OCR 用例和 11 发行人绑定用例。
- `project-execution.spec.ts`、`project-conversation.spec.ts`、`data-policy.spec.ts` 共 69 项：首轮 67 通过；两项旧夹具／断言修正后分别通过复测（补 `/m4/topics` 空列表，更新失败状态的旧文案断言）。
- `upload.spec.ts` 14/14 通过，无跳过。上述 83 个不同场景均获得通过结果。
- 新锁定场景覆盖运行、暂停、等待输入、取消、材料列表刷新、页面重新打开，以及下一轮显式恢复；文件选择迟到事件、拖放、原稿修改和删除事件不会发出写请求。当前 `unified_v1` 页面复测通过并生成最终截图。
- 变基到最新 develop 后，锁定完整流程、旧 generation 项目恢复、补充要求分页及新版输入、完成后继续修改四个关键场景再次运行：4/4 通过。
- 初次新测试使用 Playwright `toBeDisabled()` 检查 fieldset，但该断言不支持 fieldset；改为检查其 `disabled` 属性及实际输入控件。没有为通过测试放宽页面限制。

本次只调整浏览器交互，未修改 API、公共契约、数据库、任务状态机或已有不可变输入机制。线上部署及真实项目验收分别进行。

复现命令（在 `apps/web` 下设置 `BB_E2E_BASE_URL=http://127.0.0.1:5597`、`BB_E2E_BROWSER_CHANNEL=msedge`）：

```text
node ../../node_modules/@playwright/test/cli.js test tests/project-execution.spec.ts tests/project-conversation.spec.ts tests/data-policy.spec.ts
node ../../node_modules/@playwright/test/cli.js test tests/upload.spec.ts
```

设置 `BB_MATERIAL_LOCK_EVIDENCE_DIR=../../apps/web/test-evidence/material-lock-20261008` 后，新增锁定测试会保存三种状态的同尺寸实现截图。
