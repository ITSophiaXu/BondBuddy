# 项目问答 E2E

本切片对应 Issue #722。入口先选项目或新建项目，沿用 `ProjectEntry`。按 [2026-10-27 用户决定](product-decisions/2026-10-27-project-qa-document-ux.md)，页面专注上传问题清单、生成和下载 Word、查看待补材料；讨论使用全站右侧 BondBuddy 面板，页面不再嵌入聊天。公开案例先建设管理与检索能力，用户后续提供真实案例。

## 工作流程与边界

2026-11-09 按[问答流程精简决定](product-decisions/2026-11-09-project-qa-simple-workflow.md)，上传清单后自动采用问题；移除手工段落范围编辑与移除问题入口。问题预览和单份参考材料列表默认收起，补充材料按钮直接可用。移除材料搜索、重复已选列表和普通材料行的技术引用详情；精确材料记录仍用于固定输入与异常恢复。下文历史流程中的手工范围核对不再是当前交互。

2026-11-07 按[直接回应所问事项](product-decisions/2026-11-07-project-qa-direct-answer.md)调整逐题提示：以项目组立场按“相关事实、原因解释、对应结论”如实作答，逐段约束到具体小问，不反驳提问或增加无关事项。新的 prompt 版本为 `project-qa-direct-answer-v6`；Word 标签为“回复：”，与下一段同行分页；生成表格按列内容分配宽度、重复表头并保持单行不跨页。回答状态和原文引证校验保持，已存逐题回答不重跑。

2026-10-29 按[合并准备与开始决定](product-decisions/2026-10-29-project-qa-single-start.md)，免费识别成功直接显示问题、材料、回答要求及费用。一次「开始回答」连续保存准备和提交任务，不再跳转确认页或重复弹窗；前端移除知识库入口与参考方式选择。新一轮使用现有默认 `use_knowledge:false`，已有保存值及待恢复原请求保留。

1. 上传 DOCX / DOC / PDF 原件并保存私有对象与 SHA-256，免费 `prepare` 任务转换、定位原段落，识别候选问题。PDF 使用现有 `review_corrections.package` 的可检索文字转 Word 能力；输出及定位基于转换后的 Word，原 PDF 不变，转换版式和无法提取页面的警告随成果保存。扫描页不执行 OCR，不捏造问题；无候选问题时不能开始收费回答。
2. 用户核对范围、合并连续段落、移除非问题，选择本项目材料并保存回答要求。每轮 1–200 题、最多 50 份材料；单文件 100 MB。识别是编号/问句规则，不宣称自动识别全部语义小问。同段多个小问按确认的一个问题计数。
3. 确认数量和总价后创建不可变输入、run、报价和预留积分。每题 60 积分；待补材料建议也属于本轮处理结果。补料新一轮按所选题数收费。报价版本固定为 `project-qa-question-60-v1`。
4. worker 逐题从固定材料抽取文本并检索相关段落，经已有隔离 Codex 适配器作答。禁止实时搜索。每题沿用 durable model journal，再保存不可变回答检查点；暂停/恢复不会重跑已完成题。不确定调用沿用原有 reconciliation 流程。
5. 新提示使用内部 `evidence_refs` 协议，模型选择已选入材料的证据编号，host 从固定原文生成公共 `citations`。每题最多 200 条；长段落按不超过 4000 字符分片，保留完整文本及定位。未知、空白、未选入或跨材料编号拒绝并按具体错误重试，不删引文或改写回答。已存旧提示仍用原有逐字 quote 协议，已完成公共回答直接恢复；引用错误是生成错误，不当成发行人缺材料。精确引用仍不等于专业判断正确，成果标为待人工复核草稿。
6. 答复正文及必要的局部待确认事项写入问题结束段落之后；引用与定位独立存储，不追加到答复正文，保留原包中的表格、样式、页脚和图片关系，解除相关表格固定行高。原件不变，原稿既有修订以接受后的有效文本为基线，并记录说明。
7. Word 私有存储读回校验后交付，完整本轮才结算。失败/取消释放整轮冻结积分。历次回答均保留，同一原问题清单形成文件版本组，出现在项目文件 **4.2 核查记录**；免费解析稿不列作最终成果。

## 契约与存储

公共 schema / OpenAPI：`packages/contracts/src/project-qa.ts`。

- `GET /api/v1/projects/:project_id/qa`：草稿、材料及最近 100 个任务，额外包含指定任务及其解析父任务和当前草稿父任务。
- `POST .../qa/prepare`：幂等免费解析任务。
- `POST .../qa/draft`：以 expected_revision 做并发校验；问题文本必须精确匹配原段落范围。
- `POST .../qa/runs`：锁定材料、问题、已审核案例与积分；expected_points 不一致返回 QUOTE_CHANGED。
- `GET /api/v1/qa/cases`、`POST /api/v1/qa/cases`、`POST /api/v1/qa/cases/:case_id/review`：检索、录入、审核或撤回。

迁移 `0115_project_qa.sql` 增加 drafts、runs、answers、quotes、cases、reviewers、reviews 七张表，扩展既有固定积分 reservation guard 与 finalizer。输入、逐题回答、报价和审核记录不可变。业务变更和 outbox 同事务。项目锁、账号归属、材料 pin/hash、幂等请求和任务互斥沿用既有服务。

## 公开案例与权限

普通用户可提交明确的公开来源 URL、公开问答、分类、回答思路和证据要求；新条目为 pending。用户只能看到自己的待审核记录与全库 approved 记录，审核员可见全部。仅 `bb_qa_case_reviewers` 登记的运营审核员可批准或撤回；不存在网页自助提权入口。

审核员由受信运营在正确目标环境中授权，必须记录操作人和理由。示例事务（替换三个参数，勿用于自动部署）：

```sql
BEGIN;
INSERT INTO bb_qa_case_reviewers(user_id, actor, reason)
VALUES(:user_id, :operator, :reason);
INSERT INTO bb_outbox(id, owner_user_id, aggregate_type, aggregate_id, event_type, payload)
VALUES(gen_random_uuid()::text, :user_id, 'qa_reviewer', :user_id, 'qa_reviewer.granted',
       jsonb_build_object('actor', :operator, 'reason', :reason));
COMMIT;
```

撤权同样在事务中删除该授权行并写 `qa_reviewer.revoked` outbox，历史审核记录保留。本轮未在共享环境授予任何审核权限。

案例内容不可直接改写，纠错需提交新案例并撤回旧条目。中文双字词/英文词索引检索；每题最多三个相关已审核案例，单轮最多 40 个不可变案例快照。撤回影响后续任务，不改写已执行任务的来源。没有自动抓取、私有项目资料入库或模型训练；来源是否公开及是否可用由审核员核实。

## 运行依赖与交付

API、worker、web、contracts 和迁移必须同批集成。依赖本会话前置 PR #713、#715、#717、#719、#721 及迁移至 0114。worker 镜像新增 `libreoffice-writer` 和 `fonts-noto-cjk`，现有 Python 依赖提供 lxml、python-docx、pdfplumber 和 openpyxl。DOC 转换独立 LibreOffice profile，最高宏安全级别，禁止更新外链，超时 90 秒；生产仍应沿用既有受限 worker 容器。

PDF 仅提取可检索文本，扫描或提取失败明确待补；Excel 仅用保存的缓存值，不重算公式。材料按关键词和完整相关表格筛选最多 120,000 正文字符，不宣称穷尽全文。脚注、图片及复杂嵌入对象不保证可检索，原 Word 版式需最终人工核对。

回滚前停止接收新问答任务并处理活动 run，保留新表与已完成 Word，不反向删除迁移或账务。开发 chat 不执行生产迁移或发布。自测与用户验收记录见 [开发验证](acceptance/issue-722/README.md)。

## 证据引用协议兼容

`codexModelStage.outputForPrompt` 在读取和验证保存的 prompt 后选择模型输出协议。新 prompt 的受信首行版本标识决定使用 `QaModelAnswerSchema`；模型只输出 `evidence_refs`，不重抄 quote。host 重新核对 prompt 中每个引用编号、正文和位置与本轮固定 evidence 一致，只允许引用实际选入的非空原文。未知编号及无效内部结构整体拒绝，不从其他项目或未选入材料补引文。normalization 不改 answer，仅物化 citations；持久化及 replay 继续使用 `QaAnswerSchema`。

旧 prompt 没有首行标识，保留 `QaAnswerSchema` 及逐字引用验证，不强制使用它没有提供的编号。来源正文中的版本字符串不能切换协议。公共 citation 形状不变，仅 maxItems 从 30 扩至 200；历史结果仍有效，API/worker/contracts 同批更新，无数据库迁移。

适配器重试区分 JSON 解析和业务校验失败。可选反馈由 host 提供，问答仅反馈字段位置及固定错误说明，不把材料、模型原文或异常消息拼入受信指令；反馈限 2000 字符，异常回落通用提示。重试上限、真实用量、取消、工具隔离、durable intent 和失败处理保持。
