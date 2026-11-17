# 移除添加内置文种模板入口

关联 #1533；用户于 2026-11-17 提供生成文件页面截图并明确要求移除此功能。基线 develop d208d881ab838502f33d51201a6b10d449125f1e。

移除 apps/web/src/file-generation-panel.ts 中“添加内置文种模板”按钮、事件绑定及 builtinTemplates 批量导入函数。保留已有模板记录、按文种选择、预览、上传 Word、年度报告年份和准备清单保存；底稿包光大模板功能不变。无数据库迁移、公共契约、新依赖或 API/worker 变更；集成后重建 web。

## 验证

Windows / Node 22.14.0 / TypeScript 5.9.3 / Vite 8.3.0 / Playwright 1.63.0 / Edge。

- contracts 编译与 npm run check:examples -w @bondbuddy/contracts：72/72测试通过，179个公开、12个内部参考库、4个数据生命周期样例通过。
- 生产前端源代码类型检查通过，Vite 正式打包通过（593 modules）；保留原有大 chunk 提示。
- 现有浏览器回归：10/10通过，0失败、0跳过。覆盖：文件选择与刷新恢复、报告年份保存、1440/768/390/320布局、模板/目录预览、混合清单提交、上传自有模板和模式切换后恢复，以及1440/390原型对照。
- 检索生产源代码确认无 fg-general-builtin、builtinTemplates 或原完成提示。

浏览器运行命令（apps/web）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5549'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/file-generation-choice-layout.spec.ts tests/file-template-preparation.spec.ts --grep 'all choices|editing the report year|compact category|independent catalogue/template|custom templates have independent|current dual-card prototype'
```

生产源代码类型检查先使用临时配置继承 apps/web/tsconfig.json，include 为全部 src/**/*.ts 及 vite.config.ts，排除 src/**/*.test.ts。随后完成 domain、rule-pack-registry、rule-applicability-context、API 编译，标准 tsc --noEmit -p apps/web/tsconfig.json（含所有测试夹具）也通过。

最初复用本地依赖缺少最新开发版已锁定的 @noble/hashes 2.0.1，完整网页类型检查还缺 API 等包的编译产物。补齐独立目录依赖后生产代码检查和构建通过。浏览器初次及一次重试仍命中 Vite 缺依赖缓存，已中止；重启本次独立测试服务后重新验证。没有修改项目 package.json 或 lockfile。

## 界面证据与边界

原型为同一基线 product-prototype/public/file-templates-v2.html / file-templates-v2.js；实现为同一基线加本次移除改动。用户本次截图和要求为变更确认。原型中没有同名批量添加按钮；保留逐文种模板操作，不扩展修改其他原型历史差异。

- [桌面实现](desktop-synthetic.png) / [1440 原型](prototype-1440.png)：其他文件模板区域保留模板选择、预览、上传和年度字段，没有批量添加按钮；目视无新增裁切或异常空白。
- [手机实现](mobile-synthetic.png) / [390 原型](prototype-390.png)：底稿模板与上传操作布局仍可用。手机截图用于相邻底稿操作核验，未选择一般文种，不冒充手机一般文种专项截图。

实际浏览器运行真实前端，HTTP/账号/模板/上传字节/生成回执均为 synthetic。未调用真实模型、生产API/数据库、支付或生产模板导入；不声称复现或修复后台导入卡死根因。此次按用户要求移除触发入口与专用逻辑。

代码完成，尚未部署，待统一发布。最终统一验收待办：集成版中选择立项报告等文种，确认按钮已消失并复验自有Word上传与模板选择；用户验收状态尚未确认。

