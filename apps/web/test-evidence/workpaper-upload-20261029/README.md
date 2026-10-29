# 底稿目录上传恢复界面对照

## 当前增量：目录灵活识别

原型为 `product-prototype/public/workpaper-batch.html?upload=review`（新增 `workpaper-import-preview.js`）；实现为 `apps/web/src/workpaper-panel.ts` 和 `workpaper-import-review.ts`。原型与实现同随 PR #806 的增强提交交付，基于首阶段 commit `501fc64f`；最终对照版本为 PR 内包含本说明的提交，未引用其他 chat 的未提交代码。

- `interpretation-1440.png` / `interpretation-390.png`：网页真实组件，合成 HTTP 预览，包含上传恢复记录。
- `prototype-interpretation-1440.png` / `prototype-interpretation-390.png`：同视口的静态原型及合成操作。
- `interpretation-card-*` / `prototype-interpretation-card-*`：核对区域截图；实际网页元素截图会包含全局固定工具条/助手覆盖，完整页截图用于排版核对。

已核对名称/编号选择、行范围、展开的原表样例入口、分类/编制要求设置、更新预览和确认动作；移动端单列排列，无整页横向溢出。目录核对时隐藏重复的文件选择大区域。原型不含真实网页的项目/账户外框和上传恢复记录，操作只演示固定合成区域；实际页面使用后端返回的工作表、样例、条目和提示，支持添加/移除多个区域。字体/边距受真实页面公共样式影响；本次未自动合并，不将开发者查看视为用户视觉验收。

## 首阶段历史证据（501fc64f）

原型：`product-prototype/public/workpaper-batch.html?upload=recovery`，随本次修复同步更新；实现：`apps/web/src/workpaper-panel.ts`。沿用现有底稿生成第二步，仅明确已保存与待识别状态、恢复动作和目录准备说明。

- `prototype-recovery-1440.png` / `prototype-recovery-390.png`：已运行的原型，合成状态。
- `recovery-1440.png` / `recovery-390.png`：真实网页组件，合成 HTTP 接口返回目录解析 422。
- `prototype-card-*.png` / `recovery-card-*.png`：同视口下恢复卡片对照。

已查看桌面卡片及手机完整页面：文件名、状态、继续识别及移除待办均可见；不再要求已经保存的文件反复重选；文本正常换行，无水平溢出。原型不包含真实上传和收费行为。后端原文件验证范围见 `docs/acceptance/workpaper-upload-20261029.md`。
