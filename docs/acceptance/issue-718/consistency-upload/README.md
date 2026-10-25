# 一致性检查页募集书上传入口

2026-10-25 用户反馈：检查页提示“请先添加募集说明书”，却没有上传入口。关联 #718、#361。

缺少当前募集书时，检查页直接挂载已有 ProspectusPanel，支持选择 DOCX/PDF、明确保存为当前版本、选用版本历史及失败重试。保存后刷新当前项目的检查依据并留在原页；只有募集书和关联文件均存在时才能点击开始检查。新增“上传关联文件”链接到当前项目文件页，并保留“生成关联文件”。上传不自动检查、不发起生成、不扣费。页面刷新绘制保留待保存文件；离开页面释放上传组件。

原型与实现基于 develop `ef85ef9f1b42ecb39eea57ee54b8e43d62e41587`，复用 #733 已合入的募集书版本组件。本次对照：`product-prototype/public/prospectus-panel.html?purpose=consistency` 与 `apps/web/src/file-consistency.ts`、`prospectus-panel.ts`；两者在本交付提交一起固定。受影响的迁移页面是一致性检查空状态；更新/生成页仅扩展组件用途枚举，原有文案与行为保留。本次修复依据是用户所报入口缺失，未添加新业务流程。最终用户界面验收尚未发生。

同尺寸合成截图：

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440 × 960 | [原型](prototype-1440.png) | [实现](implementation-1440.png) |
| 390 × 960 | [原型](prototype-390.png) | [实现](implementation-390.png) |

截图裁切同一正文区域；两边标题、卡片、按钮、文案及响应式换行一致。原型仅演示交互；实现使用真实页面、ApiClient、XMLHttpRequest 和上传组件，测试拦截 HTTP 返回合成数据。没有真实存储、后台解析、模型调用或计费，本轮不把浏览器模拟当作后端端到端验收。没有调用生产服务。

验证：

- Edge / Playwright：`file-consistency.spec.ts` 和 `prospectus-panel.spec.ts`，13/13 通过。覆盖两种文件格式、项目 ID 与版本提交、保存后重新挂载、明确点击后才检查、缺关联文件继续禁用、读取失败重试、上传失败幂等重试、历史版本选用、重绘保留选中文件和释放组件；检查 1440/390/320 宽度无横向溢出。
- TypeScript：contracts、domain、API 编译，以及 web 全部源码/测试类型检查通过；Vite 生产构建通过（已有大包体积提示）。首次 web 类型检查缺少 API dist，生成依赖后通过。
- 首轮浏览器夹具把字节上传成功响应写成 200，现有 ApiClient 按契约只接受 204；将夹具修正为 204 后全部通过，未改变上传成功判定。
- `git diff --check` 通过。

命令（工作区根目录，运行 Node 24；复用已安装依赖，未变更依赖版本）：

```powershell
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
node node_modules/typescript/bin/tsc -p packages/domain/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/api/tsconfig.json
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
node node_modules/vite/bin/vite.js build apps/web
```

浏览器测试在 apps/web 启动独立 Vite 端口 5196；设置 `BB_E2E_BASE_URL=http://127.0.0.1:5196`、`BB_E2E_BROWSER_CHANNEL=msedge`，运行 `node ../../node_modules/@playwright/test/cli.js test file-consistency.spec.ts prospectus-panel.spec.ts`。设置 `BB_CONSISTENCY_EVIDENCE` 为本目录可重新生成截图。该临时服务器仅用于测试，结束后停止，不作为统一本地集成验收入口。

无 API、数据库迁移、worker 或新增依赖变更。开发和自测完成；代码完成，尚未部署，待统一发布。集成及用户验收待指定 chat 完成。
