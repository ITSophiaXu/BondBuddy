# 全部材料入口自动上传验证

基线：`859e7adac43b1e44fe2543e4ed18b24d0097dfed`，分支：`fix/all-material-auto-upload-20261028`。实现、原型及本证据以包含此文件的提交为准。用户要求是选中文件后立即上传保存，正常路径不再出现第二次“上传并保存”。

## 开发验证结果

- TypeScript 类型检查、Vite 生产构建通过。contracts、domain、rule-pack-registry、rule-applicability-context、API、worker 构建通过；本次未改后端。
- 契约测试 49 项通过，171 个合成示例、12 个内部资料库示例、4 个生命周期示例通过。
- 主浏览器组 178 项：最终 169 项通过、9 项按原条件跳过。首次运行 165 通过、4 失败；修正采用/删除反馈的旧文案断言后，4 项定向复验通过，其中一项为浏览器关闭超时后重跑通过。
- 追加跨页面组 62 项：最终全部通过。首次运行 45 通过、17 失败；更新新增只读资料库接口夹具、生成入口导航、旧手动上传点击后定向复验全部通过。下载超时用例在单 worker 复验通过。计数是首次运行与定向复验合并结果，并非一次完整运行全部通过。
- 另外复验了生成入口 2 项、手机生成工作台 1 项模板恢复场景；更新后的导入断言 2 项、来源页导航与原型截图 2 项通过。其中部分与前述组重叠，不累加为独立总数。
- `git diff --check` 通过。

主组文件：`desktop-file-workflow.spec.ts`、`integrity-upload-eleventh.spec.ts`、`project-workbench.spec.ts`、`prospectus-panel.spec.ts`、`prospectus-selection.spec.ts`、`review-upload-twelfth.spec.ts`、`review-workspace.spec.ts`、`word-roundtrip.spec.ts`。

追加组文件：`file-consistency.spec.ts`、`prospectus-saved-reentry.spec.ts`、`project-document-journey.spec.ts`、`project-file-return.spec.ts`、`project-file-status.spec.ts`、`consistency-originals.spec.ts`、`consistency-manual-reading.spec.ts`、`upload-entry-recovery.spec.ts`、`file-generation-workbench.spec.ts`，筛选 `upload|import|source|prospectus|template|recover|reentry|repaint`。

主要覆盖：选择和拖放自动上传、无效文件替换、文件类型/券商信息前置、重复文件、重复事件、上传中锁定、丢失回执、原字节重选、刷新恢复、原请求/版本条件、补证目标、保存后重入、显式采用及生成边界。诚信核查仅验证已保留旧补证草稿的附件，未恢复已取消的新建补证入口。

### 已知范围外问题

`mobile files appear before the collapsed directory` 仍有基线移动端间距断言失败（要求小于 330px，现有页面约 453px）。本次主组用 `--grep-invert` 排除此项，未放宽断言，也未把它记为通过。交统一集成验收时另行检查。

## 运行条件与复现

Windows、Node 22、本机 Edge，Vite `127.0.0.1:5258`。临时 Playwright 配置设置 `BB_E2E_BASE_URL`、`baseURL` 为该地址，`webServer: undefined`，浏览器 executablePath 为 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`。使用本工作区构建产物；未引用其他工作区的 contracts 编译输出。

启动 Vite 后，在 `apps/web` 用上述环境/配置执行：

```text
node ../../node_modules/typescript/bin/tsc --noEmit -p tsconfig.json
node ../../node_modules/vite/bin/vite.js build
node ../../node_modules/@playwright/test/cli.js test <主组文件> --grep-invert "mobile files appear before the collapsed directory" --workers=1
node ../../node_modules/@playwright/test/cli.js test <追加组文件> --grep "upload|import|source|prospectus|template|recover|reentry|repaint" --workers=1
```

完整本机运行日志为 `apps/web/auto-upload-*.log`，临时测试配置及日志不进入仓库。设置 `BB_UPLOAD_EVIDENCE` 可由上传测试生成完成/队列截图；设置 `BB_PANEL_EVIDENCE` 可生成相同视口的实现与原型截图。

## 图片与原型对照

- `update-uploaded-{1440,390}.png`、`consistency-uploaded-{1440,390}.png`：真实前端组件在合成 HTTP 上传成功后，没有二次上传按钮；版本已保存，采用仍独立。
- `prototype-{update,consistency}-uploaded-{1440,390}.png`：同视口原型的自动上传成功状态，原型明确标注模拟。
- `implementation-{empty,current}-{1440,390}.png` 与 `prototype-{empty,current}-{1440,390}.png`：同视口空状态及已有版本。实现延续既有项目信息说明、版本历史与上传折叠区；原型为简化展示，不声称逐像素一致。本次行为变化由用户要求确认，未把截图视为用户验收。
- `implementation-uploading-{1360,390}.png`：复核材料队列上传中，仍可看到原保存和恢复状态；`uploading-scene.json` 为合成场景记录。

已查看手机端和桌面端上传完成及原型对照图；自动布局断言无横向溢出。没有修改布局规则来掩盖上述基线间距问题。

## 真实与模拟边界

测试使用真实页面组件和 ApiClient、合成文件及模拟 HTTP。它证明浏览器交互、请求流程、恢复和隔离，不证明真实 API/对象存储联调、真实模型效果、计费入账或用户验收。未调用真实生成任务，未操作生产。

没有契约、数据库迁移、新依赖或积分规则变化。开发和自测完成后，仍需统一集成测试及用户验收，再由发布 chat 统一上线。
