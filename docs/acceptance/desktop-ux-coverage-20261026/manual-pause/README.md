# 人工暂停与充值定向验收（2026-10-26）

本次修复已批准规则的前端偏差：用户人工暂停与积分耗尽同时存在时，页面仍承诺“到账自动继续”；M4 在余额恢复后还可能因旧耗尽标志保留而缺少继续入口。现统一过程卡、充值弹窗与充值页说明，并在服务端确认暂停且余额恢复后提供明确继续动作。仅修改前端六个模块，不增加后台、公共协议或费率。

依据为[10/11 动态积分决定](../../../product-decisions/2026-10-11-authoring-dynamic-balance.md)、[M4 动态过程决定](../../../product-decisions/2026-10-13-material-dynamic-progress.md)和[复核过程决定](../../../product-decisions/2026-10-13-review-live-workflow.md)：仅因耗尽暂停的已受理动态积分任务，在真实到账后可恢复同一任务；人工暂停优先，到账不能越过手动继续。未开始的新任务仍需明确开始。

双标志并存是可达状态：积分耗尽后，用户可在另一页请求人工暂停；也可能先人工暂停、在当前调用保存前耗尽余额。余额恢复并不等于人工暂停取消，也不保证旧 `credit_exhausted` 标志立即清除。运行中仍等待保存检查点，确认已暂停且有余额后才开放继续；点击继续沿原 run 和原输入，不创建第二任务。

## 采用证据

Windows、Node 24.22.1、Playwright / Edge，桌面 1440×960；真实前端、受控合成 HTTP/任务/余额。当前源码与测试哈希见 [sources.json](sources.json)。

构建日志仅去除行末空白，原始输出保留在本机 `.local/manual-pause-build-final4.log`。

| 证据 | 最终结果 | 证明范围 |
| --- | --- | --- |
| [进度单元日志](unit.log) | authoring-progress **7/7** | 人工暂停优先于自动续跑说明，涵盖保存中、已暂停及到账后旧耗尽标志仍存在 |
| [桌面定向日志](browser-final2.log) | **11/11，34.2 秒** | billing-navigation 5 条、M4 2 条、编制 2 条、复核 2 条；保留仅耗尽自动恢复分支，验证人工暂停提示、已开弹窗更新、充值导航、到账后保持暂停和原任务继续入口；三类过程页均覆盖到账但仍在保存时不提前开放继续 |
| [web 构建日志](build.log) | 通过 | TypeScript 与 Vite 构建；仅已有 bundle 大小提示 |
| [提案 QA 记录](prototype-qa.json) | **3/3**，独立 HTML | B 报价待定时不能借未知回执继续或完成；历史 A 切回 B 会清除采用与在途演示，旧状态刷新也不能绕过；仅在明确标为未被用户选择的历史 A 中演示保存/采用分开、未知采用只读恢复 |

编制新用例核对同一 run、原输入不变、一次执行，明确继续前无控制请求；M4 核对余额恢复后旧耗尽标志保留仍可手动继续，执行数仍为一次。复核用例核对已开弹窗在人工暂停到达后原地更新，到账后仍是原暂停任务且没有隐式控制/新执行请求。充值页用例核对新任务、普通耗尽恢复和人工暂停三种说明及准确返回位置。

最初有效红例为单元 6 pass / 1 fail、桌面 1 fail，证明错误自动续跑提示。修复验证还遇到新回执 fixture 缺 `accrued_points`、编制/复核截图测试缺 `node:path` 的 `join` 导入，以及首轮 11 条中的 1 条充值 fixture 将 refresh 路径误当订单 ID（10 pass / 1 fail）。这些测试前提已修正，产品断言未削弱；中间轮 11/11 后又补齐三类页面的保存中/持久暂停边界断言，最终采用上表 34.2 秒结果。原始失败与过程产物保留在本机 `.local/`，不写成全部首次通过。

定向桌面命令从 `apps/web` 运行，选集为上述 11 条，并非整套历史 662 项：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5187'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test --config playwright.config.ts project-execution.spec.ts m4-workspace.spec.ts review-workspace.spec.ts billing-navigation.spec.ts --grep 'desktop manual pause|desktop funded material|desktop review recharge|review live progress|dynamic balance:.*1440|dynamic material progress.*1440px|recharge order keeps|associated-file recharge|authoring recharge|topic-only wallet|external recharge' --workers 2 --output ../../.local/manual-pause-final2 --reporter=list
```

提案独立 QA 从仓库根目录运行 `node docs/acceptance/desktop-ux-coverage-20261026/manual-pause/prototype-qa.mjs`，脚本见 [prototype-qa.mjs](prototype-qa.mjs)。产品定向 11 条通过后只修正了独立 HTML 的费用演示边界；[sources.json](sources.json)分开记录产品验证源码与最新原型/QA 脚本哈希，不把原型修改视作产品验证。

## 截图与操作提案

- [编制到账后保持人工暂停](authoring-manual-after-topup.png)
- [M4 到账后明确继续](material-manual-after-topup.png)
- [复核到账后保持人工暂停](review-manual-after-topup.png)
- [提案：B 已选，报价规则待定](proposal-fee-pending.png)
- [提案：最新补料演示成果](proposal-latest-supplement.png)
- [提案：未知采用只读恢复](proposal-recovered-adoption.png)

[暂停补料续做 HTML](../../../ux/prototypes/pause-supplement-resume.html)是 proposed/synthetic 操作提案，默认说明用户已选 B“必要重做另行报价并确认”、具体报价规则待定，因此补料采用按钮禁用。完整采用交互只在明确标为“用户未选择”的历史备选 A 下演示；不能将其价格封顶示例当成 B 的报价规则或费用确认。三个 `proposal-*.png` 和 3/3 QA 只证明独立 HTML 的演示交互，不能证明已实现后台采用新输入、真实上传、模型处理、费用账本或最终 Word。

## 边界

历史 `4cd1c39` 的 15/15 旅程与 662 pass 保留原证据范围，本次未整体重跑，也不与 7/11/3 相加。本次没有真实支付/账本、PG/worker 或新材料同任务续做验收。G03 / UX-A03 仍为 `functional_gap` / `design_gap`，新输入续做产品测试仍 `not_run`；补料重做采用 B 另行报价确认，追加价格公式仍待确定，详见[审计与设计草案](../../../ux/pause-supplement-resume-20261026.md)。整体目标保持 active，不宣称达到整体 90% 或主要功能全部覆盖，不发布。
