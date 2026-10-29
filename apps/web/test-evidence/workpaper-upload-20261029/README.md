# 底稿目录上传恢复界面对照

原型：`product-prototype/public/workpaper-batch.html?upload=recovery`，随本次修复同步更新；实现：`apps/web/src/workpaper-panel.ts`。沿用现有底稿生成第二步，仅明确已保存与待识别状态、恢复动作和目录准备说明。

- `prototype-recovery-1440.png` / `prototype-recovery-390.png`：已运行的原型，合成状态。
- `recovery-1440.png` / `recovery-390.png`：真实网页组件，合成 HTTP 接口返回目录解析 422。
- `prototype-card-*.png` / `recovery-card-*.png`：同视口下恢复卡片对照。

已查看桌面卡片及手机完整页面：文件名、状态、继续识别及移除待办均可见；不再要求已经保存的文件反复重选；文本正常换行，无水平溢出。原型不包含真实上传和收费行为。后端原文件验证范围见 `docs/acceptance/workpaper-upload-20261029.md`。
