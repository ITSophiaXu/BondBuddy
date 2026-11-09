# 历史／参考募集书首屏显示 — #923

- 用户页面测试／反馈日期：**2026-11-09（北京时间，Asia/Shanghai）**。
- 自动化测试及截图检查日期：**2026-11-09（北京时间）**。
- 代码与原型提交：`46e778bca11babce66032eb98a6d2fa5750ad86e`。
- 开发基线：`b16d942afc49812653d1482523b6963b14f22f61`；原型此前最近修改为 `fe3022cb`。
- Issue：<https://github.com/ITSophiaXu/BondBuddy/issues/923>。

## 修复与验证边界

完整更新工作区构造时立即显示历史／参考募集书标题、说明和上传区域。读取期间只显示加载提示，不显示虚假的文件计数；首次读取失败保留区域并提供重新读取。重试调用工作区原有材料恢复流程，同时恢复材料列表和任务准备状态。记录尚未确认时上传入口暂不可用，拖放不会导航或提交文件；记录确认后恢复原有上传与采用流程。

所有浏览器验证均使用真实 Web 代码、ApiClient、Edge 浏览器及合成 HTTP 响应。未连接生产数据库、对象存储、worker、模型或支付；未创建真实付费任务。图片不含用户截图或客户资料。开发和自测完成不代表用户验收或生产发布。

## 测试结果

- 新增首屏测试 **5/5 通过**：1440/390 宽度下挂起首个版本请求、失败重试后恢复已有文件及开始按钮、读取期间离开页面、原型状态对照。
- 相关募集书面板、采用、重入、原稿必填及上传恢复回归共 **65 个不同用例最终通过**。首次扩展运行 63/65；两项上传恢复测试在未修改基线也同样失败，原因是旧断言仍期待“已保存 V1”。更新为当前实际状态提示，并额外断言服务端未选用的稿件保持“未选用”，保留单次字节传输／同一会话／无采用请求的校验。受影响的恢复套件 11/11 复跑通过。
- 合计 **70 个不同浏览器用例通过**；最后定向复跑新增 5 项与恢复 11 项为 **16/16**。
- 基线反证：在未修改的 `b16d942a` 上挂起接口，新首屏用例因找不到 `.reference-prospectus` 失败；修复后通过。
- `npm run build -w @bondbuddy/web` 通过（包括 TypeScript 检查和 Vite 构建）。先构建 contracts、domain、rule-pack-registry、rule-applicability-context、api，满足现有 Web 测试的类型依赖。
- `npm run check:contracts` 通过：72 项测试、179 个合成示例、12 个内部库示例与 4 个生命周期示例。
- `git diff --check` 通过。无新增依赖、接口变更或数据库迁移。

复现命令（先在独立端口启动 Web，测试拦截所有业务接口）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5193'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
node ../../node_modules/@playwright/test/cli.js test tests/prospectus-first-paint.spec.ts tests/prospectus-panel.spec.ts tests/prospectus-selection.spec.ts tests/prospectus-saved-reentry.spec.ts tests/required-reference.spec.ts tests/upload-entry-recovery.spec.ts --reporter=list
```

## 同视口原型与实现截图

原型为 `product-prototype/public/prospectus-reference.html` 的 loading/error/empty 状态；实现为完整更新工作区中的募集书区域。截图使用相同视口，裁出相应卡片。

| 状态 | 1440 原型 | 1440 实现 | 390 原型 | 390 实现 |
| --- | --- | --- | --- | --- |
| 读取中 | [原型](prototype-loading-1440.png) | [实现](workspace-loading-1440.png) | [原型](prototype-loading-390.png) | [实现](workspace-loading-390.png) |
| 读取失败 | [原型](prototype-error-1440.png) | [实现](workspace-error-1440.png) | [原型](prototype-error-390.png) | [实现](workspace-error-390.png) |
| 确认无文件 | [原型](prototype-empty-1440.png) | [实现](workspace-empty-1440.png) | [原型](prototype-empty-390.png) | [实现](workspace-empty-390.png) |

对照：新增状态沿用原有标题、上传区和文件列表顺序，无横向溢出；加载结束后上传框纵向位置不变。完整工作区继承其既有边框、间距及按钮样式，独立原型页保留原有样式，本 PR 未修改 CSS。失败状态的具体错误由实际 API 返回，原型使用演示文案。新增首屏加载／失败提示与重试对应用户本次修复要求；用户实际验收尚未记录。

**代码完成，尚未部署，待统一发布。**
