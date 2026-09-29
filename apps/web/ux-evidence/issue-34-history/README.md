# #34 同项目 Word 版本目录 · 原型对照

依据：`product-prototype/design-previews/update-workspace.fragment.html` 与导出页 `product-prototype/public/previews/update-workspace.html`，#85 head `46764161565027f332bdf28f8b335620bd035018`，完成态 `completeView()`；原有真实应用来源为 `product-prototype/public/project-workspace.js` 和 `apps/web/src/project-execution.ts`。当前实现使用 #471 的 `ArtifactHistoryResponse`（merge `290d4c34368f86885ac6b009edca0262afc10e4d`）。实现截图的代码 head 为 `940ad39`（包含 #388/#467 的 `develop` merge `466aef2`）；若合并前再次 rebase，则更新 head 和截图。

截图均为 Chromium 同尺寸**视口**截图（非全页），桌面 1440×960、手机 390×844。原型使用 #85 独立预览页并点选“已完成”；实现使用合成 HTTP/Word 字节模拟本项目已有三个成功版本且新任务失败，滚动至目录。截图是交互对照，不是真实模型、Blob、授权客户成果或 Word/WPS 实机验收。

| 视口 | #85 原型完成态 | #34 实现旧版保留态 |
|---|---|---|
| 1440×960 | [原型](prototype-desktop.png) | [实现](implementation-desktop.png) |
| 390×844 | [原型](prototype-mobile.png) | [实现](implementation-mobile.png) |

| 与 #85 原型的差异 | 原因与影响 | 产品确认 |
|---|---|---|
| 原型完成卡仅展示当前 vN 的修订/清洁下载及“下一轮生成新版本，保留当前稿”；实现于**同一项目结果区**增加独立“历史成果”卡，列出所有仍可获取版本和三件套或旧单件 | #34 明确要求能找回多次成功交付，后续任务失败不能遮蔽旧稿；保持既有左右布局、右侧项目协作、导航与主操作不变，不增加新页面 | **待产品负责人确认；未确认前保持草稿，不合并** |
| 原型用演示完成状态和下载提示；实现使用真实分页列表、当前运行状态及每个文件的授权读取 | 只读接口返回当前检查通过的结果；不把演示下载、存疑 Word 或测试稿展示成生产成果 | 既有 API/运行边界，无新增交互确认 |
| 截图原型为成功、实现为较新任务失败 | 特意展示历史目录在新任务失败后仍可见；已完成态保留既有成果详情卡，目录仍在同一工作区 | 属于功能验收场景，不是原型状态文案的替换 |

若后续 #384、#361 或 #18 改变同一工作区布局、协作区或操作文案，合并前重基于最新 `develop` 并重新截取/对照。这些合成截图不代表 #35 模型→Blob→授权下载或 #146 WPS/Word 兼容性已验收；#34 保持开放。
