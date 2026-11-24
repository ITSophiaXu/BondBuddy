# 文件生成 UX 对照（PR #1751）

- 原型：`product-prototype/public/file-templates-v2.html`，基准提交 `a7f8a9c48`。
- 实现：本 PR 的 `FileGenerationPanel`，通过 `pr1751-preview.html` 使用合成项目、模板和任务数据渲染；未调用真实生成、上传或计费接口。
- `prototype-1440-viewport.png` 与 `implementation-1440-viewport.png` 均为 1440 × 960 的浏览器视口截图。`bondbuddy-pr1751-prepare.png`、`bondbuddy-pr1751-selected.png`、`bondbuddy-pr1751-progress.png` 为完整页面截图。
- 原型默认选择并展开底稿。用户 2026-11-24 明确要求改为其他文件类型默认展开、底稿整体默认折叠；仅选择底稿后显示底稿模板包；生成进度单独成页。因此这些差异是本次确认的调整。
- 其他文件的内置模板选择和 Word 上传位于已选文件对应行；进度页展示整批及每份文件的状态，并链接到底稿或其他文件成果。
