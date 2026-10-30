# 募集说明书格式模板选择验收

来源基线：develop c7d0c42；截图与测试针对该基线之上的当前未提交模板保真修改，不是 c7d0c42 原始实现的验收。具体源文件及截图 SHA-256 记录在 `provenance.json`，整合提交后可通过这些 hash 核对。

实现：`apps/web/src/source-format-template.ts`、`source-prospectus.ts`、`main.ts`、`project-execution.ts`。
原型：`product-prototype/public/project-workspace.js` 的历史／参考募集书材料区域。
共用样式：`product-prototype/public/source-prospectus.css`。

新增控件位于原稿信息框顶部，显示“沿用此稿格式”；多份原稿中单选。材料区显示实际选中文件，允许恢复自动选择。选中的材料版本已失效时显示提示；PDF 标明将重建为可编辑 Word。沿用成果续改时显示“沿用所选成果格式”，隐藏其他原稿格式选项。

## 自动化证据

测试使用 Edge 与本工作区独立 Vite 服务（127.0.0.1:5197），所有 HTTP 文件、账号、任务及回执均为合成数据。验证真实网页组件、ApiClient 和草稿保存信封，不代表真实模型或 Word 编制验收。

以下命令在 `apps/web` 目录运行；重跑前在独立终端启动 `npm run dev -- --port 5197`。本次验收结束后已停止该服务，并确认 5197 端口关闭。

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5197'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
npx playwright test tests/source-format-template.spec.ts --reporter=line
npx playwright test tests/authoring-continuation.spec.ts --grep 'template fidelity' --reporter=line
```

结果：格式模板页面测试 7 项通过（首批 6/6，随后新增的参考稿新编场景 1/1）；成果续改测试 1/1 通过；既有 source guide 的准确定位和逐份填写后执行两项回归 2/2 通过。`tsc --noEmit -p apps/web/tsconfig.json` 通过。

收尾时再次在本工作区的 5197 服务运行 `source-format-template.spec.ts --grep 'shared prototype'`，1/1 通过并重新生成本目录全部四张截图。该次复验是上述 7 项中的同一测试，不重复计入 10 项独立 UI 验收。早期误用 5173 的失败尝试未作为验收证据。

覆盖自动推荐、精确版本保存、刷新恢复、来源元数据编辑、失效版本处理、PDF 提示、运行锁及程序触发事件防护、成果续改及切回上传原稿。

## 原型对照

`implementation-1440.png` / `prototype-1440.png` 与 `implementation-390.png` / `prototype-390.png` 为同宽控件截图。原型截图通过真实 `projectWorkspace().page('update')` 获取原型控件，在同样的材料行容器和共用样式中渲染；没有复制实现控件当作原型。原型与实现文案一致，两种宽度无横向溢出，已人工查看图片。

本次用户已确认执行的方案明确包含现有材料区的格式单选，不增加独立页面或确认步骤。原型修改位置和最终提交需由主实施记录同步至前端 Issue #361；本子任务未发送外部消息。
