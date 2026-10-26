# 按原任务保存补料准备：专项验收

日期：2026-10-26。工作分支 `codex/desktop-ux-coverage-20261026`，起点 `39acc709`。本次为 G03 / UX-A03 的准备切片，原完整目标仍为 active；没有将准备保存认作新输入采用或完整同任务续做，也没有发布。

M1 编制/更新、M3 复核、单份 M4 文书的暂停页接入同一补料面板。原文件上传、补料草稿保存和任务采用明确区分：本次实现前两者，采用按钮因 B 的追加计价规则待确定而禁用。普通继续明确使用原材料，有本机或已保存补料时必须确认排除；未核实的原保存回执不能绕过。

## 采用证据

Windows、Node 24.22.1、PostgreSQL 16.14、Playwright / Edge，桌面 viewport 1440×960。数据、文件、会话和受控 HTTP 均为 synthetic；数据库事务与 HTTP session/CSRF 中间件是真实实现。源码及测试哈希见 [sources.json](sources.json)。

| 证据 | 最终结果 | 范围 |
| --- | --- | --- |
| [补料 PG/HTTP](backend-final.log) | **37 pass / 0 fail / 0 skip**，14.430 秒；含父/子测试统计 | 真实 session/CSRF、owner/project/hash/role、固定输入、M1 无历史稿、M3 快照、M4 跨项目原 pin、CAS/并发/准确请求回执、run 锁上的未知回执读取、暂停安全、outbox 回滚、不可变回执及草稿不 pin bytes |
| [桌面组件](browser-final.log) | **16/16**，32.1 秒 | 三实际生产组件上传→保存→刷新→原材料确认→同一 run resume；新增/替换、CAS 两选择、上传完成回执丢失、未知保存恢复、错回执拒绝、旧 GET 不回退新版本、已确认保存后最新读取失败保留事实、离开 owner/run 后迟到回执隔离 |
| [原任务/队列回归](regression.log) | **10 pass / 0 fail / 1 skip**，26.227 秒 | 原 run 七项身份和输入保护、正常进度及原执行请求重放、既有 issuer source 恢复边界；skip 为未配置 Azurite 的原队列全流程用例 |
| [原人工暂停桌面回归](old-manual-final.log) | **11/11**，38.3 秒 | 保留既有人工暂停/耗尽/充值说明和原任务继续断言；只为新只读接口补充严格的合成 fixture |
| [contracts](contracts-check.log) | 177 个合成样例 + 12 个内部样例、生命周期样例、OCR 与发行人绑定检查通过 | 本次新增 6 个准备样例，包含拒绝采用/追加费用字段和无准确 pin 的替换；OpenAPI GET 回执参数、PUT Origin/CSRF、认证和 preparation-only 标记 |
| [API 构建](api-build.log)、[web 构建](web-build.log) | 通过 | web 仅既有 bundle 大小提示；新浏览器 harness 的 TypeScript 检查也通过 |

补料测试以已存在的 10,000 积分账户及流水为基础，保存前后逐行比较 run、job、所有输入、项目、M3/M4 草稿与执行快照、调用记录、进度事件、积分账户/批次/预留/流水及余额。允许的变化只有补料准备 revision 与明确的 `run.supplement_draft_saved` outbox，不产生工作队列或收费。准备引用不加入 `bb_material_bytes_pinned`；文件仍服从现有生命周期。

隔离库模板保持 run/draft 均为 0，测试克隆均已清理，见 [database-final.json](database-final.json)；测试 PostgreSQL 已停止。浏览器本轮前后 9 个相关文件哈希未变，见 [browser-source-check.json](browser-source-check.json)。

## 截图与提案对照

本轮直接查看了下列三处真实组件、全局产品 CSS 的截图；页面外壳为测试合成，不能冒充完整 main 导航页面的逐屏验收。各 viewport 图均为 1440×960，full 图保留页面上下文。检查无水平溢出，文件入口/用途/类别可操作，保存事实与“尚未采用”可读，采用按钮保持禁用。

| 画面 | 同尺寸截图 | 全页 |
| --- | --- | --- |
| M1 暂停后的已保存准备 | [viewport](m1-saved-preparation-viewport.png) | [full](m1-saved-preparation.png) |
| M3 暂停后的已保存准备 | [viewport](m3-saved-preparation-viewport.png) | [full](m3-saved-preparation.png) |
| M4 暂停后的已保存准备 | [viewport](m4-saved-preparation-viewport.png) | [full](m4-saved-preparation.png) |
| 既有独立 HTML 提案，B 默认待定价 | [viewport](proposal-saved-viewport.png) | [full](proposal-saved.png) |

对照来源为 [暂停补料 HTML](../../../ux/prototypes/pause-supplement-resume.html) 在起点提交的原样版本，哈希见 sources；本次未修改该提案或历史截图。两者都使用原任务材料区、保留原材料、显示补料未采用、原材料继续单独确认，并在 B 报价未定时禁用采用。实现新增可用的文件选择、明确的新增/替换意图和独立“保存补料草稿”按钮；原提案只模拟保存，没有实际草稿协议。本轮没有实现提案后续的采用、重做范围、处理进度或成果演示。该对照记录本地准备切片，未把差异记为产品负责人签认或合并许可。

## 复验与过程记录

从仓库根目录运行 `node docs/acceptance/desktop-ux-coverage-20261026/supplement-preparation/verify.mjs test`，需本任务本机隔离库模板已迁移至 0118；`regression` 运行原任务/队列回归。脚本剔除继承的 BB_/DATABASE/AZURE/OPENAI/DEEPSEEK 环境，只指向本机专用端口，未访问生产数据库或供应商。迁移只新增 0118，原输入保护 0117 未改。

桌面组件命令从 `apps/web` 运行，使用现有本机 Vite 服务：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5173'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_SUPPLEMENT_EVIDENCE_DIR=(Resolve-Path '../../.local/supplement-preparation/screenshots').Path
node ../../node_modules/@playwright/test/cli.js test --config playwright.config.ts run-supplement-draft.spec.ts --workers 1 --output ../../.local/supplement-preparation/browser-results --reporter=line
```

首次 API 构建发现 TypeScript 收窄及测试 headers 推断问题，修复后通过；首次 PG 为 36 pass / 1 fail，合成 material object_key 不符合既有删除 tombstone 约束，改为准确 owner/project 路径后 37/37，再补非空账本证据后的最终结果仍为 37/37。未关闭触发器或削弱校验。

浏览器最初默认 Chromium 不在本机；改用已安装 Edge 后首轮 10 pass / 1 fail 为测试等待原回执 GET 的竞态，随后 13/13。后续 14 条中 12 pass / 2 fail 是动态 harness 在 Vite HMR 下产生两份 ApiError 类，真实 409 被测试图误认；统一静态模块图后 CAS 2/2，通过后又加入独立审阅发现的产品迟到 GET 修复和回归。最终 16/16；新增 harness 必填构造回调修正后 TypeScript 与最终浏览器选集再次通过。准确过程见 [browser-first-record.md](browser-first-record.md)、[browser-intermediate.log](browser-intermediate.log) 与 [browser-cas-harness.log](browser-cas-harness.log)，首次未保存 stdout 的轮次只留事实记录，不伪造原始日志。

原人工暂停选集首轮为 8 pass / 3 fail：旧 M1 fixture 将新增 GET 误匹配成 Run DTO，M4 返回 404，导致原材料 resume 的安全核对无法完成。四个既有 fixture/测试文件补充经公共 schema 验证的 revision 0 空准备响应后，原断言保持，最终 11/11；新 PUT 与准确请求回执仍不由旧 fixture 模拟。命令沿用[前次 11 条选集](../manual-pause/README.md)，本次本机地址为 5173、Edge、2 workers，日志单独保存，TypeScript 检查通过。

复制到本目录的文本日志仅统一换行、去除行末空白及末尾空行；原始输出仍在本机 `.local/supplement-preparation/`。未将不同轮次或合成原型的通过数相加。

## 未完成范围

本次未进行真实 Blob/供应商/支付调用、补料后的版本化执行、追加报价与账本结算、新输入成果或最终 Word 连续验收。HTTP 上传在浏览器为受控状态演进，PG 用例使用合成材料元数据；不能把这两类测试拼成真实上传至新 Word 的端到端证明。历史 15/15 旅程、662 pass 和前次 run-origin 34 pass 保留原范围，本轮没有整体重跑。

后续仍需明确 B 的追加价格基准，再完成版本化采用、执行租约与检查点隔离、旧调用复用与必要重做、准确成果及材料生命周期、追加账本、授权和同任务全旅程。G03 仍有 functional_gap / design_gap，新输入续做测试仍 not_run；完整目标尚未达到主要功能全部覆盖。
