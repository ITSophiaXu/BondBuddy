# 复核材料分区去掉重复标题

用户于 2026-10-13 截图指出“待复核募集书”和“审计报告 / 财务报表及附注”下面重复显示材料名称，要求删除第二行。本次以该用户要求为布局确认依据。

源码与原型 commit：`8d5e9cb7d5a6c7a2a6a25701a01d6d850c55124d`，基于 develop `6cd5d2cb`。实现为 `apps/web/src/review-workspace.ts`；原型为 `product-prototype/public/workspace-ux-scenes.json`，由 `workspace-ux.html?scene=materials` 展示。五个含材料分区的场景同步移除三个主上传区域的重复名称。`review-requirements.html` 的简化要求区原型原本已采用单层标题，无须修改。

主上传区域只显示分区 h3、上传说明和选择文件入口；“其他核验材料”同样采用这一层级。展开细分类别后保留参考募集书、年度财务报表、最近一期报表和财务附注名称。文件输入的 aria-label、accept、多选、拖放与材料角色未改动；已保存文件下的类型元数据保留。

## 验证

- 开发与集成工作区 web TypeScript、Vite 构建及 diff 检查通过。保留现有单包大于 500 kB 提示。
- 现有 `review-workspace.spec.ts` 定向回归 5/5：开始前保存要求、上传重试不重复传输、1360/390 两种宽度的上传队列及原生文件选择器保留、停止后删除并重新上传。测试使用 synthetic API。
- 真实 localhost:5178 页面在 1440×960 / 390×844 下刷新，三个主分区均无重复名称；两个细分类别分区展开后名称可见，输入标签和文件格式保留，无横向溢出或页面脚本错误。既有用户项目只读查看，提交的截图仅裁出通用标题、说明和上传入口，不含项目或文件数据。
- 同尺寸原型对照：标题层级、说明、上传入口及细分类别一致。此次未引入原型偏离。原型快照较早的周边导航/助手不作为本次验收范围；截图裁出实际受影响的上传区。
- 本地 `local-integration-live.spec.ts --grep 'real review:'` 1/1 通过：新建独立合成账号/复核项目、真实 DOCX 上传至本地存储、要求保存及刷新恢复。首轮漏设现有 `BB_E2E_TERMS_VERSION=local-integration-20261012`，注册返回 422；按 README 设置后通过，没有修改注册逻辑或放宽断言。
- 截图初次把手机标题滚到了固定页头下面，调整截图滚动位置后重新截图；没有为截图修改产品 CSS。修改前手机图片不纳入对照。

命令（真实本地测试需另外设置 `BB_E2E_LOCAL_INTEGRATION=1`）：

```powershell
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/vite/bin/vite.js build apps/web
# 从 apps/web 执行，开发 Vite 为 5193；真实本地测试为 localhost:5178
node ../../node_modules/@playwright/test/cli.js test tests/review-workspace.spec.ts --grep 'inline requirements save before start|direct upload retries|upload queue keeps|review upload deletion' --reporter=line
node ../../node_modules/@playwright/test/cli.js test tests/local-integration-live.spec.ts --grep 'real review:' --reporter=line
```

截图：`before-1440-0.png` / `before-1440-1.png` 为修改前；`after-*` 为实际页面，`prototype-*` 为静态合成原型。文件后缀 0/1 分别是募集书与财务材料分区；几何和语义结果见 `before.json` / `after.json`。

本次来源 `8d5e9cb7` 已 cherry-pick 为本地集成 `b5ed491`，保留 PR #694 的操作栏滚动修复与助手居中修复。无依赖、迁移、API、worker 或计费变更；未调用模型。开发和自测完成，本地版可验收，用户尚未验收；代码完成，尚未部署，待统一发布。
