# 原稿更新质量恢复：开发交接

日期：2026-10-31。分支：`fix/prospectus-baseline-quality-20261031`。基线：`develop 6efbb5fc`。

本次恢复实际编辑原稿的身份约束，以及同一次编制内自行复核、交付后独立诊断。10 月 2 日 #529 的“不运行额外内容、格式或修订一致性检查”会让原稿关系失去核对；#804 的格式保留仍不能证明清洁版和原稿关系正确。新主提示先读 `baseline-quality.md`，明确以本次指定原稿为正文基础，完整读取、只改有依据的内容、保留未受影响原文及原目录，在同一次 CLI 内检查并修正。机械诊断本身不能判断一段改写是否有业务必要。

## 交付范围

- 精确匹配上一版成果/复核源稿的 ID、版本和 hash；有锁定原稿声明而实际材料缺失时不再静默改用别稿或新编。
- 直接生成路径独立保存实际输入的 `source-baseline.docx`；模型提供的 baseline 副本不能充当核验原件。
- 独立核对拒绝本轮修订后等于原件有效正文、接受全部修订后等于清洁版、清洁版不残留修订、原媒体/嵌入件保留；逐 story 记录完整文字复用数量。
- 受控模式额外保留现有操作重放与格式诊断。已有历史结果缺少新引用时继续原交付路径，不回填虚假检查结果，不重新发起模型调用。
- 沿用原私有报告、并发锁、重试与删除生命周期。诊断失败不取消已有下载、不改任务终态或账本。未增加 API、数据库迁移或供应商调用。

## 验证记录

独立 Docker 内部网络与 PostgreSQL 16，无生产连接、无主机端口；测试容器、其匿名数据卷和内部网络已在完成后删除，对象存储使用内存实现。Linux 运行时镜像 `bondbuddy-customer-leizhai:worker-f2dcc921-node2233`，源代码及登记样本以只读方式挂载。模型阶段使用合成适配器，不能称作真实模型结果。

| 检查 | 结果 |
| --- | --- |
| Worker TypeScript 编译 | 通过 |
| `file-authoring-format.test.js`、`file-authoring-delivery.test.js`、`word-format-diagnostic.pg.test.js` | 30 项通过、0 跳过。含真实 Python 双 Word 诊断与真实 PostgreSQL 并发/重试/删除；不带修订的重写被报告失败，两个成果仍 available，任务与调用状态不变 |
| Windows `test_baseline_review` + `test_fixed_edit` | 27 项通过；初次子进程 Unicode 测试失败，显式 `PYTHONUTF8=1` 后通过 |
| Linux `test_baseline_review`、`test_fixed_edit`、`test_file_authoring`、`test_fixed_edit_authorized` | 35 项通过、0 跳过，364.9 秒；包含 4 份登记真实原稿的临时合成修改及新增原件/双 Word 核对 |
| 完整 CLI `codex-file-authoring.test.js` | 4 项失败于 `AUTHORING_FILE_SANDBOX_UNAVAILABLE` 预检，未进入合成编制；未绕过保护、未作供应商调用 |
| `git diff --check` | 通过 |

复现核心检查，在已构建且具备 Python 依赖的仓库中运行：

```sh
node node_modules/typescript/bin/tsc -p apps/worker/tsconfig.json
BONDBUDDY_TEST_PYTHON=/opt/venv/bin/python BB_TEST_DATABASE_URL=<isolated-test-db> \
  node --test apps/worker/dist/file-authoring-format.test.js \
  apps/worker/dist/file-authoring-delivery.test.js apps/worker/dist/word-format-diagnostic.pg.test.js
PYTHONPATH=python PYTHONUTF8=1 BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1 \
  /opt/venv/bin/python -B -m unittest python.tests.test_baseline_review \
  python.tests.test_fixed_edit python.tests.test_file_authoring python.tests.test_fixed_edit_authorized -v
```

授权原稿样本固定在 `tests/samples/2026-09-25/manifest.json`，检查 4 个历史 DOCX 的登记 hash、临时合成文字修改、双 Word 关系及原有非正文包部件。样本原件不修改；不以测试文字冒充实际财务更新。

## 集成依赖与实际内容验收

本次 [#861](https://github.com/ITSophiaXu/BondBuddy/pull/861) 只覆盖上述工作层与核验层。客户漏带原稿、PPN 专家模板覆盖原目录的入口/目录修复由 [#860](https://github.com/ITSophiaXu/BondBuddy/pull/860) 交付，需要在同一固定版本合并验证。另有 [#859](https://github.com/ITSophiaXu/BondBuddy/pull/859) 处理模型未保存 operations.json 却正常结束的问题，涉及相邻 `file-authoring-stage.ts` 改动；集成时同时保留必需交付文件反馈、失败日志和本 PR 的基线引用/新提示版本。

统一集成验收需在兼容的 CLI 沙箱环境重跑上述 4 项，然后使用已授权原稿及新材料完成真实模型试运行：

1. 确认采用的原稿精确进入本次锁定输入；漏稿时阻止开始，不生成“新编”替代稿。对于已经误生成新编稿的项目，复验要明确选回上传原稿，不能把错误新稿继续作为上一版基线。
2. 对照原稿逐章检查标题、顺序、原文和所有表格明细；对每处删除、概括和结构迁移核查具体业务依据，不能仅凭修订一致性通过就认可。
3. 验证新期间数字、主体、单位、合并/母公司口径和全文重复引用；没有新材料的内容保留真实历史时点，缺口按品种规则表示。
4. 在 Word/WPS 实际打开修订版、接受/拒绝修订、核对清洁版，并验收字体、分页、跨页表格和图片。
5. 覆盖 PPN 历史稿更新、已有成果续改、复核稿续改、PDF 原稿和确实无原稿的新编；PDF 重建及复杂增列等现有能力限制单独记录。

开发改动与定向验证完成，交付待统一集成。没有启动可供用户验收的本地网页；没有完整真实模型质量验收、用户验收或生产部署。临时测试资源已清理。本次未向其他 chat 发送消息，未合并生产发布。
