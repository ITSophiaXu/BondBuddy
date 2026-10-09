# #629 成果命名证据

Windows、Node 22.14、Edge，synthetic 数据。原型 result-filenames.html / material-results.html 与实现均为本 PR source commit。

- `npm run build`、`npm run check:contracts` 通过。
- `node --test packages/contracts/dist/artifact-filename.test.js apps/api/dist/artifact-filename.test.js apps/api/dist/word-delivery-artifact.test.js`：6/6，通过非法字符/中文长度、扩展名、固定时间、业务版本、变体、元数据/下载响应头一致性和归属验证。
- `BB_E2E_BASE_URL=http://127.0.0.1:5638 BB_E2E_BROWSER_CHANNEL=msedge npx playwright test tests/artifact-page.spec.ts`（apps/web）：原 28/28 通过；新增 canonical filenames 场景 1/1 通过，刷新、再次下载、项目列表名称相同。
- 同环境 `tests/project-assistant.spec.ts --grep 'attachments selected'`：1/1 通过，助手准确下载名称及内容。
- M4 与复核 PostgreSQL 测试增加列表、通用元数据与 Content-Disposition 对账，交由 PR Linux CI 验证。本地 Docker 未启动，没有将跳过当作通过。

同尺寸图片：prototype-1440.png / implementation-1440.png 为 1440×960；prototype-390.png / implementation-390.png 为 390×844。已逐图检查：中文文件名完整换行，两个版本清楚区分，按钮可见，无横向溢出。原型只定义下载卡片，实现包含既有导航/摘要，因此截图页壳与滚动位置不同；本次无页壳改版。原型/实现使用用户当日要求的同一名称格式。材料成果只替换原有文件名文字。

最终统一验收待办：生产历史成果、真实新任务和 Word/WPS 下载名实测。合成字节/数据库测试不等同真实模型或专业审核；发布状态另行记录。
