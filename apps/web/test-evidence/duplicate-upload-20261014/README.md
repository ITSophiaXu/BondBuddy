# 重复文件上传反馈验证（2026-10-14）

基线：`develop d71bf682c71b5c9df3e11f72c260092ee4bfd827`。原型与实现代码提交均为 `a857d379989757634247f584426af903d5f660af`；后续提交只保存本验证记录及截图。全部截图和文件内容均为 synthetic。

## 验证范围

- 更新：连续/批量重复、改名相同内容、混合新文件、刷新已保存列表、同名不同内容和不同分类独立保存，1440×960 / 390×960。
- 复核：缓存完成回执、改名重复、刷新页面后再上传、结果页补证弹窗、上传中再次选择、草稿保存失败后重试，材料引用和补证问题不丢失。
- 材料生成：募集书和补充材料重复提示；助手：附件重复、收起/展开保留提示、连续上传完成重绘保持同一原生文件选择节点。
- 原有上传确认丢失、字节确认丢失、过期认证、单文件失败/重试、删除、材料恢复及账号/项目隔离回归。
- 真实本地 PostgreSQL 隔离克隆库 + Azurite：并发改名上传复用、完成重放、归属隔离、容量边界、60文件边界及部分失败。没有接触生产数据或运行模型。

## 可复现命令

先按根 `package.json` 构建 contracts/domain/rule 包/API，再运行 web 类型检查和 Vite 构建。此工作区复用已安装的依赖目录，workspace 包链接指向本工作区，未修改锁文件或共享包源码。

独立 Vite 端口 5196，仅作本次自测；不是用户统一本地验收入口。

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5196'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_DUPLICATE_EVIDENCE=(Resolve-Path 'test-evidence/duplicate-upload-20261014').Path
node ../../node_modules/@playwright/test/cli.js test tests/upload.spec.ts tests/review-workspace.spec.ts tests/m4-workspace.spec.ts tests/project-assistant.spec.ts tests/duplicate-upload-prototype.spec.ts --grep 'upload|attachment|template|duplicate feedback|editable task card|mobile assistant|desktop, focus'
```

真实存储用例：`node --test apps/api/dist/upload-reuse.test.js`，设置 `BB_TEST_DATABASE_URL` 为本地空模板库，`BB_TEST_AZURITE_CONNECTION_STRING` 为本地 Azurite。测试辅助程序创建/删除私有克隆库，上传测试使用独立容器。

契约检查：`check-examples.js`、`check-data-lifecycle.js`、`ocr-v2.test.js`、`generation-issuer-binding.test.js`。

## 结果与真实边界

- 最终 Edge 浏览器回归 **42/42 通过**（1.6分钟），包括新增草稿重试及助手布局/焦点检查；无跳过。
- 真实存储 3/3；171+12 契约示例、4 生命周期示例、40 契约测试通过。
- contracts/domain/rule 包/API 编译及 web TypeScript / Vite 构建通过；Vite 保留已有的主包大于500KB提示。
- 初次新增浏览器测试使用了旧的复核标签属性，并在助手初始化完成前选择文件；修正为当前可访问标签和等待可操作状态。随后连续附件测试暴露真正的文件选择框重绘丢事件，已保留节点并加入确定性节点身份断言。没有用重试掩盖实现问题。
- 页面测试使用模拟 HTTP 回执，不表示浏览器真实后端全链路或模型生成已经验收；真实后端去重由独立存储用例覆盖。无模型调用、积分或生产变更。

## 原型对照

原型 `product-prototype/public/duplicate-upload-feedback.html` 是重复提示组件的增量基线，与实现共用提示 CSS。对照仅针对提示的位置、色彩、文字与换行；原型示例容器不替换任何业务页面。

| 尺寸/范围 | 原型 | 实现 |
|---|---|---|
| 桌面 1440×960 | prototype-1440.png | update-page-1440.png、review-page-1440.png |
| 手机 390×960 | prototype-390.png | update-page-390.png、review-page-390.png |
| 上传区细节 | 同一组件样式 | update-1440/390.png、review-1440/390.png |
| 材料生成/助手 | 同一组件样式 | material-source.png、material-material.png、assistant.png |

人工查看桌面/手机截图：提示可读、文件名正确换行，无横向溢出。提示放在原有分区下方，助手放在附件状态区；未增加确认弹窗、操作步骤或导航。截图中的“处理状态暂不可用”来自上传用例未模拟解析服务，不能据此宣称解析失败或真实文件损坏。

需求确认来源：用户2026-10-14本次修复要求。开发/自测完成后仍需统一集成与用户实际验收；尚未部署。
