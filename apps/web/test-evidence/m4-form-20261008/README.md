# 材料页简化验收（2026-10-08）

原型与实现源码 commit：`94592c1`，基于 develop `9f04d12`。

依据：[用户确认的界面决定](../../../../docs/product-decisions/2026-10-08-material-form-simplification.md)。原型位于 `product-prototype/public/material-studio.js`，实现位于 `apps/web/src/material-workspace.ts`。截图采用 synthetic 账号和材料，不代表真实模型生成验收。

| 状态 | 桌面 1440×960 | 手机 390×844 |
| --- | --- | --- |
| 原型空白表单 | [prototype-desktop.png](prototype-desktop.png) | [prototype-mobile.png](prototype-mobile.png) |
| 实现空白表单 | [implementation-desktop.png](implementation-desktop.png) | [implementation-mobile.png](implementation-mobile.png) |
| 实现已保存文件 | [saved-file-desktop.png](saved-file-desktop.png) | [saved-file-mobile.png](saved-file-mobile.png) |

逐项对照：
- 页首不再有继续已有材料／新建材料入口，直接开始填写；已有项目路由仍恢复原工作区。
- 按用户截图反馈，取消募集书二次选择及重复详情；已保存状态只显示文件名、用途、下载／替换，技术引用仍在后端保留。
- 补充要求标题改为与其他区域相同的 h2（实现均为 19 px），小号“选填”与可访问文本框名称保留。
- 沿用生产中的刷新状态、真实报价确认、独立草稿和成果恢复能力。原型仍采用模拟文件选择后提交，实现仍即时保存；本次不改变上传时机。
- 原型尚展示旧账号入口及未开放公募摘要选择，实现继续使用当前生产功能范围。这些既有差异不在本次变更内。
- 本次入口、当前文件展示及字号偏离的确认人：本会话用户，2026-10-08。

验证：
- `npm run build` 通过；最终前端 `npm run build -w @bondbuddy/web` 通过。
- `npm run check:contracts` 通过：167 公共示例、12 内部示例、4 数据生命周期示例，29 OCR 契约测试、11 发行人绑定测试。
- Windows + Edge，独立 Vite 端口 5191，`M4_UX_EVIDENCE=1` 下 `playwright test tests/m4-workspace.spec.ts`：16/16，无跳过。
- 包含原项目路由恢复、自动采用、重新加载、替换失败保留原文件、草稿冲突恢复、不可变任务输入、1440/390/320 宽度和同尺寸原型对照。
- 视觉检查：标题层级一致，文件名换行正常，无横向溢出。
- 额外执行原型旧 `material-ui.test.mjs`：10/12；两个既有失败为旧 M1“相似募集书”文字断言、已取消的右侧聊天布局断言。未修改基线 `8200b82` 同样为 10/12；相关的材料表单提交与来源默认值测试通过，不在本次重写旧测试。

无 API、公共契约、数据库或 worker 运行代码修改；无真实编制调用或计费。
