# #35：移除全集阅读笔记前置，按需查阅材料并编制

用户于 2026-10-02 要求清空旧项目释放 worker，并修复下午提交至晚上仍未开始更新的执行流程。旧版 `cli_word.py` 将原文件交给可使用文件工具的 Codex；M1 v3 改成禁用工具的逐批阅读、详细笔记汇总、再逐段改写。在实际大 XLSX 上发生大量串行阅读；另一个旧任务聚合笔记超过 750,000 字节，被误归类为材料等待后反复入队。

新任务使用 v4：首个调用直接更新原稿当前区段；辅助材料通过本次任务内的 `bb_materials` 只读工具按需搜索、分页读取，保留原文定位、主体、期间与不确定性。不存在预先提取财务数据、全部阅读笔记或人工批准步骤。所有原稿记录仍逐批覆盖，不截断材料或取消全文覆盖、来源及 Word 质量校验。无原稿仍从目标类型知识、用户材料编制。

工具只接受固定材料 ID、字符串关键词及有上限的记录范围，不接受文件路径、代码、网络或数据库指令。数据来自原有输入版本/归属/hash 校验；临时工具目录随进程回收。模型目录对该路径启用 direct tool mode，旧纯文本目录继续用于其他调用。已有 v3 检查点继续使用原逻辑调用 ID，防止发布后重放原调用。所有已完成结果继续走持久结果重用、真实用量和取消/租约终止语义。

材料就绪自动恢复仅对应 `material_parse_pending`；上下文、OCR 或输出错误不会因文件已解析而无限重新入队。原有错误与实际用量记录不清零。清理旧项目采用现有取消及软删除语义，不删除他人项目或伪造供应商退款。

验证区分：大材料和安全边界回归使用合成数据；真实 Codex 工具验证也使用合成材料；带真实解析/数据库/Blob/Word/授权下载的集成测试另外记录是否调用了真实供应商。通过合成任务不等于原客户全文或行业验收。具体命令、计数、发布和原项目后续证据回填 #35/#448；本切片不自动关闭父 Issue。

页面结构与按钮不改变；沿用同项目编制及双 Word 下载交互，不新增阅读问卷、财务服务或常驻右侧补充框。

## 验证证据

- API、worker、公共包 TypeScript 及 Web Vite build 通过；contracts 的 156 个示例、12 个内部库示例及不变量检查通过。
- Azure Linux 隔离环境执行 `node --test --test-concurrency=1 apps/worker/dist/codex-adapter.test.js apps/worker/dist/authoring-material-tools.test.js apps/worker/dist/unified-model-stage.test.js apps/worker/dist/run-runtime.test.js`：35/35 通过，0 skipped。覆盖 22,014 条辅助材料记录下首个调用即进入正文更新、无原稿编制、固定工具与隔离、持久结果重用、取消、解析等待恢复及上下文失败不循环。
- 2026-10-02 11:29:18 UTC，当前真实 `gpt-6-sol / copilot_enterprise` 模型在合成材料上成功执行 `search_material` 和 `read_records`，返回正确原文证据 ID 和数值；completed/measured，6,129ms、10,750 tokens。测试数据不是客户原项目，不能据此认定全文 Word 或业务验收通过。
- `BB_TEST_LIVE_AUTHORING=1 node --test apps/worker/dist/unified-authoring.pg.test.js` 在 Azure Linux 隔离数据库和 Blob 中 1/1 通过，0 skipped，330,089ms。合成材料实际经过 API 上传、解析、真实 `unified-v4-update_0`（completed/measured，153,447 tokens）、Word 修订/清洁版交付检查、两份授权下载及 hash 核对、跨账号 404；保存后的要求变更不影响已锁定本轮输入。
- 获授权大文件样本及最终部署镜像结果另在 #35/#448 回填。旧项目已按用户要求清理，不把独立测试任务当作已取消原项目的恢复；原客户全文、Word/WPS 排版与业务验收仍须分别核验。
