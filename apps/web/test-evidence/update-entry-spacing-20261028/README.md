# 更新募集书：已有项目折叠栏留白修复

用户于 2026-10-28 提供截图，指出“继续已有项目”入口过窄。基线为 develop `859e7adac43b1e44fe2543e4ed18b24d0097dfed`，分支 `fix/update-entry-spacing-20261028`。

## 原因与调整

共享选择器 `.project-entry-page .update-entry-existing` 的 `padding: 22px 24px 0` 比原先 `.project-entry-update > details` 的 `padding-bottom: 22px` 优先级更高，收起时下内边距实际为零。桌面折叠栏仅高 48px，文字贴底。

将此入口的上下留白放到原生 `summary` 上，外层只保留左右空间。桌面上下各 24px，手机上下各 18px；整行包括留白均可点击。保留原生展开箭头、Enter/Space 切换，补充内嵌键盘焦点框。展开后减少搜索框上方重复间距，项目列表继续独立滚动，操作栏保持可见。

只修改 `product-prototype/public/project-entry.css`，实际前端与交互原型共用此文件。用户本次截图要求是留白调整依据；没有改变页面流程或新建优先结构。原型 `product-prototype/public/project-entry.html` 的桌面和手机交互由现有测试核对。以下同尺寸截图使用实际页面及同一基线样式，修复前通过替换该单份样式复现；其他文件与测试数据完全相同。

| 尺寸 | 修复前 | 修复后 | 展开后 |
| --- | --- | --- | --- |
| 1440 × 960 | [before-1440.png](before-1440.png) | [after-1440.png](after-1440.png) | [expanded-1440.png](expanded-1440.png) |
| 390 × 844 | [before-390.png](before-390.png) | [after-390.png](after-390.png) | [expanded-390.png](expanded-390.png) |

## 验证

- 现有 Edge `project-entry-layout.spec.ts`：25/25 通过，包括五种工作入口、1440/390/320 宽度、项目分页与搜索、空结果、失败重试、键盘选择、助手展开及入口跳转。
- 额外浏览器检查覆盖 1440 × 960、1024 × 768、390 × 844、320 × 640：折叠栏文字上下留白相等，整行点击及 Enter/Space 切换正常，无横向溢出，展开后按钮在视口内。桌面高度 48 → 80px，手机高度 58 → 66px。详见 [measurements.json](measurements.json)。
- 已目视核对桌面和手机的收起与展开截图。
- Web TypeScript 检查和 Vite 生产构建通过；保留既有大包体积提示。独立工作区先编译 contracts、domain、rule-pack-registry、rule-applicability-context 与 API，以满足既有 web 测试的类型引用；未运行后端服务。

复验：在 `apps/web` 运行 `node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5238 --strictPort`，设置 `BB_E2E_BASE_URL=http://127.0.0.1:5238`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node ../../node_modules/@playwright/test/cli.js test project-entry-layout.spec.ts`。

全部账号、项目与 HTTP 响应均为 synthetic；浏览器运行真实前端代码。没有连接真实 API、数据库或模型，不代表用户已验收。无依赖、公共契约、迁移或费用变动，后续只需统一发布 web。

**开发与自测完成；未纳入统一本地集成版，用户尚未验收。代码完成，尚未部署，待统一发布。**
