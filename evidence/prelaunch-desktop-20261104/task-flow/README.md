# 桌面任务流修复验证（2026-11-04）

实现基线与本轮原型读取基线：`7f3c4ac77ef2128a5c9793bc31a20f2b8c84c9e5`。产品修复提交为 `ecfd757407a499026df487f2ab01486687ad860b`；截图和原聚焦测试采集于相同产品源码的提交前工作树。本记录不表示已部署或已获最终发布确认。

| 修复 | 已验证的合成场景 | 覆盖限制 |
| --- | --- | --- |
| P1 首稿无法继续修改 | 无历史原稿，清洁/修订版字节去重后同 ID；重新读取元数据后继续，保留准确 artifact/version/hash。准备后 hash 改变时不创建第二个 input/run；普通双 ID 续改仍通过。 | 真实 worker 首稿与真实 Word 内容未在本轮重新生成；输入依据路径仍需独立发布确认。 |
| P1 下载停滞锁住页面 | metadata、成果读取超时；忽略 abort 的读取仍释放调用方，流 reader 被取消，重试保留 hash 校验。QA 下载超时后历史与下载按钮恢复，能切换历史并离开页面，零新任务写入。材料/M4 不新增总时限，150 秒分块读取仍能完成；父级取消中止 pending reader 且可重试。 | 浏览器模拟 metadata 停滞；流体取消及材料/M4 慢读取由单元测试覆盖。未进行生产网络或真实 100 MiB 吞吐测试；ZIP 原有 20 分钟策略不变。 |
| P2 空项目入口导向错误 | update/review/generation/qa 四类空项目均返回本类准备入口；测试断言精确 href，零业务写入。 | 浏览器 fixture 验证前端路由，不代表服务端真实账号全链路验收。 |

实际命令与结果（Windows、Node v26.13.0、Edge，浏览器 HTTP 全部为 synthetic）：

```powershell
# 仓库根目录
npm exec tsc -- -p apps/web/tsconfig.test.json
# exit 0
node --test apps/web/dist-test/authoring-continuation.test.js apps/web/dist-test/api.test.js apps/web/dist-test/artifact-download.test.js apps/web/dist-test/download-progress.test.js
# 50 passed / 0 failed / 0 skipped
npm run build --workspace @bondbuddy/web
# exit 0；保留既有 Vite chunk 体积提示
git diff --check
# exit 0；无 whitespace error

# apps/web；独立 Vite 服务：npm run dev -- --port 5175
$env:BB_E2E_BASE_URL='http://127.0.0.1:5175'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npm exec playwright -- test tests/task-results.spec.ts tests/project-execution.spec.ts tests/project-qa-continuation.spec.ts --grep 'deduplicated first draft|an empty .* project|a stalled answer download|continuing after completion' --output .test-output/task-flow
# 8 passed / 0 failed，24.5s
```

补图使用临时 `tests/prelaunch-task-flow-evidence.spec.ts`（保留脚本快照于 `capture-desktop.spec.txt`，运行后从 tests 移除），同一 fixture 读取当前前端及本地静态原型：

```powershell
$env:BB_TASK_FLOW_EVIDENCE='C:\Users\lezhai\Downloads\Bondbuddy\prelaunch-desktop-20261104\evidence\prelaunch-desktop-20261104\task-flow'
npm exec playwright -- test tests/prelaunch-task-flow-evidence.spec.ts --output .test-output/task-flow-capture
# 最终 1 passed / 0 failed，9.1s
```

补图脚本中途曾因原型存在两个 `data-show=result` 按钮而定位失败；限定到原型状态栏后通过，未修改产品代码或原型。该辅助脚本断言静态原型未发起 API 请求；Vite 已停止，临时测试输出已清理。

所有新截图均为 **1440×960 viewport PNG**，已逐张查看；尺寸与 SHA-256 见 `screenshots.json`。

| 对照 | 原型位置与版本 | 同尺寸截图 |
| --- | --- | --- |
| 空任务入口 | `product-prototype/public/task-results.html`，本轮基线 `7f3c4ac77`；既有交接记录来源 `f8c68f51` | [原型](tasks-empty-prototype-1440x960.png) / [实现](tasks-empty-implementation-1440x960.png) |
| 问答结果与下载 | `product-prototype/public/qa-materials.html` 与 `qa-document.html`，本轮基线 `7f3c4ac77`；文档交付原型既有记录来源 `db30a93f79776a9093fec758b8ea27d82f49b017` | [资料/结果原型](qa-materials-result-prototype-1440x960.png) / [交付原型](qa-result-prototype-1440x960.png) / [实现](qa-result-implementation-1440x960.png) / [超时后实现](qa-timeout-implementation-1440x960.png) |
| 首稿继续修改 | `product-prototype/public/authoring-materials-entry.html`，本轮基线 `7f3c4ac77`；既有交接记录来源 `d6c2d7a2` | [材料区原型](materials-entry-prototype-1440x960.png) / [续改实现](first-draft-continuation-implementation-1440x960.png) |

对照结论：本次沿用原有材料区、底稿选择、任务空态链接、问答下载卡和状态提示位置，没有增添步骤或布局。任务列表的顺序、计数、时间及壳层余额入口，QA 的历史依据卡与静态展示壳，属于既有版本/合成场景差异。静态材料原型的动态摘要占位隐藏，未模拟首稿续改；静态 QA 原型未模拟超时，因此不能把原型截图当作这些功能通过的证据。新增超时提示和功能恢复由上面的真实前端自动化断言证明，未修改原型来伪造一致性。

本轮未覆盖手机、生产账户读写、实际付款、真实模型调用、真实 API/数据库/对象存储联调、Word 专业内容或客户端兼容性；没有用合成通过代替这些验收。

## 补充：首次问题清单被称为历史续答

主 agent 在线上新账号发现该提示后，本地使用空 runs、空 draft、无参考材料的 synthetic workspace 复现：首次上传后仅发送一次 `/qa/prepare`，识别出 3 题，页面却显示“已从指定历史任务准备下一轮”。修复前新增回归在该原文断言处失败，证实并非线上数据特例。

原因：`sourceRun` 同时记录新清单识别 ack 与历史回答续答，而 `draft()` 无条件显示历史提示。最小修复只在该渲染方法按 `sourceRun === prepared.run_id` 区分文案；新识别显示“已识别问题清单，尚未开始回答。请核对问题、材料和费用。”，历史回答来源保留原提示。自动识别、草稿、输入、收费和开始回答行为未更改。

`npm run build --workspace @bondbuddy/web` 通过。以下实际聚焦命令 7/7 通过，覆盖首次上传、历史续答、选择与明确开始、费用/版本拒绝后重试；随后补图并加强历史文案断言的最终两项复验 2/2 通过，不把重复执行累计为不同用例：

```powershell
npm exec playwright -- test tests/project-qa-continuation.spec.ts --grep 'a first question upload|1440: historical missing selection|all/missing shortcuts|explicit confirmation' --output .test-output/qa-first-upload
npm exec playwright -- test tests/project-qa-continuation.spec.ts --grep 'a first question upload|1440: historical missing selection' --output .test-output/qa-first-upload
```

新回归断言：首次上传仅一次 prepare、零 draft/answer POST；解析后显示 3 题与准确提示；刷新后提示正确且零重复写入。测试夹具补正空 runs 的首个 sequence 为 1，仅用于支持真实空工作区场景。

新增同尺寸对照：[1440×960 原型确认问题状态](qa-questions-prototype-1440x960.png) / [1440×960 修复后首次上传](qa-first-upload-implementation-1440x960.png)。原型为同一 `qa-materials.html@7f3c4ac77`，既有提示是“尚未开始回答，请核对问题、材料和费用”，修复与该语义一致。实现截图滚动到问题区以显示新提示；静态原型在内容页顶部，参考材料与壳层仍为既有合成场景差异。本轮未操作线上账号。

## 补充：原材料与 M4 下载总时限收窄

对 `ecfd757` 再次复核发现：既有 [底稿下载策略](../../../docs/acceptance/workpaper-download-batch-20261029.md) 的单文件 2 分钟、ZIP 20 分钟，并非原材料与 M4 文件原有的全局总时限。此前 `materialBytes()`、`m4ArtifactBytes()` 没有默认总时限；本轮把公共包装扩到这两者后，100 MiB 活跃下载在有效吞吐低于约 7 Mbit/s 时可能被 120 秒截止。这里是确定的时长/体量兼容风险，不声称已做真实大文件限速实测。

本次后续工作树只撤回两方法的新增 `boundedDownload` 包装，保留 `readDownloadBytes`、调用方 abort、MIME、非空/长度及 SHA-256 检查。`artifact()` 元数据与 `artifactBytes()` 的超时释放、QA 回归以及既有底稿/ZIP 策略均保留。材料/M4 长时间无数据时仍沿用离页取消，没有在此次补丁另行设计 idle 策略或界面。

新增 controlled-clock 回归使用真正的 `Response` / `ReadableStream`：每 30 秒送达一个分块，150 秒后完成，返回字节必须与已锁定 hash 对应的原字节完全一致。两种方法另各测试已读取部分内容后，父级取消会带原原因取消 pending reader、释放锁，且新请求可完整校验后重试。改写原先材料“120 秒必超时”测试，避免继续把错误作用域当作预期。

先保持 `ecfd757` 产品实现，仅执行新活动流测试，实际结果为 **0 passed / 2 failed**，两者均在 controlled 第 120 秒失败。移除两处包装后运行：

```powershell
npm exec tsc -- -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/authoring-continuation.test.js apps/web/dist-test/api.test.js apps/web/dist-test/artifact-download.test.js apps/web/dist-test/download-progress.test.js apps/web/dist-test/checkout-intent.test.js
# 69 passed / 0 failed / 0 skipped，944 ms；原先 66 项中的材料超时测试替换为上述 4 项
npm run build --workspace @bondbuddy/web
# exit 0，保留既有 chunk 体积提示
git diff --check
# exit 0
```

此处 build 采集于主 agent 后续修改 `review-workspace.ts` 的积分不足尾句之前；该后续一行提示由主 agent 单独验证。本节为源码/读取时长兼容修复，未改变页面、步骤、布局或提示文案，沿用上方同尺寸证据，不生成重复截图；未重新运行真实网络、生产账号或实际模型。
