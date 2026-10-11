# 创建项目信息：常驻字段注释验收

文案依据为用户提供的《20261011-更新募集说明书创建项目提示文案.docx》修订后表格（保留插入、排除删除）；28 项逐项核对。仅将“如两个个品种”订正为“如有两个品种”。用户明确要求将输入框占位提示改为填写后仍可阅读的注释；确认人与偏离依据见 [产品决定](../../../../docs/product-decisions/2026-10-11-project-field-notes.md)。

## 同尺寸界面对照

原型入口为 `product-prototype/public/project-workspace.js`，当前创建及编辑页实现为 `apps/web/src/update-form.ts`。旧原型与当前已迁移页面已有差异，因此以下使用本次修改前的真实前端 `fd1f10fd` 作为界面对照基线；不是旧原型服务器截图，也不是生产验收。

| 视口 | 修改前（fd1f10fd） | 修改后（本 PR） |
| --- | --- | --- |
| 桌面 1440 × 960 | [before-1440.png](before-1440.png) | [after-1440.png](after-1440.png) |
| 手机 390 × 960 | [before-390.png](before-390.png) | [after-390.png](after-390.png) |

截图均为完整页面，使用相同合成填写值。修改前截图加载基线表单模块；修改后截图由新增浏览器测试生成。`preview-*.png` 为修改后截图顶部 1500 像素的预览裁切。

- 输入金额、名称及说明后，注释仍显示在控件下方；金额与单位共用一条注释。
- 桌面保留原有双列布局；手机正常换行，无重叠或横向溢出。
- 受托管理人及存续期管理人列入承销安排；其他参与机构按修订稿显示“如律师事务所等。”。
- 原有分区及动态资金用途说明保留，按修订稿更新文案。标签、必填规则和流程保持原有行为。

## 自动化验证

环境：Windows，Bundled Node.js，Playwright / Microsoft Edge；本地 Vite `http://127.0.0.1:5188`。使用合成 API 响应，不调用真实模型、不收费、不创建真实业务任务。

- 相关 TypeScript 构建通过：contracts、domain、rule-pack-registry、rule-applicability-context、api、worker、web；Vite 生产构建通过（保留已有大于 500 KB 的 bundle 提示）。
- contracts 校验通过：171 + 12 个示例、4 个生命周期示例、40 项测试。
- 新增专项浏览器测试 **2/2 通过**，覆盖 1440 / 390 像素宽度：输入后可见、可访问描述、用途增删与重排、提交真实输入值、保存及刷新恢复、无重复 ID / 横向溢出，且不触发执行接口。
- 扩展检查 `prototype-corrections.spec.ts` 与 `prototype-workflow.spec.ts`：**16 通过、4 失败**。下表 4 项在 `fd1f10fd` 基线表单及 contracts 上均复现同样失败，未作为本次通过项，也未修改无关测试。
- `git diff --check` 通过。

| 既有测试 | 当前失败的旧预期 | 基线复现 |
| --- | --- | --- |
| quarter selection → create → upload → original footer action → refresh recovery | 查找已取消的历史稿“有”单选项 | 同样超时 |
| all quarter ends and year changes preserve existing periods, uncertainty and old non-quarter dates | 查找已移到材料页的“补充说明与写作要求” | 同样超时 |
| prototype dashboard leads through creation to materials with persistent material-footer requirements | 工作台仍应存在 4 张 `.workflow-card` | 同样为 0 |
| unavailable modules retain original navigation but never create demo work | 已开放的模块仍应显示“这项功能尚未开放” | 同样不存在 |

可复验命令（在正常 npm 环境执行，先启动本地 web）：

```sh
npm run build
npm run check:contracts
BB_E2E_BASE_URL=http://127.0.0.1:5188 BB_E2E_BROWSER_CHANNEL=msedge npx playwright test tests/prototype-workflow.spec.ts --grep 'project guidance stays visible' --reporter=list
BB_E2E_BASE_URL=http://127.0.0.1:5188 BB_E2E_BROWSER_CHANNEL=msedge npx playwright test tests/prototype-corrections.spec.ts tests/prototype-workflow.spec.ts --reporter=list
```

前两条在仓库根目录运行，后两条在 `apps/web` 运行。本地无 npm，实际使用 Bundled Node 直接运行对应 TypeScript、contracts 及 Playwright CLI。上述证据验证实现与合成交互，不代表线上部署或最终用户账号验收。
