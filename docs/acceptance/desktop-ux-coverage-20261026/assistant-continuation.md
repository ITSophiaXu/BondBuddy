# BondBuddy 桌面成果续改验收

2026-10-26，Windows / Node 24.22.1 / Playwright / Edge，1440×960。

**最终快照：21 项全部通过。** 含同项目原稿信息保留回归；下述截图、日志和 SHA256 对应最终冻结源码。此结论限于本地合成浏览器验收。

## 行为与范围

- 从已完成更新任务选择“继续修改”，先核实唯一原任务成果、公共成果 pin、授权元数据及 Word 可下载状态，成功后固定该清洁版并打开原有准备表单；选择本身只保存草稿。
- 缺失或歧义成果、错误项目 / 版本 / hash / run、不可下载状态、非 Word 或修订版冒充清洁版，以及项目或元数据 GET 失败，均保留此前底稿、未发送文本和草稿，不创建确认卡、不执行任务。
- 读取过程中切换原卡、新对话或编辑新草稿，迟到响应不能覆盖新意图。
- 跨项目旧任务恢复正确的项目和材料上下文，刷新后仍固定原成果；准备确认只引用原项目材料，等待明确执行。
- 材料生成经过原成果选择、确认卡、明确执行、同一 run 的完成状态和 Word 下载。下载实际取得合成 DOCX 字节，并核对文件名、SHA256、ZIP 签名和恰好一次执行请求。复核保留已有准备流程，不要求 Word 编辑底稿。
- 同项目续改保留已保存到助手草稿的原发行人、企业关系、市场和报告期信息；仅跨项目切换时采用对应原项目的信息，不被服务器的旧字段静默覆盖。

## 产品与原型依据

[全站 BondBuddy 决定](../../product-decisions/2026-10-08-global-project-assistant.md) 的“用户体验”要求选定已完成成果的清洁版作为续改底稿、明确确认卡执行、保留未发送文字及后继草稿；其中 2026-10-12 的用户确认要求右侧全高侧栏、工作区并排、右上角双箭头收起。[已批准侧栏验收](../../../apps/web/test-evidence/assistant-notion-sidebar-20261012/README.md) 记录原有布局与同尺寸对照。

本次沿用 `product-prototype/public/project-assistant-refined.html` 的侧栏和工具栏，以及 `assistant-conversations.html` 的任务确认 / 成果续改流程。原型文件最后提交为 `846fafa68c830d941c663422e1d207d9ec77d3f3`；本地基线 HEAD 为 `50bd3dfbdec8588296d035587bb9387a1414a91a`。本切片修改成果校验与上下文恢复，没有改动助手 CSS、原型、页面布局或新增导航，不引入新的产品交互设计。

## 同尺寸截图审阅

以下三张原图均为 1440×960，已实际打开逐图检查。原型展示已批准的静态欢迎状态；实现展示合成任务及续改状态，属于侧栏结构核对，不声称是相同业务数据的逐像素对照。

| 截图 | 来源与核对结果 |
| --- | --- |
| [原型侧栏](assistant-continuation/prototype-shell-1440.png) | `product-prototype/public/project-assistant-refined.html`，文件提交 `846fafa68c830d941c663422e1d207d9ec77d3f3`。保留已批准的右侧全高面板、工具栏、项目入口和底部输入区。 |
| [准确原成果续改](assistant-continuation/assistant-continuation-original-1440.png) | 实现 `apps/web/src/project-assistant.ts`，以下最终快照 SHA256 `52d4b853…31f7f5`。可见“原任务清洁版 · V1”、原有任务核对表单、“尚未开始任务”的状态说明，以及保留的未发送文字。 |
| [缺失原成果](assistant-continuation/assistant-continuation-missing-1440.png) | 同一实现快照。原先选中的 V2 及未发送说明仍在；明确提示无法唯一确认原成果、尚未准备新的修改任务，没有误开准备表单。 |

目视检查：主工作区与助手继续并排；顶部标识、项目 / 成果选择器、任务卡、核对按钮、状态说明和输入区可读且不重叠。续改表单使用原有侧栏滚动区域。与静态原型的差异为实际主页面背景、成果 / 任务内容和滚动状态，未发现本切片新增布局偏离。

## 自动化结果

**21 passed / 0 failed / 0 skipped，1.3 分钟，进程退出码 0。** 完整日志：[playwright-21.log](assistant-continuation/playwright-21.log)；[原始结果](assistant-continuation/last-run-21.json) 为 `status: passed`、`failedTests: []`。

| 覆盖组 | 项数 |
| --- | ---: |
| 准确选择原成果，仅保存草稿 | 1 |
| 缺失、歧义、无效版本、跨项目、同成果多任务 | 5 |
| 元数据 run / 版本 / hash / 下载状态 / MIME / 清洁版校验 | 6 |
| 项目与成果元数据 GET 失败 | 2 |
| 跨项目上下文、刷新及原材料准备确认 | 1 |
| 同项目已保存原稿信息保留，不借用服务器旧字段 | 1 |
| 材料生成连续旅程及 Word 实际下载 | 1 |
| 迟到响应不覆盖新的任务 / 对话 / 草稿 | 3 |
| 已有复核准备流程 | 1 |

执行工作目录：`C:\Users\lezhai\Downloads\Bondbuddy\ux-coverage-20261026\apps\web`。复用根代理的 Vite 5187，显式使用原始配置与独立结果目录。具体命令：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5187'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_UX_COVERAGE_EVIDENCE_DIR='C:\Users\lezhai\Downloads\Bondbuddy\ux-coverage-evidence-20261026\assistant-continuation-final'
& 'C:\Program Files\nodejs\npx.cmd' playwright test --config=playwright.config.ts tests/assistant-continuation.spec.ts --reporter=list --output ../../.local/assistant-continuation-final 2>&1 | Tee-Object -FilePath '../../.local/assistant-continuation-final.log'
$continuationFinalExit=$LASTEXITCODE
exit $continuationFinalExit
```

测试使用正式 `ArtifactResponse` schema 与日期格式注册校验合法元数据 fixture，并验证确认卡、M4 草稿及执行请求的公共 schema。错误 fixture 在各异常用例中显式改变。

### 同项目原稿信息回归

[修复前日志](assistant-continuation/same-project-source-before.log) 实测失败：已保存的原发行人、关系、市场及 2024 年母公司口径被服务器旧的 2025 年合并口径覆盖。[修复后定向日志](assistant-continuation/same-project-source-after.log) 为 1 passed；最终 21 项再次通过该回归。修复仅在跨项目或尚无保存信息时重置原稿信息，没有新增流程或收费动作。

## 已执行快照 SHA256

源码和测试在最终 21 项运行前后均核对一致；[最终文件快照](assistant-continuation/final-snapshot.json) 保存实际采集时间与完整 SHA256。

| 文件 | SHA256 |
| --- | --- |
| `apps/web/src/project-assistant.ts` | `52d4b853c592737e4ec4b051a1e2b9010c96a1dd34d2abfebd0a5316b231f7f5` |
| `apps/web/tests/assistant-continuation.spec.ts` | `37bd2a04cae635e3777aeb3f9c2a9bbe6ad109ed2ef1a69bfecbce558cfacac9` |
| `product-prototype/public/project-assistant-refined.html` | `cc7479eaaeca0edd217ed19b0f4a23a1506b91a3c1f7a7a45310a235634264d8` |
| `docs/product-decisions/2026-10-08-global-project-assistant.md` | `ce2062e6507e6cd73a1f79a8ddd8242a99adfcfa929ccefedd66d361f04157bd` |

## 限制

全部账号、项目、材料、API 响应、任务状态和 Word 正文均为 synthetic；使用浏览器路由模拟服务，不代表真实模型调用、服务器归属校验或真实账单扣费。下载证据证明浏览器链路与合成字节一致，不代表债券内容审核、专业签认或 Word / WPS 客户端兼容性验收。此次只验收桌面，本切片不包含手机优化、生产部署或原账号验收。
