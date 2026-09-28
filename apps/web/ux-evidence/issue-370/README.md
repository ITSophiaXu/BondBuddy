# #370 原型偏差整改（2026-09-28）

原型基准：`23fd64fa22185b21015684b885526bc4247e98cd` 的 `product-prototype/public/project-workspace.js`（basics/period-row/quarter-grid/page）及 styles.css；与实现分支起点 `e37f8a6` 中对应原型文件一致，本轮不修改原型。实现提交见关联 PR（最终 SHA 在 PR 与 #370 回填）。本轮偏差处理由产品负责人 ITSophiaXu 在 #370 明确确认用户要求，覆盖早先 #363 未被接受的额外控件。

| 项目 | 实现与数据边界 |
| --- | --- |
| UX-A | 新建与编辑都用年份＋3月末/6月末/9月末/年末，四季度分别写 `03-31`/`06-30`/`09-30`/`12-31`。不显示 date picker。旧非季度末日期原样保留，并提示选择季度末后修改；不静默纠正旧值 |
| UX-B | 删除整套目标期间编辑、增删、类型/口径/填写状态控件，未移到其他页面。表单内存保留读取到的不可见字段，修改截止日、金额或补充说明不会清空旧 target_reporting_periods、状态或已锁定输入；不从一个截止日猜整套期间 |
| UX-C | 删除 execution-setup 卡片及标题/副标题、目标摘要、用途/法规日、材料重选、勾选确认和常驻版本面板。主按钮在材料步骤页脚，与上一步同层。内部保存/预检/提交、幂等与真实任务状态继续保留；历史/无历史安排筛选其对应的已保存材料，旧记录不删除 |
| UX-D | 上传主流程只留“数据保存与删除说明”链接，不请求和展开保留/运维配置；完整真实政策仍在独立页面。文件传输/保存核验/错误/重试保留；恢复提示改为简短“已恢复 N 份材料”“尚未添加材料” |
| 置灰原因 | 由实际材料/上传/读取/草稿/任务状态决定，显示在主按钮旁：无材料提示添加，上传/保存中显示文件及进度，读取失败提示重试，有任务指向当前进度；状态解除后原因消失。只有 API 返回 CAPABILITY_NOT_READY 才说明当前环境未开放更新，不从置灰推断 worker/模型状态 |

无新增 UI 偏离；本表列出的必要反馈来自 #370 的旧数据保留要求与补充置灰原因要求。#361 的其他未验收项仍由父单跟踪，不把本次修复称为全部原型验收完成。

## 同尺寸对照

两边均为 Chromium 实际渲染，桌面 1440×960、窄屏 390×844，截图为全页。**全部使用合成账号/项目/API 与文件字节**，不包含客户材料，不代表真实模型、数据库/Blob、OCR 或 Word/WPS 验收。

| 页面 | 原型 | 本次实现 |
| --- | --- | --- |
| 创建页，桌面 | [原型](reference-create.png) | [实现](create-desktop.png) |
| 创建页，窄屏 | [原型](reference-create-mobile.png) | [实现](create-mobile.png) |
| 材料页，桌面 | [原型](reference-materials.png) | [实现](materials-desktop.png) |
| 材料页，窄屏 | [原型](reference-materials-mobile.png) | [实现](materials-mobile.png) |

[操作录屏](workflow.webm)：选择年份/季度末→创建→材料上传→页脚开始更新→同页状态→刷新恢复。测试返回排队状态，不生成虚假 Word。

## 复现与依赖

```sh
npm run build
npm run test:unit -w @bondbuddy/web
npm test -w @bondbuddy/web -- --workers=1
BB_UX_EVIDENCE_PREFIX=bb370 node apps/web/scripts/capture-prototype.mjs
# 在 apps/web 中录屏
npx playwright test --config playwright.370.config.ts
```

`prototype-corrections.spec.ts` 覆盖四季度末/年份、旧非季末日期/期间保存、禁止被删除区域重新出现、页脚主操作、上传/保存进度置灰、读取失败恢复和环境关闭的实际返回。其他上传、草稿、账户、OCR 与执行回归继续运行，旧长文断言同步为新短提示，未移除数据/幂等检查。

本地界面验证使用合成 HTTP；需专用数据库/Blob/OCR 的 live 用例未在此作为真实验收。线上能力不能由本机缺少 worker 或此测试夹具推断。

后台接缝已在 [#76 评论](https://github.com/ITSophiaXu/BondBuddy/issues/76#issuecomment-5862559034) @loooo139/@muhualing：locked difficulty 输入仍消费完整期间，目标确认 API 还带期间/用途/法规日。本次新输入省略可选 target_confirmation，让服务器保留 unconfirmed，不伪造批准或把旧期间确认成新目标。#76/#17 继续从 cutoff＋授权材料和补充要求形成版本化依据；不以此依赖恢复被删除的 UI。预检/执行按服务端实际门禁反馈。

#370 是否通过最终 UX 验收以 Issue 的逐项确认记录为准；合并代码不自动关闭本单或父任务 #361。
