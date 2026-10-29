# 文件生成与模板库交互设计验证

基线：`c7d0c42a`，分支 `design/file-templates-20261029`。本目录为设计稿截图与自动化结果，不是生产实现的对照截图，不代表用户已验收。

原型：`product-prototype/public/file-templates-v2.html` 及同名前缀 CSS/JS/data 文件。
设计及后续实现落点：`docs/FILE-GENERATION-TEMPLATE-DESIGN.md`。

本目录全部使用明确标记的合成素材。真实 248 项目录及 Word 正文/样页在本机另行验证，未提交客户材料。截图覆盖 1440×1000、390×844 的准备页、上传页、混合批次确认、模板弹窗及正文结构。主页面长图按全文保存；表内目录和预览窗口独立滚动。

## 运行

```sh
node scripts/serve-file-template-design.mjs --port 4380
# 另一个终端；使用已有 Playwright 安装，默认 Edge headless
BB_TEMPLATE_DESIGN_URL=http://127.0.0.1:4380 node product-prototype/qa/file-templates-v2.browser.mjs
```

Windows 用 `$env:BB_TEMPLATE_DESIGN_URL='http://127.0.0.1:4380'` 设置变量。可设置 `BB_PLAYWRIGHT_MODULE` 指向现有 Playwright 包，`BB_E2E_BROWSER_CHANNEL` 选择浏览器，`BB_TEMPLATE_DESIGN_EVIDENCE` 设置输出目录。Ctrl+C 停止本地设计服务；只绑定 loopback，无登录、任务、上传、模型或积分服务。

## 结果

Node 24.22.1、Windows、Edge headless；JS 语法检查通过。默认合成数据和本机真实素材各 12 项浏览器检查通过；无页面 JS 错误、无 HTTP 资源错误、无产品 API 或写请求。逐项结果见 `result.json`。

检查包括目录不丢项、歧义候选不默认取第一份、集中查看疑点、单项指定模板、空个人库、并列选择文件但未解析不进入生成、缺模板提示、年报期间与补充材料、单份/多份确认、明确未纳入项、恢复内置模板、演示暂停以及手机无页面水平溢出。真实素材还核对了 Word 页面图片加载、分页与全文文字视图的边界。

未运行生产包构建和后端用例：本 PR 没有修改生产 web/API/worker/contracts，也未新增迁移或运行依赖。未进行真实模型生成、费用入账或用户验收。真实模板预览仅为指定 7 份文件的前 2–3 页样页，其余可读正文，不宣称完整页面转换已完成。

受影响的后续迁移范围：文件生成入口、底稿准备与导入、业务模板选择、混合批次确认及成果页（#361）。生产逐屏对照要在真实实现切片完成后补齐，不能拿本设计截图冒充实现证据。
