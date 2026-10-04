# M3 常驻助手与复核结果联动实施记录

范围：#47、#55、#145、#537、#538；按 #3、#56 的 A01–A22 修订验收。实现分支 `codex/m3-linked-review-workspace-20261004`，develop 基线 `792a8e39a7ad5e3359ca8a28fab0ee0c238d5349`。产品决定见 `docs/product-decisions/2026-10-04-review-assistant-linked-workspace.md`。

## 实现结果

- 桌面复核页为材料／结果两标签与右侧常驻助手。任务时间线由持久消息和真实 run/event 投影，快捷执行不会伪造用户聊天或新增助手模型调用；窄屏保留唯一抽屉入口。
- 助手回复保存经宿主验证的报告／问题引用。完成卡和问题讨论双向定位准确报告；回看历史时新结果通过入口提示，不强制覆盖历史视图。版本历史仍在工作台。
- V2 提议明确完整、差异或修订类型，绑定输入、报告 hash、材料版本、选中／关联／排除范围。采纳只保存要求；明确执行通过已有项目互斥和幂等入口创建任务。worker 验证已采纳要求实际进入 CLI 输入。
- 差异报告记录本轮检查、沿用来源和未完成原因。缺失 finding 不表示解决；解决要求本轮同一检查和有效证据。修订保留原报告，提供实际处理记录与真实双 Word，显示已修改待复核，不自动重新复核。
- 保留 V1 助手与已完成模型结果恢复。事件使用公开白名单，错误仅输出安全原因；晚到取消／过期任务不能登记报告。统一项目→run→job 锁顺序，防止目录竞态。
- 证据批量校验一次建立索引，避免大材料的逐条全量扫描。既有租约恢复继续原 run，不新增任务或改写任务状态。

Codex CLI 仍是唯一 AI 引擎；API、worker、PostgreSQL 队列和私有 Blob 沿用现有平台。新增迁移只有 `0088_m3_linked_assistant.sql`，旧迁移没有改写。develop 已有的 `0087_m2_fixed_credits.sql` 保留，M3 不调用收费、报价、充值或用户扣费路径，旧试用任务仍为 `platform_trial`。

## 自动化证据

最终 Linux 构建使用 WSL `BondBuddyM3`，隔离源码 `/opt/bondbuddy-local-m3/linked-tests/20261004/source`；API／worker 测试使用独立模板数据库与按测试克隆的数据库、实际 PostgreSQL／Azurite。没有修改用户运行数据库。

| 验证 | 命令／用例 | 实际结果 |
|---|---|---|
| 全仓库编译 | `npm run build`，contracts→domain→registries→API→worker→web | exit 0 |
| 公共契约 | `npm run check:contracts` | 166 synthetic + 12 internal examples，4 lifecycle examples；OCR 29、issuer 11 测试通过 |
| 规格汇编 | `node product-prototype/product-specs/build-spec.mjs` | 19 模块、323 链接、141 表格、4 JSON 示例，0 错误 |
| 证据校验 | `node --test packages/domain/dist/review-evidence.test.js` | 10 pass，0 fail，0 skip；12,000 条批量校验完成 |
| API | `node --test --test-concurrency=1 apps/api/dist/{run-event-dto,review-linked-workspace,review-workspace}.test.js` | 8 pass，0 fail，0 skip；含已采纳修订要求转新快捷计划的完整组合 |
| worker | `node --test --test-concurrency=1` 后接下列十个测试文件 | 110 pass，0 fail，0 skip |
| 完整文件链 | `BB_TEST_M3_CLI_REVISION=1 node --test apps/worker/dist/m3-review-pipeline.pg.integration.test.js` | 1 pass，0 fail，0 skip |
| web 单元 | `npm run test:unit -w @bondbuddy/web` | 61 pass，0 fail，0 skip |
| web E2E | `apps/web/tests/review-workspace.spec.ts`，Microsoft Edge Chromium | 28 pass，0 fail，0 skip；最终约 1.0m，exit 0 |

worker 文件：`review-assistant-linked`、`review-follow-up`、`review-assistant`、`review-model-stage`、`review-public-stage`、`review-tools`、`review-reassembly`、`review-word-registration.pg.integration`、`review-revision-cli-stage`、`review-revision`（均为 `apps/worker/dist/*.test.js`）。相关工程测试共 218 项；公共契约 40 项测试和 182 个样例另列，重复的 Windows worker 测试不累加。

**所有模型回复和业务样本均为 synthetic。** 完整文件链实际执行上传解析、受控 CLI 协议／工具、PostgreSQL journal、Blob 下载和 Python 双 Word；它不代表真实供应商或专业结论已验收。日志、测试环境收据与本地部署记录在专用宿主的 `diagnostics/m3-linked-implementation/`，私有备份不提交到仓库。

## A01–A22 覆盖与边界

| 验收 | 自动化证据 |
|---|---|
| A01–A02 | 常驻布局、桌面发送区可见、窄屏抽屉／焦点／草稿／无横向溢出，UI E2E |
| A03–A05 | 快捷入口任务投影、真实阶段和稳定卡身份、准确成果定位，API + UI E2E |
| A06–A08 | 引用元数据、讨论不执行、明确提议范围和采纳、执行来源 hash、实际 CLI 输入要求，API + worker + UI E2E |
| A09–A10 | follow-up 本轮／沿用／未覆盖，丢失 finding 不解决；完整范围与讨论引用分离；公开未命中不冒充无风险，worker + UI |
| A11–A13 | 历史视图固定、新结果入口、修订计划与双 Word、无空计划执行／自动重核，worker + pipeline + UI |
| A14–A15 | 独立草稿及引用、刷新／窄屏切换；执行输入固定，随后保存的新要求不改变原 run，API + assistant snapshot + pipeline + UI |
| A16–A18 | 并发项目锁、丢响应同 intent 重试、输入／报告／材料过期拒绝、V1/V2 恢复、未知调用不重发、终态不倒退，API + worker + UI |
| A19–A20 | 停止／失败左右状态和安全原因、取消或过期登记拒绝、跨归属／引用／raw 输出边界，API + worker + UI |
| A21 | 无用户收费事件、未知 usage 保留；唯一 CLI 与平台护栏，assistant PG + pipeline |
| A22 | 工作台历史入口、准确旧报告／成果、复核页无版本列表；两尺寸原型对照，本地部署另有收据 |

真实供应商对自然语言的理解、专业复核／修订质量及 Word/WPS 客户端显示仍归最终统一验收。A14 的完整登出重登交互没有在真实用户会话操作，持久草稿与归属由 API 验证；不能用 UI mock 断言替代真实供应商测试。

## 原型对照

基准 `review-v2` commit `3d72bafc662d27659981154032a9cce1981f5be9`。对照尺寸 1360×900、1280×720、581×753；新建浏览器上下文，不改变用户原型 localStorage。`apps/web/test-evidence/m3-linked/` 保留实际生产组件的 synthetic 截图和同尺寸原型截图；数据和真实覆盖数量按 API 展示，不复制演示结论。

按用户已确认决定，顶部发行人／市场占位元信息已移除；正式项目标题来自真实项目名。可见任务阶段来自 host 事件，不展示模拟思考文本；真实失败／未覆盖项如实显示。桌面发送区已针对初次进入时 panel top 修正高度。

较矮桌面窗口根据实际可用高度启用紧凑布局，压缩说明／上下文／输入区，保留完整绑定与功能；1280×720 的时间线高约 228px，任务卡、发送和补证入口均可见。新增 E2E 验证 resize、草稿与真实任务投影的可读高度。

历史聊天气泡显式隔离全局账号 `.user` 的横排样式；时间、正文、引用上下文和安全中断提示按纵向阅读顺序展示，正文宽度与气泡保持一致。720px E2E 直接校验排版与宽度，不仅断言文案存在。

助手上下文显示真实项目、输入与讨论对象；回形针复用材料上传并保留原草稿／引用。快捷修订计划用一次明确确认直接执行，固定确认时的来源和计划版本；丢响应重试复用请求，刷新确认已提交任务后关闭对应执行窗口。已采纳 V2 要求转新的快捷计划仍保留要求，执行来源明确为新的 quick_action；旧提议及执行不改写。

## 本地交付

业务入口 `http://localhost:18081`，原型 `http://127.0.0.1:4320/review-v2.html`。更新使用内容 hash test gate，备份现有代码和数据库，保留登录、私有材料、Blob、服务定义和 Copilot／sandbox 配置。新增 schema 可保留，回滚只恢复代码，不能将数据库快照覆盖后来用户工作。

本轮只部署本地测试环境。实际安装的 commit、候选 digest、服务状态、迁移及运行会话 smoke 由宿主的 `deployment-result.json`、`IMPLEMENTATION-ACCEPTANCE.md` 留证。公开网络检索仍未开启，该维度必须显示缺口，不能标为已经完成公开核验。
