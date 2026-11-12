# 生成准备页：连续选择与保存恢复

桌面实测复现：点击取消全选后，准备清单 PUT 未返回时先重绘旧值，并将整个表单锁住；用户看见旧范围／费用，不能连续选择。修前 [失败上下文](first-red-context.md) 与 [截图](before-pending.png) 保留。

选择现在立即更新本地草稿、数量和预计费用，180ms 合并后串行保存；旧回包只推进已保存版本，不覆盖之后的输入。保存失败保留原请求快照与最新草稿，可重试或刷新核实；另一页面真正修改了服务端版本时保留本地内容并阻止提交。生成和更换募集说明书等待完整保存队列，报价／提交采用准确的已保存 revision。迟到的进度成功或失败响应也不能隐藏刚提交的任务。

仅修改 `apps/web/src/file-generation-panel.ts`、同名 CSS 和相应浏览器测试。无 API、worker、契约、迁移或费率变更；保存／恢复时序直接影响权威生成输入，不能归为纯提示修改。按发布指南保留独立分支，待独立工程影响判定，不据此自行合并或部署。

## 最终执行

Windows Node v26.13.0、真实 headless Edge，1440×960／1280×960；产品组件和路由真实，身份、目录、HTTP、任务结果及价格均为 synthetic。专用 Vite 干净启动，完整执行一次最终桌面组：

```text
npx playwright test tests/generation-save-feedback.spec.ts tests/file-template-preparation.spec.ts tests/file-generation-flow.spec.ts --grep-invert "390|320"
51 passed / 0 skipped / 0 unexpected / 0 flaky，retries=0
```

其中新增 19 项、既有准备页 21 项、原入口／流程 11 项。覆盖连续点击与键盘选择、旧回包、文种／年份／模板／要求合并、未知结果及两次刷新恢复、503、外部 409、存储失败、离开页末次保存失败、进度刷新／轮询、陈旧响应以及刷新后价格展示与提交一致。composition 事件注入验证输入节点与光标保留，未进行原生 IME 验收。

[最终报告](desktop-report.json)、[完整输出](desktop.log)、[执行前](source-before.json)／[执行后](source-after.json)四文件 SHA256 均相同。主 agent 独立核对当前字节、Git blob、报告计数并记录在 [root-review.json](root-review.json)。`npm run build` 和 `npm run check:contracts` 均 exit 0，见 [构建](workspace-build.log)／[契约](contracts.log)；既有 bundle 大小警告保留。入库的首次失败上下文与构建日志只移除了行尾空白，本地原始输出保持不变。

早轮真实失败未删除：首次复现、陈旧 GET 覆盖提交状态、源码 HMR 中的 setup 未完成、既有 fixture 的请求到达／故障解除竞态，原件保留于忽略的 `.local/generation-save-feedback/`。旧 fixture 改为真实 API 的精确重试／409 语义及等待实际请求完成，原次数、金额、范围和失败断言保持。最终 51 项为同一固定源完整执行，不拼接中间绿灯。

## 原型与截图

原型为 `product-prototype/public/file-templates-v2.html`、`file-templates-v2.js`，基线 `1ef2092708aaadbb12f07a4e6ddf5a9e2dee322f`；HTML blob `254539269fdf21b33600073945c4fdaa1183f904`，JS blob `f6eb530f238963ed5976ec0643a9bc66bb6191dc`。即时选择符合原型原位更新计数的行为；本轮保留两卡、选择清单、要求区及生成 footer，在 footer 添加真实保存状态和重试。没有修改原型。

| 对照 | 1440×960 | 1280×960 |
| --- | --- | --- |
| 当前原型 | [截图](prototype-1440x960.png) | [截图](prototype-1280x960.png) |
| 实现：保存失败仍可编辑并重试 | [截图](save-failure-1440x960.png) | [截图](save-failure-1280x960.png) |

[保存中即时选择](after-pending.png)／[最新范围保存完成](after-saved.png)。主 agent 目视确认失败状态与重试靠近生成按钮，输入与按钮无遮挡，无水平溢出。原型和实现的合成素材、滚动位置、壳层及原有导航差异明确保留，不声称逐像素一致；本次新增偏离是 footer 保存状态／重试，尚未取得产品负责人对该偏离的独立确认。

这些结果不证明真实账务、模型／Word 内容质量或线上部署。生产版本未核实，正式收费上线验收仍未完成。
