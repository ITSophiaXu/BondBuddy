# M4 工作区同尺寸原型／实现对照

本组证据使用 owner-scoped **synthetic HTTP fixture** 和 Edge 浏览器。未访问生产站点、未登录真实 API，未验证 PostgreSQL、Blob、Codex CLI、真实积分结算或 Word 内容。真实后端验收不由本组截图证明，另见上级实施验收记录。

实现来自 `m4-core-20261006` 工作区，基线 commit 为 `3725dd53b1504d7fd8e45b37c3b55252490d3b89`；前端实现 commit 为 `c51821d`（本地未推送）。原型为用户已确认的 `bondbuddy-artifact-workspace.html` schema 6，SHA-256 `AA15F4E7C517F893019E60CF546F6163A63620FC47287BB037172ED653D7A94A`。测试读取准确原文件，未重写原型；其本机宿主只提供可保存的演示 widget state。

三个场景均按相同 viewport 生成：桌面 1360×900，窄屏 390×844；PNG 为 full-page 截图，页面高度随内容变化。每张均检查无横向溢出。原型使用自身标明为示例的材料、制作与推进步骤控件；实现使用合成接口保存的草稿、任务状态与正文。

| 场景 | 实现文件 | 原型文件 |
| --- | --- | --- |
| 材料准备 | `implementation-preparation-{1360,390}.png` | `prototype-preparation-{1360,390}.png` |
| 正在制作 | `implementation-making-{1360,390}.png` | `prototype-making-{1360,390}.png` |
| 成果正文 | `implementation-artifact-{1360,390}.png` | `prototype-artifact-{1360,390}.png` |

保留现有侧栏、页面头、材料分区、工作区成果标签及常驻助手；窄屏连续排列工作区和助手。先选文种再出现正式材料输入，问答直接在助手完成，执行按钮旁保留“与助手讨论”。制作页显示固定输入，助手显示服务端任务状态；完成时同一制作标签转为成果正文。

本轮视觉走查修复了参考材料 checkbox 的尺寸与标签位置，已固定来源／已选模板不再成为可取消的参考材料选项。主成果、制作说明、标签与续改按钮使用持久 `revision_number` 表示“第 N 稿”；真实 `artifact_version` 留在准确引用详情，不将新 artifact 的 V1误当第一稿。来源材料仍显示其真实材料 V版本。终态优先于旧执行 stage，开始提示在完成后改为成果可查看和下载。

M4 收敛后的预期差异：首发只有立项报告、普通私募摘要；其他文种和品种归 M5。私募摘要无需强制券商模板。实现显示真实接口的授权引用、版本／hash、保存冲突及按配置报价，原型只提供示例状态；两边合成企业名和文件正文也不相同。这些截图不宣称逐像素一致或真实文书验收。

复核消息明确采用为准确报告的更新要求后，通过现有 `revision-plan` 持久保存，保留同报告已选／排除事项；另一报告已有计划时不覆盖。跨业务采用固定来源时，先调用 owner-authorized canonical binding，再复制准确文件及保存输入；绑定失败不采用，不创建任务／扣费。无固定来源仅保存原意图并明确显示“尚未绑定募集书来源”。

复现（PowerShell，从仓库根目录执行）：

```powershell
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_M4_EVIDENCE='../../docs/acceptance/m4-workspace-20261006'
$env:BB_M4_PROTOTYPE='<已确认 schema6 原文件的本机绝对路径>'
npm run test --workspace apps/web -- tests/m4-workspace.spec.ts -g 'synthetic M4 same-size'
```

构建和测试：最终 web build 通过；web unit 83/83 通过。M4＋复核浏览器全量运行共64项：61通过、1个 checkbox 高度断言失败、2个独立旧原型截图任务按环境开关跳过。补齐继承的 `min-height` 后，失败项与最新12张截图重新生成合计2/2通过；这组62个执行用例已全部通过，2个旧截图任务继续有意跳过。随后新增 `PROJECT_RUN_ACTIVE` 安全文案及互斥 browser 负例，定向1/1通过：输入及未发送文字保留，其他任务结束后不会自动启动，重新明确确认才执行。本轮合计63个执行用例均已验证。截图用例本身验证了三场景两尺寸的无横向溢出及 exact schema6 原文件 hash。

Root 于本轮目视复验最新 `implementation-preparation-1360.png` 和 `implementation-artifact-390.png`，确认小 checkbox／来源不重复、终态提示和持久稿次修复通过。该结论只针对本组 synthetic 截图，窄屏仍使用工作区在上、助手在下的连续排列；不表示真实后端、专业内容或 Word 验收完成。`prototype-status.txt`记录三场景原型均已通过自身示例控件完成捕获。
