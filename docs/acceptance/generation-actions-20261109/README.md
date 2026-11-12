# 文件生成：导航恢复与操作层级

2026-11-09 用户根据“停止继续上传”无法辨认的问题要求：需要用户操作的入口必须明显；不需要处理和重复的信息不应堆在页面上。本次沿用文件生成四步流程，细化上传与准备页面，不更改生成、采用、收费或材料保留规则。

- 上传入口用明确按钮和文件格式/大小一行说明。
- 待确认文件放在单独的浅色卡片，主操作“重试上传”、次操作“取消本次上传”紧邻文件名；取消只清除这条恢复记录，服务器文件保留。
- “重新选择原文件”只在恢复确实需要文件字节时出现，选好后直接继续原上传。
- 活动上传只显示进度，不同时显示等待重试按钮。已选文件只保留文件名及版本，正常成功不重复追加长提示。
- 移除空来源提示、重复上传说明、页脚重复提醒、标题说明及重复项目文件入口；仍可从项目上下文返回本项目文件。
- 模板更换、范围调整、缺失模板处理、预览、保存与上传恢复使用实心/描边按钮。空白的选填区默认收起，有要求或材料时展开；不显示“0份补充资料”。
- 延续同一 PR 的导航修复：持久化的暂停上传可离开再返回，活动传输、无法恢复的状态和未确认采用仍有保护；生成前仍需确认来源。

实现：apps/web/src/prospectus-panel.ts、file-workspace.ts、generation-flow.css、file-generation-panel.ts/.css。
原型：product-prototype/public/file-generation-source-actions.html（本 PR）；既有主流程原型 file-generation-flow-approved.html 不再作为上述重复说明和无边框操作的依据。用户本次要求为调整依据。

截图：actual-/reference- 分别为真实前端和原型，在 1440、390、320 CSS 像素视口下截取来源区域。文件名、HTTP 响应均为合成数据，参考原型只表达操作层级；上传与下一步行为由真实前端测试验证。原型和实现同属本 PR，修改前基线为 4267add3。

验证结果：97 项浏览器回归测试通过（Microsoft Edge，2.3 分钟），TypeScript 检查和 Vite 生产构建通过，git diff --check 通过。Vite 仅提示已有主包体积超过 500 kB，没有构建错误。

测试集：generation-source-ux、generation-navigation-recovery、file-generation-flow、prospectus-panel、prospectus-selection、file-template-preparation。

新增 UX 检查覆盖桌面 1440 和手机 390/320 像素视口、可见按钮的点击面积与描边/填充、键盘取消、无横向溢出、取消不写入服务端、按需重选原文件并自动恢复同一次上传、活动上传只出现一处进度。导航检查覆盖五个侧栏目标、返回后沿用原请求、活动上传及缺失恢复记录的保护、生成前确认与刷新保护。

复现命令（apps/web 目录，开发服务器在 127.0.0.1:5329）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5329'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/generation-source-ux.spec.ts tests/generation-navigation-recovery.spec.ts tests/file-generation-flow.spec.ts tests/prospectus-panel.spec.ts tests/prospectus-selection.spec.ts tests/file-template-preparation.spec.ts --timeout=30000 --max-failures=2
node ../../node_modules/typescript/bin/tsc --noEmit --pretty false
node ../../node_modules/vite/bin/vite.js build
```

截图索引：

- `actual-empty-*` / `reference-empty-*`：空白上传入口，1440/390/320 同视口对照。
- `actual-recovery-*` / `reference-recovery-*`：待恢复上传，1440/390/320 同视口对照；实际截图包含取消按钮的键盘焦点样式。
- `actual-uploading-1440.png` / `actual-selected-1440.png`：活动上传和成功选择，验证进度及成功状态。
- `actual-preparation-1440.png` / `actual-preparation-390.png`：模板准备页的操作按钮和收起的选填区。

对照结论：空白和恢复页面的操作层级一致，实际页面沿用应用壳的字体、宽度与间距；原型只表达来源区，不复制整个应用壳。模板准备页保留既有卡片与四步流程，按本次用户要求将文字操作改为描边按钮，并收起空白选填区。以上为开发自测，未代替用户验收。

无新增依赖、接口或数据库迁移，仅 web。没有生产操作、真实模型或计费调用；没有启动本批统一本地集成验收版。代码完成，尚未部署，待统一发布。
