# 已有募集书进入文件生成

首次发现日期：2026-11-13（北京时间）。用户反馈在文件生成第一步采用项目已有 V3 清洁版，点击下一步后“正在保存”约一分钟。缺陷登记：[Issue #1325](https://github.com/ITSophiaXu/BondBuddy/issues/1325)。基线 `034ce52f0d88fd83d681f54ef7211c88493b7dae`。

## 原因与修复

`FileWorkspace.continueFromSource` 原先无论进入统一准备页还是旧文种页，都会调用 `/project-files/source`。此旧接口在项目行锁内导入募集书，再保存全部 12 种文种的 M4 草稿。生成稿首次导入涉及整份 Blob 读取、复制和读回校验；已导入的稿件复用材料。它不运行模型或重新解析正文。没有该用户请求的生产时长日志，不将一分钟精确归因于某个环节。

统一准备页的报价、提交接口已有按实际所选文种准备材料的逻辑。修复将进入该页的操作改为只读取并核对当前版本，跳过旧接口。旧文种页继续使用原准备接口，保留其输入版本与恢复行为。

核对时显示“正在核对募集说明书…”，读取超过 15 秒恢复按钮并提示重试，已保存文件保留。版本变动或当前稿消失时仍停止进入下一步。

## 验证边界

验证环境：Windows、本地 Edge，独立工作区与 127.0.0.1:5325 临时 Vite。浏览器回归使用真实页面和合成 HTTP，未访问生产后端。

- `generation-existing-source.spec.ts`：5/5 通过。覆盖已有生成稿直接进入统一准备页且无 source/上传/草稿写入请求、版本变动拦截、当前稿移除、旧文种页兼容、读取超时后重试。
- `generation-navigation-recovery.spec.ts`：8/8 通过，上传恢复、未确认采用及离页保护保留。
- `generation-source-ux.spec.ts`：5/5 通过。
- `file-generation-flow.spec.ts`：15/17 通过（包括 1440/390/320 原型页面）。两项旧上传测试在文件已自动确认并采用 V4 后仍等待“重试上传”按钮，保持失败记录，未删断言、跳过或放宽超时。
- 基线对照：临时恢复 `034ce52f` 的原始 `file-workspace.ts` 后，上述两项旧上传测试同样失败，且新“已有生成稿零写入”回归明确捕获多余的 `/project-files/source` POST；随后完整恢复修复文件。故没有将两项旧失败冒充本次通过，也没有混入上传范围修改。
- contracts/domain/rule-pack-registry/rule-applicability-context/API TypeScript 编译、web `tsc --noEmit` 及 Vite production build 均通过。首次 web 类型检查因独立工作区尚未编译 API/domain 依赖报缺失，按依赖顺序构建后通过；不是忽略类型错误。
- 独立代码审查通过：统一页按需导入、权限和版本校验保留。无需 API/worker 代码配套发布。

命令（工作区根目录，Node 直接调用本地已安装工具）：

```powershell
node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json
foreach ($project in @('packages/domain','packages/rule-pack-registry','packages/rule-applicability-context','apps/api')) {
  node node_modules/typescript/bin/tsc -p "$project/tsconfig.json"
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
node node_modules/typescript/bin/tsc --noEmit -p apps/web/tsconfig.json
node node_modules/vite/bin/vite.js build apps/web
# 以下在 apps/web 运行；BB_E2E_BASE_URL 指向本工作区临时 Vite，BB_E2E_BROWSER_CHANNEL=msedge。
node ../../node_modules/@playwright/test/cli.js test tests/generation-existing-source.spec.ts tests/generation-navigation-recovery.spec.ts
node ../../node_modules/@playwright/test/cli.js test tests/generation-source-ux.spec.ts tests/file-generation-flow.spec.ts
```

本次只修改 web，不修改 API、worker、契约或数据库，无新依赖、迁移或模型调用。用户实际项目的一分钟耗时未在生产重放。

代码完成，尚未部署，待统一发布；未纳入统一本地集成验收版，用户尚未验收。
