# 项目问答直接回应验证记录

状态：开发和自测完成，代码完成，尚未部署，待统一发布。真实模型生成效果与用户验收尚未完成。

基线：`develop` 的 `757a9871`；分支：`codex/qa-direct-replies-20261107`。

## 方法及改动

按用户提供的 Word 修订稿逐条比对增删内容，并目视核对修订所在页面。明确区分用户保留的相关事实、删去的辩解和无关分析、补充的直接结论；未修改的其他段落不作为用户已经认可的证据。客户原件、修订提取和具体财务数据仅留本地，不提交仓库。

[回复方法决定](../product-decisions/2026-11-07-project-qa-direct-answer.md)落实到 `qaAnswerInstructions`，版本为 `project-qa-direct-answer-v5`：先拆小问，使用相关事实、原因解释和对应结论，每段都服务本题。充分回答必要的风险或合规问题，保留相关不利事实和证据限定，局部材料缺口继续显式标记。

Word 每题标签改为“回复：”。原问题和锚点、`draft` / `missing` 状态、引用原文验证及独立引用字段保持；没有关键词删句或替换事实的后处理。未修改网页流程、公共契约、计费、依赖或数据库，不涉及迁移。

## 已执行验证

环境：Windows，使用本机 Codex bundled Node/Python。外部 Node 依赖复用相同 lockfile 的现有安装，各 workspace 包指向本次独立工作区并重新编译。

- 依次执行 `node node_modules/typescript/bin/tsc -p <目录>/tsconfig.json`：`packages/contracts`、`packages/domain`、`packages/rule-pack-registry`、`packages/rule-applicability-context`、`apps/api`、`apps/worker`，全部通过。
- `node --test apps/worker/dist/project-qa-materials.test.js`：13 项通过，0 失败。覆盖本问缺口、完整相关表格、单位与附注、选文范围、空白/横线/零、唯一引文修复、重复引文定位及虚构引文拒绝。
- 设置 `PYTHONPATH=python` 后，执行 `python -X utf8 -m unittest discover -s python/tests -p test_project_qa.py -v`：共 9 项，8 通过，1 跳过。旧版 DOC 转换依赖 LibreOffice，本机未安装该依赖；DOCX/PDF/XLSX、完整抽取、问题锚点、回答表格及引用安全等既有回归通过。
- `git diff --check` 通过。检查生成入口已采用新版本及提示词，文档标签变更不影响原问题锚点或引用验证。

## 待集成验收

本次未调用真实模型重跑项目问答，未创建生产任务或覆盖既有成果。构建和工程回归证明接线与已有处理逻辑可用，不能作为新提示词生成效果的验收证明。

集成 worker 与 Python 后，使用方法决定中的六类场景复验实际生成结果：直接结论、范围控制、相关不利事实、局部缺口、错误问题口径及无关数据差异。由用户实际验收生成稿后，按项目统一发布流程上线。已有固定输入与已保存逐题回答保持，不自动重跑或计费。
