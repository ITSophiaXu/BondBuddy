# 2026-10-13 复核结果页精简

来源 PR #697：产品/原型 `af11dfd62fa0dc398b6664584f849ff153b07619`、合成证据 `9059a29cbb07a5d9500d5e41225501670ef0c818`；集成分别为 `9a65642` / `69ccd6e8177a16f32f9cc3711b391ea3e893b2a4`。删除结果页“任务详情”以及截图所示“根据复核结果更新募集书”的标题、说明、按钮和提交路径，保留原报告、批注与历史更新成果下载。

- 源和集成 TypeScript / Vite 构建通过，仅有已有包体积提示。
- 源 Edge 复核回归最终 **59 通过、4 个无关可选取证跳过**；首次一项旧 DOM 顺序断言依赖被移除区块，修正为不存在断言，相关 3 项补跑全部通过。详情及 1440×960 / 390×844 合成原型对照见 `apps/web/test-evidence/review-results-focus-20261013/README.md`。
- **真实本地只读浏览器 1/1 通过**：沿用已有成功复核，桌面/手机刷新后两个区域均不存在，三维导航可用且无横向溢出；报告与原文批注版仍可下载。原文批注版 **923,162** 字节、报告 **56,526** 字节，文件名及 SHA-256 与原元数据一致。
- 未拦截或模拟本地 API；页面错误 0，除登录外业务写请求 0，新模型调用 0，无新任务和新扣费。验证现有成果的访问，不代表重新验收模型内容或重新生成批注。
- 服务前后均 ready=true、网页/API 200，五项进程身份保持不变。项目/材料/run 保持 **31/36/8**。已有一项材料生成仍在运行，本轮前端更新未重启或替换后台服务。
- API 仍 `0556ca5a`；worker 仍 `f9ea165`、镜像 `sha256:85e2a227ec1f0197750f05f03204f59c39bae671edd2548f47e5331fd861b01d`。模型探针和端到端标志保持原值，未重做或改为成功。
- 集成构建 `index-wSnIy2p6.css` / `index-R5RCpGRm.js`，无契约、依赖或迁移变化。

入口仍为 **http://localhost:5178**，登录 `integration_user`，密码沿用共享交接。打开已完成的复核项目 → 复核结果 → 刷新，检查页面以报告内容结束；切换三个维度并下载原文批注版/报告即可，无需重新复核。独立 5193 开发预览关闭，5178 保持运行。

原启动、状态与停止命令继续适用：在本集成仓库执行 `node scripts/local-integration/start.mjs`、`node scripts/local-integration/status.mjs`、`node scripts/local-integration/stop.mjs`。当前正在运行，无需为本次前端修改重启。

真实证据仅留共享本地：`work/local-integration-runtime-20261012/evidence/review-results-focus-20261013/review-verification.json` 及同目录截图；服务快照为 `review-results-status-before-20261013.json` / `review-results-status-after-20261013.json`，真实材料和截图不提交 GitHub。

开发和自测完成，本地集成版可验收；用户尚未验收；代码完成，尚未部署，待统一发布。
