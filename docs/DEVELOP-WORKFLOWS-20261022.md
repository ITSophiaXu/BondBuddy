# 本会话项目功能开发交付（2026-10-22）

用户本次明确要求把这批代码合入开发分支。仓库开发分支为 `develop`。代码候选 `2351cb60e99cb8bca29548a882fee75d68064161` 同时包含以下六个 PR 的完整提交历史；基线为 `f52d5a16c23208a74cf2ae8ab13f2ed4a4769fbc`。合并只涉及开发分支，尚未部署，真实模型效果与用户验收仍分别待完成。

| PR | 范围 | 已包含的功能提交 |
| --- | --- | --- |
| #713 | 更新募集书、新建/已有项目与募集书版本 | `53925793` |
| #715 | 项目内复核、修订版/清洁版、手动设为当前稿 | `7a3b6e91` |
| #717 | 全部项目首页、任务摘要、项目文件和五列布局 | `d401be3c` |
| #719 | 模板文件生成、内容关联、免费检查、整份文件修订 | `09cf95f3` |
| #721 | 诚信核查及 52 个栏目 + 2 个属地网站的紧凑布局 | `4292d738` |
| #723 | 项目问答 Word 回填、每题 60 积分、公开案例管理检索 | `96907dae` |

原 `5195` 入口运行诚信分支，未包含后续问答代码；不是问答功能被删除。合并保留两边代码，唯一冲突是架构文档末尾的追加段落，两段均保留。新版主导航同时包含全部项目、更新募集书、复核募集书、文件生成、诚信核查和项目问答。

## 本轮验证

- Node 22 全工作区 `npm run build` 通过；保留既有 Vite 单包大于 500 KB 提示。
- `npm run check:contracts`：171 synthetic + 12 internal + 4 lifecycle 样例，以及 OCR 29 / issuer binding 11 项通过。
- `npm run test:unit -w @bondbuddy/web`：107 passed / 0 failed / 0 skipped。
- `BB_LOCAL_INSTANCE=qa-20261021 node scripts/local-integration/test-qa.mjs`：1 passed，真实本地 API/PG/Blob/queue/Word/计费/下载，模型适配器 synthetic。
- `BB_LOCAL_INSTANCE=integrity-20261021 node scripts/local-integration/test-integrity.mjs`：15 + 1 passed / 0 failed / 0 skipped，包含最新 54 项目录、证据范围、计费和项目聚合。模型搜索 synthetic。
- 第一次诚信回归使用了只迁移到 0114 的旧模板库，在项目文件汇总处缺少 `bb_project_qa_runs`。为隔离模板库补齐 0115 后以上回归全部通过；失败日志保留为 `integrity-tests-before-qa-migration.log` 和 `integrity-collection-before-qa-migration.log`。不能跳过问答迁移启动合并后的 API。
- 合并 worker 镜像断网导入 API/worker 问答及诚信模块成功，网站数 54、问答单价 60、LibreOffice 7.4.7.2 可用。镜像 `sha256:8020ae34d3698a5e7cd97f6538eb5085318880dbba273b80ede13a7609ace04f` 基于既有 QA 依赖镜像，仅覆盖本次已构建的 contracts/API/worker；Python、锁文件、系统依赖未变化。

GitHub Actions 的检查未执行：官方 annotation 为账户付款失败或 spending limit 限制（例如 run `39717498406`、`39581544863`、`39371833844`）。不能将这些失败标记描述为 CI 通过；本次记录的是上述本地验证。`develop` 没有必需状态检查，使用正常 PR merge，不绕过保护或修改账户计费设置。

## 迁移、运行与验收边界

全部功能依赖新增迁移 **0107–0115**，应按顺序与 API/worker/web/contracts 一起集成。问答 worker 需要 LibreOffice Writer 和 Noto CJK。检查免费，整份关联文件更新 4,500 积分；诚信核查每轮 5,000 积分；Word 问答按确认后的问题数每题 60 积分。旧文件版本、同轮免费补证/导出和幂等规则均保留。

本会话两个本地实例为 `integrity-20261021`（web 5195 / API 3025 / PG 15445 / Blob 10025）与 `qa-20261021`（5197 / 3027 / 15447 / 10027）。各自数据保留并隔离；更新时都使用完整代码，避免功能分支入口造成缺项。账号 `integration_user` / `Local-Test-2026!`，仅合成测试积分。最终运行状态以对应 runtime 的 `services.json`、`status.json` 和实际浏览器检查为准，不把地址本身当作服务可用证明。

在各自工作区使用 Node 22 和正确实例名运行：

```powershell
$env:BB_LOCAL_INSTANCE='integrity-20261021' # 问答实例改为 qa-20261021
node scripts/local-integration/status.mjs
node scripts/local-integration/stop.mjs
node scripts/local-integration/start.mjs
```

停止保留数据，并检查活动任务与进程身份。启动不自动提交模型任务。本轮未调用真实模型或企业官网核查，不把合成输出冒充真实效果；真实问答/核查、公开案例补充、设计与 Word/WPS 验收交最终统一验收。本文件是本会话开发交付记录，不替代指定集成 chat 的共享交接与用户验收结论。
