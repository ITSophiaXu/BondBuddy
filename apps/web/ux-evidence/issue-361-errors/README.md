# #361 上传和启动错误状态（B02、B04）

原型依据：`product-prototype/public/project-workspace.js` 的材料文件行、材料步骤页脚主操作，
以及已确认 #85 的原工作区状态区域。对照基准为原型
`23fd64fa22185b21015684b885526bc4247e98cd`（当前 `develop` 中对应源码未变）：
[材料页 1440×960](bb361-errors-reference-materials.png)、
[材料页 390×844](bb361-errors-reference-materials-mobile.png)、
[页脚主操作 1440×960](bb361-errors-reference-materials-footer.png)、
[页脚主操作 390×844](bb361-errors-reference-materials-footer-mobile.png)。
原型截图选择“没有本发行人历史稿”，显示错误发生前的材料工作区；
原型不模拟服务端安全检查失败，故比较的是同一页面结构与错误反馈落点，
不是宣称两种错误由原型演示服务真实触发。
本切片不改变原型布局、按钮、步骤或导航，只在原位置替换错误反馈；实现 commit 见关联 PR。

| 状态 | 1440×960 实现 | 390×844 实现 | 行为与偏离 |
| --- | --- | --- | --- |
| 上传检查未通过（对照原型材料页） | [桌面](upload-error-desktop.png) | [窄屏](upload-error-mobile.png) | 同一文件行展示公开安全原因及关联编号；重试/移除此行位置不变。不能核验外部工作簿引用不等于原文件损坏 |
| 无历史稿输入被当前入口拒绝（对照原型页脚） | [桌面](generation-input-desktop.png) | [窄屏](generation-input-mobile.png) | 材料步骤页脚显示准确的当前状态和支持编号，不要求把相似稿误标为本发行人历史稿；不新增审核面板 |

两侧截图均为 Chromium 实际渲染，桌面像素 1440×960、窄屏像素 390×844；
测试账号、文件内容、项目与响应均为 **synthetic**。启动时服务端是否已连接新稿、
原用户遇到的首次泛化错误属于哪一个接口/原因、原项目暂停循环（#384 B10）均
不能由这些合成 HTTP 截图证明。#35 仍须在准确部署 SHA 上记录原请求阶段、
关联编号、是否已有 run、刷新和重开状态、真实可操作下一步及连续复测结果。

复现：

```sh
npm run build
npm run test:unit -w @bondbuddy/web
npm test -w @bondbuddy/web -- --workers=1 tests/project-execution.spec.ts tests/upload.spec.ts
BB_UX_EVIDENCE_DIR=apps/web/ux-evidence/issue-361-errors BB_UX_EVIDENCE_PREFIX=bb361-errors node apps/web/scripts/capture-prototype.mjs
BB_361_ERROR_EVIDENCE_DIR="$PWD/apps/web/ux-evidence/issue-361-errors" npm test -w @bondbuddy/web -- --workers=1 tests/project-execution.spec.ts tests/upload.spec.ts
```

本切片保留原 `Error` 契约结构：`field_errors` 仅在安全的上传检查拒绝时
使用 `material_upload` 和有限公开原因码；`correlation_id` 是服务端关联编号，
不在界面输出解析日志、证据编号或原始异常。未携带安全原因时给中性说明，
不会凭 `MATERIAL_UNREADABLE` 猜文件损坏。
