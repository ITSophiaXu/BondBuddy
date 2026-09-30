# #361 预检拒绝与参考稿分类提示

依据 #361 的 2026-09-30 最新交接：已上传募集书的持久化角色可能为 `reference`，旧项目仍为 `update`。用户需要知道如何保留原文件更正分类及核验发行人，不能从通用 `INPUT_REQUIRED` 反复重试，也不能默认把所有参考企业改为本发行人。本切片覆盖原材料步骤的预检与执行失败提示；不实现或模拟材料更正、项目转换、身份批准。

原型为 `product-prototype/public/project-workspace.js`，commit `23fd64fa22185b21015684b885526bc4247e98cd`，布局沿用当前 develop 的原型迁移实现。参考截图使用同一原型源码、合成账号与材料页的“无历史稿”分支。实现代码 commit `b27245c`，以 `develop@391e006d9a12a8af17a3eecf5aeddecd06cbb2ff` 为基线；项目、HTTP 和文件信息均为 **synthetic**。

| 视口 | 原型材料页脚 | 实现预检拒绝 |
| --- | --- | --- |
| 1440×960 | [原型](bb361-errors-reference-materials-footer.png) | [实现](reference-role-desktop.png) |
| 390×844 | [原型](bb361-errors-reference-materials-footer-mobile.png) | [实现](reference-role-mobile.png) |

布局、阶段、材料分区、右侧消息区及“开始更新”的位置保持现有原型迁移。原型演示不触发真实身份预检，故两边比较同一材料页的错误落点，而非声称原型产生了相同错误。错误文案按 #361 已明确的分类交接补齐；“重新检查处理条件”复用 #388 的原位置，先读项目及最新输入并核对 revision/hash。同版本才预检原输入；新版本则刷新整个材料页、丢弃旧选择，要求用户核对后再次开始，不因重新检查新增输入、run 或模型请求。没有新增技术审核面板或确认表单；不读取材料正文，不按文件名推断所属发行人。

预检返回 `409 CAPABILITY_NOT_READY` 时仅表示材料或处理条件尚未就绪，不误称当前环境未开放更新；同版本沿同一输入重新检查，不重复锁定或提交。执行入口的未开放仍按执行响应单独提示。

旧输入恢复增量：合成浏览器把已拒绝的输入 v3 切到项目当前 v7，断言新历史稿材料在原分区出现、旧版本不再预检、未触发 execute/resume，且不提供从未知消息 pin 的恢复输入直接执行。项目和输入版本/hash 不一致时停在读取错误，不重试旧版本。恢复到失败的非生产测试 run 时，页面明确标示内部测试及新输入版本要求，不自动重放，也不呈现正式成果下载。页面仍使用上表同一原型材料页脚；[桌面失效输入状态](stale-input-desktop.png)与[手机失效输入状态](stale-input-mobile.png)均为合成数据下的新提示，按钮与材料区位置未变。此增量仅改变状态文案和读取行为，无原型页面或步骤偏离。

恢复竞态增量：手动刷新/恢复使之前的 run 轮询失效；恢复时先保存暂停原因，晚到的旧响应不覆盖新 run。若事件先于新状态到达，在新的 `event_cursor` 内重用匹配缓存，避免原因被旧状态清空后丢失。合成夹具同时更新公开 run 的事件游标，保持其状态/事件读回关系；原循环隐藏按钮与单 run/零额外执行的断言保留。定向等待、晚到响应、分页反复暂停及迟到 trial 事件 4/4 通过。

旧版本与测试任务补充：合成浏览器把被拒绝的输入 v3 切到当前 v8，并放入占用该版确定性 Web 请求键的失败 `non_production_test` run。重新检查只读取和恢复状态，既不执行也不继续该 run；用户看到“继续修改”后显式点击，保存 v9 输入，再点击一次“开始更新”，使用与 v8 不同的正式请求键且不带测试授权。截图为 [桌面失败测试任务](stale-test-run-desktop.png)与[手机失败测试任务](stale-test-run-mobile.png)。这证明浏览器合成路径，不代表真实项目已进行正式执行。

若重新检查完成时本地草稿已有未保存修改，页面停在现有版本冲突区，取消自动保存，并让用户复制需要保留的文字后显式加载服务端最新资料；旧草稿不会在刷新路由时覆盖新版本。对应 [桌面冲突状态](stale-dirty-desktop.png)与[手机冲突状态](stale-dirty-mobile.png) 使用同样的 1440×960 / 390×844 视口。与上方原型材料页相比，仍沿用原步骤、双栏和操作位置；新增内容只是失败测试任务及版本冲突的必要状态文案，无页面或导航偏离。项目、请求和任务数据均为 synthetic。

工程验证：Linux、Node 22.23.3、Playwright/Chromium；全仓构建及最终 Web 构建通过；`npm run check:contracts` 验证 156 个 synthetic 公共样例、12 个内部库样例、4 个数据生命周期样例、OCR v2 29/29 和发行人绑定 11/11；Web 单元 43/43；启动流程初轮 Chromium 31/31，后续增加上述预检等待回归。独立修复分支在冷启动服务上的启动/恢复、原型校正与事实组件 **42/42 通过、0 失败**。包含本修复的 #474 整合分支完整浏览器 **135 通过、15 个 opt-in 集成测试跳过、0 失败**。

```sh
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
npm run dev -w @bondbuddy/web -- --port 5361 --strictPort
BB_E2E_BASE_URL=http://127.0.0.1:5361 BB_361_START_EVIDENCE_DIR="$PWD/apps/web/ux-evidence/issue-361-start" npm test -w @bondbuddy/web -- tests/project-execution.spec.ts
BB_E2E_BASE_URL=http://127.0.0.1:5361 npm test -w @bondbuddy/web -- --reporter=dot
BB_UX_EVIDENCE_DIR=apps/web/ux-evidence/issue-361-start BB_UX_EVIDENCE_PREFIX=bb361-errors node apps/web/scripts/capture-prototype.mjs
```

完整尝试曾被 SIGTERM 中断，未作为通过证据；历史目录分支完整回归曾在既有分页恢复场景失败（其余 129 通过、15 跳过），据此补齐上述事件/状态竞态。最终完整回归在固定代码、冷启动工作区重新执行。预检 501 保留运行能力未开放的含义，409 才显示等待；热更新导致事实组件 ApiError 模块不一致的尝试不作通过证据，冷启动复验通过。首次使用默认 5173 端口时误用了本机旧工作区的开发服务，出现 4 项失败并中断，不能用于判断本修复；后续全部验证使用从本工作区新启动的独立 5361 服务。新回归覆盖预检阶段的真实 HTTP 409 形状、执行过滤之外仍可见的参考稿、更新/新稿文案区分、同一锁定输入重查、条件解除后一次 generation 提交，以及刷新恢复。

剩余工作：#35 的材料分类更正与发行人审核、既有项目的显式安全转换、批准绑定的浏览器引用，以及同一用户原项目的部署/连续复测；#18 的助手回复与 #34 的完整 Word 交付仍分别待验。本证据不代表真实模型、PG/Blob、用户原材料修复、Word/WPS 或产品逐项验收；#361/#384 保持开放。
