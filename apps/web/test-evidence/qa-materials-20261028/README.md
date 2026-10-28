# 项目问答：项目资料、问题确认与回答成果

本批是用户 2026-10-28 要求的开发交付，关联 #722、#361。基础版本为 `859e7adac43b1e44fe2543e4ed18b24d0097dfed`。原型 `product-prototype/public/qa-materials.html` 与页面 `apps/web/src/project-qa-workspace.ts` / `.css` 在同一个实现提交中更新；对照基准为本 PR 的实现提交。需求决定见 `docs/product-decisions/2026-10-28-project-qa-materials.md`。

## 本批行为

- 先确认项目募集说明书。可在问答页上传、保存和采用版本；仅有问题清单时可免费整理问题，不能开始收费回答。
- 新回答必须包含项目当前采用的募集说明书，API 在创建任务和冻结积分之前检查，并将准确版本固定到任务。问题清单不能同时作为募集说明书。
- 候选问题直接在页面查看和确认；零候选时引导手选原文，不交付问题清单的转换 Word。
- 回答使用项目资料及可引用原文。缺证时列明具体补充材料、所需期间或字段和核对用途；必需募集书不可读时停止回答并释放预扣积分。
- 完成后下载包含回答、依据及待补材料的 Word，保留原题、历史版本及补件续答；收费规则不变。
- 工作区和弹窗统一无衬线字体、字号、行距及按钮层级。桌面资料与问题清单并列，窄屏依次展示。

## 视觉证据和对照

所有截图均使用 synthetic 项目、文件名、回答和积分，浏览器 API 为合成夹具。截图不能证明真实模型内容质量或真实计费执行。

| 状态 | 实现 | 原型／说明 |
| --- | --- | --- |
| 桌面缺少项目资料 | `materials-1440.png`、`component-1440.png` | `prototype-1440.png`；相同组件宽度 |
| 手机缺少项目资料 | `materials-390.png`、`component-390.png` | `prototype-390.png`；相同组件宽度 |
| 320px 窄屏 | `materials-320.png` | 无水平溢出 |
| 识别后确认问题 | `questions-1440.png` | 页内候选列表，无转换文件下载 |
| 回答和补件 | `answers-1440.png` | 固定募集书版本、回答 Word、逐题补件及下一轮入口 |
| 续答回归 | `qa-result-next-*.png` / `.json` | 原有长回答定位和下一轮准备流程 |

已查看桌面、手机和窄屏截图，确认文字、卡片、按钮和问题列表无裁切或横向溢出。实现保留全站导航、历史记录、项目文件入口和恢复控件，原型聚焦问答工作区；这些外层或既有状态是对照差异。清单卡片在全站主题下为实线边框，补件提示采用勾号图标，原型对应为虚线边框和文件图标，主要布局与操作一致。用户本次要求授权此设计调整，视觉细节仍待用户实际验收。

## 已执行验证

- contracts、domain、rule-pack-registry、rule-applicability-context、API、worker、web TypeScript 构建和 Vite 生产打包通过。仅有既有大 chunk 提示。
- 56 个问答 continuation/recovery/cache/journal/upload 单元测试通过；新增 3 个募集书门槛、缺证材料请求、上下文检索测试通过。
- 契约 171 + 12 个示例、4 个生命周期示例通过。
- Python 项目问答测试：5 passed、1 skipped；本机无 LibreOffice，旧 DOC 转换用例跳过。
- 浏览器 25 个不同用例通过：`project-qa-document-ux.spec.ts` 4、`project-qa-materials.spec.ts` 9、`qa-result-next.spec.ts` 7、`project-qa-task-routing.spec.ts` 5。另有 2 个可选旧 reference 截图用例因未提供基准而跳过，不计入通过数。
- 最后一次字体补查的 9 个用例中，8 个直接通过，1 个在浏览器 `page` 初始化阶段超时；该用例使用独立输出目录重跑通过（3.3 秒）。普通沙箱 shell 曾卡在启动阶段，核实并结束本任务的两个 shell 后，使用本机权限完成同一范围的检查。
- 本地真实 API + 独立 PostgreSQL + Azurite + worker + Python 综合端到端用例通过（1 passed）。覆盖缺少／未选入募集书的无扣费拒绝、固定版本、PDF/Word 上传和回答 Word 下载、权限、历史版本、暂停续跑、取消／失败退款。新增空白募集书用例验证 `MATERIAL_UNREADABLE`、不调用模型、无回答文件、完整释放预扣积分。
- 端到端使用合成模型返回；未调用真实模型，没有真实模型费用。测试数据库及存储独立，不连接生产。

主要复验命令（先构建对应包）：

```text
node --test packages/contracts/dist/project-qa.test.js apps/worker/dist/project-qa-materials.test.js
node --test --test-concurrency=1 apps/worker/dist/project-qa-e2e.pg.test.js
PYTHONPATH=python python -m unittest discover -s python/tests -p test_project_qa.py -v
cd apps/web
npx playwright test project-qa-document-ux.spec.ts project-qa-materials.spec.ts qa-result-next.spec.ts project-qa-task-routing.spec.ts
```

后端 E2E 需要 `BB_TEST_DATABASE_URL`、`BB_TEST_AZURITE_CONNECTION_STRING`、`BONDBUDDY_TEST_PYTHON`；浏览器可设置 `BB_E2E_BASE_URL`、`BB_E2E_BROWSER_CHANNEL`。本次合成环境只是开发测试证据，不是已向用户开放的统一本地集成验收版。

## 集成交接

无数据库迁移、依赖或价格变更。web、contracts、API、worker/Python 需同批集成；新增可选募集书快照和错误码保持旧记录可读，所有新回答由 API 强制固定募集书。旧幂等请求仍返回原任务，历史成果保留。

状态：开发和自测完成；用户验收待进行；尚未部署。由指定集成测试 chat 汇总到固定版本后提供统一入口，再由发布 chat 按用户授权统一发布。
