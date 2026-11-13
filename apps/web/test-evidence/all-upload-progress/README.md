# 统一上传进度验证（2026-11-13）

关联：Issue #1317；产品要求见 `docs/product-decisions/2026-11-13-unified-upload-progress.md`。

普通上传统一显示“正在上传文件…”；实际传输占0–90%，服务器校验保存及后续必要记录读取使用同一进度条。正常完成才显示“上传成功”；有进度条的成功状态到100%。失败和暂停保留实际原因、原上传身份及恢复入口。

## 验证范围

- 141项单元测试通过，0失败/跳过：共享进度渲染、原上传恢复、丢失回执、账号/项目隔离、错误回执、文件重选、重复上传防护等。
- 完整 `npm run build` 通过（contracts、domain、规则包、API、worker、web）。
- 93个不同浏览器用例最终通过，0失败/跳过（分批执行，修正后定向复验）；Windows + Microsoft Edge，独立Vite端口5187。浏览器测试运行真实前端代码，HTTP服务及文件为合成夹具，不使用生产数据库、客户材料、模型或收费接口。
- 静态审核发现并修正初次创建上传会话时错误跳到90%的路径；延迟createUpload回归确保开始阶段不虚增进度。
- 服务器确认及募集书版本读取被分别延迟时保持90%，不显示成功；错误后仍沿同一上传恢复，不重复PUT。

## 页面与原型

原基线为 develop `4c2c1273`；原型与实现的受测代码均固定在 `c0d964e47991765013b637bb13a22832536b1dc8`，随后提交只补充证据登记。本PR同时更新 `product-prototype/public/upload-progress.html`、`prospectus-panel.html` 和共用CSS；用户2026-11-13的请求为本次状态变化依据。仅统一上传反馈，不改业务版本采用或生成流程。

同尺寸证据（1440×960及390×960）：

- `prototype-1440.png` / `prototype-390.png`：传输、等待结果、成功、失败四种状态。
- `reference-pending-*` / `reference-success-*`：与用户截图对应的历史/参考募集书入口，后台处理仍为同一上传条。
- `source-finishing-*`、`qa-finishing-*`、`material-finishing-*`、`assistant-finishing-*`、`template-finishing-*`：共享组件各入口延迟完成时的状态。

截图已人工查看：进度、文字和操作可见，无横向裁切；窄屏待上传文件名及说明占独立行，按钮不挤压文件名。目录内其他历史截图仅作为历史证据，不自动归入本次验证。

## 交付边界

无API契约、数据库迁移、依赖、模型提示词或费用规则变更。后台文件验证与幂等不变。本次不证明实际网络/保存耗时改善，不关闭#943性能排查。

状态：开发和自测完成；尚未准备统一本地集成验收版、尚未获用户验收、尚未部署。待集成chat合入固定批次验收，再由统一发布chat处理上线。

## 复验命令与夹具

依赖安装：`npm ci --offline --ignore-scripts --no-audit --no-fund`。先执行根目录 `npm run build`，再执行web单元编译 `tsc -p apps/web/tsconfig.test.json` 和 `node --test apps/web/dist-test/upload-progress.test.js apps/web/dist-test/upload-recovery.test.js apps/web/dist-test/upload-session-recovery.test.js`。

浏览器使用 `BB_E2E_BASE_URL=http://127.0.0.1:5187`、`BB_E2E_BROWSER_CHANNEL=msedge`，对应本工作区Vite服务。测试包为 `all-upload-progress.spec.ts review-upload-progress-autosave.spec.ts prospectus-panel.spec.ts upload.spec.ts workpaper-upload.spec.ts`（89项），另执行 `generation-save-feedback.spec.ts --grep "unified upload hides"`（4项）。最后复验了两种宽度的参考稿和原型截图、FG失败重试成功及底稿原文件重选。

两份既有夹具调整为当前协议：回执丢失须耗尽现有自动重试后才断言手动恢复；缺字节回执明确携带 `uploadBytesPending`，且区分未收到PUT回执的自动查询与已收到PUT回执后的原文件重选。未削弱服务端验证或放宽未知错误的重传条件。