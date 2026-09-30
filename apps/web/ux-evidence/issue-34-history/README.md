# #34 同项目 Word 版本目录 · 原型对照

原型：#85 `product-prototype/design-previews/update-workspace.fragment.html` 的 `completeView()` 与导出页 `product-prototype/public/previews/update-workspace.html`，head `46764161565027f332bdf28f8b335620bd035018`。原型截图保持该准确版本。实现基于 `develop@bd442bdd971abd4a4f8532d26c75c4f56cf9b3db`，代码 commit `73cb646097ea25974e87cddf2b383ea6970f1d95`，包括 #475 的持久消息区；对应 PR #474 仍为 Draft。

按 [产品负责人 2026-09-29 的反馈](https://github.com/ITSophiaXu/BondBuddy/pull/474#issuecomment-5894113011) 补齐同一“已完成”状态，并独立保留新任务失败仍能找回旧稿的场景。截图均为真实 Chromium 的同尺寸视口截图：桌面 1440×960、手机 390×844。HTTP、账号、材料信息和下载字节均为 **synthetic**，不是实际客户、模型、Blob、Word/WPS 或产品批准证据。

| 视口 | #85 原型已完成 | 实现已完成工作区 | 同完成态的历史目录 |
| --- | --- | --- | --- |
| 1440×960 | [原型](prototype-desktop.png) | [工作区](workspace-complete-desktop.png) | [目录](implementation-complete-desktop.png) |
| 390×844 | [原型](prototype-mobile.png) | [工作区](workspace-complete-mobile.png) | [目录](implementation-complete-mobile.png) |

| 独立回归场景 | 工作区 | 历史目录 |
| --- | --- | --- |
| 新任务失败，旧成功稿仍可下载 · 1440×960 | [失败态](workspace-failed-desktop.png) | [旧成果](implementation-failed-desktop.png) |
| 新任务失败，旧成功稿仍可下载 · 390×844 | [失败态](workspace-failed-mobile.png) | [旧成果](implementation-failed-mobile.png) |

两组实现同时保留右侧 #475 的用户消息保存与版本读取。成功场景保留原成果摘要/下载；目录不启动 execute/resume，不因新运行失败而清除旧成功稿。原型的助手演示不能替代尚未接通的真实 #18 助手；实现不伪造答复。

| 与 #85 原型的具体差异 | 原因与影响 | 产品确认 |
| --- | --- | --- |
| 在同一项目左侧成果/进度区下方增加独立“历史成果”卡 | #34 要求找回多个旧成功成果；无新增页面或导航，但这是原型没有的布局增量 | **未批准；需确认卡片位置与文案，保持 Draft** |
| 每行显示“项目资料版本 N 的成果”和完成时间 | N 是真实 input revision，不是项目成果 vN；不再同时显示文件版本、内部任务编号、“正式通道”或“已通过交付检查”。不会因每个新 run 的文件版本通常为 1 而误称项目成果版本相同 | 与上述卡片文案一起待确认 |
| 三件套行有下载修订版、清洁版、有效基线三个动作；有效基线为第三个次要按钮 | #85 原型只有修订/清洁下载；基线供对照，读下载仍有权限/hash 检查 | **第三个按钮的存在、位置和层级须单独确认；不当作原型已批准** |
| 内部测试稿保留“内部测试工作稿 · 未经专业审核 · 不得对外使用”；旧单件仅称 Word 成果 | 必要的使用边界提示，避免把测试稿、旧未分类成果当生产修订成果；删除后台通道/交付过程文案 | 与版本卡具体文案一并待确认 |
| 既有完成摘要和右侧消息区仍与 #85 演示有差异 | 是当前 develop 的 #34/#18 实现与真实能力边界；本次同状态截图展示实际差异，不把接口成功当 UX 批准 | #361/#18 继续分别验收，不据本目录解除 |

旧 `implementation-desktop.png` / `implementation-mobile.png` 留作此前失败态的历史记录，不代表当前代码或本轮已完成态对照。

复现（先启动来自本工作区的独立服务，避免复用其他工作区）：

```sh
npm run build
npm run check:contracts
npm run test:unit -w @bondbuddy/web
npm run dev -w @bondbuddy/web -- --port 5364 --strictPort
BB_E2E_BASE_URL=http://127.0.0.1:5364 BB_34_HISTORY_EVIDENCE_DIR="$PWD/apps/web/ux-evidence/issue-34-history" npm test -w @bondbuddy/web -- tests/artifact-history.spec.ts --output=/tmp/bondbuddy-history-web-results
BB_E2E_BASE_URL=http://127.0.0.1:5364 npm test -w @bondbuddy/web -- --reporter=dot --output=/tmp/bondbuddy-history-web-results
```

Linux / Node 22.23.3 / Playwright Chromium；全仓 build、contracts、Web 单元 43/43 通过，历史目录 Chromium 13/13 通过。完整浏览器结果在 PR #474 中回填。无 DTO、枚举、迁移、writer、计费或原型修改。工程验证和新截图均不能解除产品负责人明确要求的布局确认；#34 保持开放，#35 真实交付/下载与 #146 Windows WPS/Word 仍为独立验收。
