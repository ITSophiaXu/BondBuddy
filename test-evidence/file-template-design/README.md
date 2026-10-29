# 文件生成与模板库交互设计验证

基线：`c7d0c42a`，分支 `design/file-templates-20261029`。本目录为设计稿截图与自动化结果，不是生产实现的对照截图，不代表用户已验收。

原型：`product-prototype/public/file-templates-v2.html` 及同名前缀 CSS/JS/data 文件。
设计及后续实现落点：`docs/FILE-GENERATION-TEMPLATE-DESIGN.md`。

本目录全部使用明确标记的合成素材。本机另外验证 248 项通用目录、175 份 Word 的脱敏文字结构及 7 份代表模板的 20 页脱敏样页，未提交客户材料或其衍生截图。截图覆盖 1440×1000、390×844 的准备页、上传页、混合批次确认、模板弹窗及正文结构。主页面长图按全文保存；表内目录和预览窗口独立滚动。

## 运行

```sh
node scripts/serve-file-template-design.mjs --port 4380
# 另一个终端；使用已有 Playwright 安装，默认 Edge headless
BB_TEMPLATE_DESIGN_URL=http://127.0.0.1:4380 node product-prototype/qa/file-templates-v2.browser.mjs
```

Windows 用 `$env:BB_TEMPLATE_DESIGN_URL='http://127.0.0.1:4380'` 设置变量。可设置 `BB_PLAYWRIGHT_MODULE` 指向现有 Playwright 包，`BB_E2E_BROWSER_CHANNEL` 选择浏览器，`BB_TEMPLATE_DESIGN_EVIDENCE` 设置输出目录。Ctrl+C 停止本地设计服务；只绑定 loopback，无登录、任务、上传、模型或积分服务。

## 结果

Node 24.22.1、Windows、Edge headless；JS 语法检查通过。默认合成数据和本机脱敏素材各 14 项浏览器检查通过；无页面 JS 错误、无 HTTP 资源错误、无产品 API 或写请求。逐项结果见 `result.json`。

检查包括目录不丢项、歧义候选不默认取第一份、目录与模板双卡片、独立目录预览、只换一方保留另一方、集中查看疑点、单项指定模板、并列选择文件但未解析不进入生成、新文件清除旧演示结果、缺模板提示、年报期间与补充材料、单份/多份确认、明确未纳入项、恢复内置模板、演示暂停以及手机无页面水平溢出。本机脱敏素材还核对了页面图片加载、分页、脱敏文字视图，以及旧原文图片和旧 data.js 地址返回 404。

`python scripts/test_template_preview_redaction.py` 的 2 项脱敏测试通过：跨 run 的企业/人员、联系方式、历史数据、批注、外链及图片不保留；表格与页面属性保持，未知姓名/简称不依赖正则猜测。175 份原件的 SHA-256 与收件盘点一致，原件未改写；安全文本检查与真实脱敏浏览器证据留在本机私有工作目录。全部 20 页脱敏样页已检查，表格窄单元格使用短占位避免挤压。

未运行生产包构建和后端用例：本 PR 没有修改生产 web/API/worker/contracts，也未新增迁移或运行依赖。未进行真实模型生成、费用入账或用户验收。真实模板预览仅为指定 7 份文件的前 2–3 页脱敏样页，其余提供脱敏文字结构，不宣称完整页面转换已完成。GitHub CI 的 5 个工作流因账户付款 / spending limit 限制未启动，不能认定 CI 通过。

受影响的后续迁移范围：文件生成入口、底稿准备与导入、业务模板选择、混合批次确认及成果页（#361）。生产逐屏对照要在真实实现切片完成后补齐，不能拿本设计截图冒充实现证据。
