# D03：新一轮复核成果对应 Word 下载

2026-10-26，Windows / Node 24.22.1 / Edge / Playwright，桌面 1440×960。新增独立测试 `apps/web/tests/review-completion-download.spec.ts`，未改变产品源码、已有测试、共享 fixture 或配置。

## 补齐的证据

已有 `review-followup.spec.ts` 的补料连续旅程下载旧 V1 后仅打开新 V3；`review-result-continuity.spec.ts` 能下载直接注入的新 V3，但没有从补料、明确执行或免费导出走到新结果。此次两条测试把对应下载接在完整连续旅程后，补齐 D03 的“下载对应新成果”验证。

| 连续旅程 | 实际校验 |
| --- | --- |
| 原 V1 → 手动修改 → 保存处理结果并生成新版 → 明确查看最新 V3 → 下载新 Word → 刷新 → 返回旧 V1 下载 | 免费导出仅一次、没有报价或 AI 执行；固定 V1 run 与 editor hash；新 V3 清洁版和修订版的文件名、实际字节、SHA256、OOXML ZIP，及人工文字；旧 V1 的字节、元数据、原编辑快照不变。项目当前版本仍为 V2。 |
| 原 V1 → 补充复核要求 → 上传财务补料 → 明确开始复核 → 原请求对应 run 完成 → 查看最新 V3 → 下载新 Word → 返回旧 V1 下载 | 保存与补料均不执行；只一次完整复核报价和执行；要求、补料版本及 hash 固定进输入；完成的 run / execution_request_id 与原提交一致；新 V3 清洁版和修订／批注版的文件名、字节、SHA256 与 OOXML ZIP；旧 V1 仍原样可下载。 |

每条均实际下载顺序 V1 清洁版 → V3 清洁版 → V3 修订／批注版 → V1 清洁版，并断言授权下载使用对应 artifact 路径。新 V3 两个变体与旧 V1 各有不同字节，不能用旧文档或同名占位文件满足断言。

## 执行结果

**2 passed / 0 failed / 0 skipped，19.3 秒，退出码 0。** [完整日志](review-completion/playwright-2.log)。原始结果：`.local/review-completion/.last-run.json` 为 `status: passed`、`failedTests: []`。

工作目录 `C:\Users\lezhai\Downloads\Bondbuddy\ux-coverage-20261026\apps\web`，复用现有 5187 服务；显式使用原始 `playwright.config.ts`，独立输出，不覆盖根代理广泛回归报告：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5187'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
& 'C:\Program Files\nodejs\npx.cmd' playwright test --config=playwright.config.ts tests/review-completion-download.spec.ts --reporter=list --output ../../.local/review-completion 2>&1 | Tee-Object -FilePath '../../.local/review-completion.log'
$completionExit=$LASTEXITCODE
exit $completionExit
```

源码 / 测试 SHA256（2026-10-26 本次运行快照）：

| 文件 | SHA256 |
| --- | --- |
| `apps/web/tests/review-completion-download.spec.ts` | `147b5bb3403afb3179e183dda1c4fbaa66860d978245889353acd80ba95679a6` |
| 复用的 `apps/web/tests/review-followup-fixtures.ts` | `01bc3804c7a748813253be519b7b23bd191c5c8fd864f46f789ece40c3016949` |
| `apps/web/src/review-editor.ts` | `837628b1bd4329a3ea08cd30fad95e624db1d2455aba5bf1889c3de888c3aa0c` |
| `apps/web/src/review-workspace.ts` | `da74a7c5b547cdbb3a33034c1d0dff71f32649862dad8658ff63b8a4050c3d28` |

## Fixture 与首次运行修正

复用 `review-followup-fixtures.ts` 的 schema 校验、材料上传、草稿 CAS、报价、明确执行、历史与成果路由。仅在新测试文件补足合成服务的输出：为每一成果注册独立的真实 OOXML 字节与匹配元数据 / 目录 hash；免费导出的新编辑快照继承请求指定原稿并保存人工选择，原稿不变。新增下载路由只返回这些对应字节。

首轮两项因测试硬编码“下载修订版”而超时：没有正文修订时既有 UI 如实显示“下载批注版（无正文修订）”。同时本地免费导出快照最初未将人工已应用字段标为 `applied: true`。已仅在新文件修正 fixture 的应用状态，并使用真实公开按钮的修订／批注标签；未改产品行为。最终两项通过。

## 截图核对

- [免费导出后的 V3](review-completion/free-export-v3-1440.png)：1440×2138，1440×960 浏览器全页截图；显示正在查看 V3、1 项正文修订、修订／清洁下载按钮及已保存人工文字。
- [补料复核完成后的 V3](review-completion/supplement-completed-v3-1440.png)：1440×1931，1440×960 浏览器全页截图；显示正在查看 V3、清洁版及“批注版（无正文修订）”下载按钮、V3 独立事项和已提交浏览器下载状态。

已打开两张原图目视核对，版本说明、对应下载按钮及结果内容清楚可读。本次仅补测试与证据，界面沿用已存在的复核工作区与编辑器，没有页面、步骤、布局或导航变更。

## 合成边界

账号、材料、任务、Word 正文及完成回执均为 synthetic；浏览器真实运行产品入口与原生控件，HTTP 由允许的公共契约 fixture 模拟。任务完成由 fixture 显式推进，不证明后台 worker 或真实模型执行。最小 OOXML 证明版本和下载字节身份，不证明专业复核结论、完整 Word 排版、修订标记内容或 Word / WPS 桌面兼容性。本次未测试手机、真实账单、生产部署或原账号权限。
