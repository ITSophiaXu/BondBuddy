# 项目问答 E2E

本切片对应 Issue #722。入口先选项目或新建项目，沿用 `ProjectEntry`。按 [2026-10-27 用户决定](product-decisions/2026-10-27-project-qa-document-ux.md)，页面专注上传问题清单、生成和下载 Word、查看待补材料；讨论使用全站右侧 BondBuddy 面板，页面不再嵌入聊天。公开案例先建设管理与检索能力，用户后续提供真实案例。

## 工作流程与边界

1. 上传 DOCX / DOC / PDF 原件并保存私有对象与 SHA-256，免费 `prepare` 任务转换、定位原段落，识别候选问题。PDF 使用现有 `review_corrections.package` 的可检索文字转 Word 能力；输出及定位基于转换后的 Word，原 PDF 不变，转换版式和无法提取页面的警告随成果保存。扫描页不执行 OCR，不捏造问题；无候选问题时不能开始收费回答。
2. 用户核对范围、合并连续段落、移除非问题，选择本项目材料并保存回答要求。每轮 1–200 题、最多 50 份材料；单文件 100 MB。识别是编号/问句规则，不宣称自动识别全部语义小问。同段多个小问按确认的一个问题计数。
3. 确认数量和总价后创建不可变输入、run、报价和预留积分。每题 60 积分；待补材料建议也属于本轮处理结果。补料新一轮按所选题数收费。报价版本固定为 `project-qa-question-60-v1`。
4. worker 逐题从固定材料抽取文本并检索相关段落，经已有隔离 Codex 适配器作答。禁止实时搜索。每题沿用 durable model journal，再保存不可变回答检查点；暂停/恢复不会重跑已完成题。不确定调用沿用原有 reconciliation 流程。
5. 对引文的材料索引、段落 ID 和原文引用做确定性校验；无可定位引用或引用不符时降为待补材料，不沿用该肯定回答。精确引用仍不等于专业判断正确，成果标为待人工复核草稿。
6. 回答、依据、回答思路、公开案例来源及待补材料写入问题结束段落之后，保留原包中的表格、样式、页脚和图片关系，解除相关表格固定行高。原件不变，原稿既有修订以接受后的有效文本为基线，并记录说明。
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

PDF 仅提取可检索文本，扫描或提取失败明确待补；Excel 仅用保存的缓存值，不重算公式。材料按关键词筛选最多 100 段/120,000 字符，不宣称穷尽全文。脚注、图片及复杂嵌入对象不保证可检索，原 Word 版式需最终人工核对。

回滚前停止接收新问答任务并处理活动 run，保留新表与已完成 Word，不反向删除迁移或账务。开发 chat 不执行生产迁移或发布。自测与用户验收记录见 [开发验证](acceptance/issue-722/README.md)。
