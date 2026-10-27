# 最终桌面 UX 覆盖只读审计（2026-10-27）

审计工作区：C:/Users/lezhai/Downloads/Bondbuddy/ux-coverage-20261026。只读产品源码和历史证据；本文件为审计增量。结论受下述最后补证与冻结归档完成条件约束。

## 建议完成口径

若最终真实三类桌面链通过，并补齐下述五点钱包和新材料到 Word 的断言，且源码冻结、截图核验、归档及定向回归均通过，可将本轮“桌面 UX 工程优化与已登记场景验收”标为 complete。原十五条业务旅程仍按历史采用规则为 15/15（主要11/11、辅助4/4），G01/G02 保留通过，G03 新增独立通过；不重算16/16或18/18，不把 API/worker/browser 测试数量当场景分母，不与旧662合计。应写为已登记业务范围达到所要求的至少90%、主要场景和功能全部覆盖，不推导全产品未知场景或真实用户指标均达到100%。

当前文件顶部的未完成状态是0138时点历史结论，需在最终补证通过后更新当前状态；下方各切片历史未完成描述保留为历史，并链接最终权威结论。

## 精确范围依据

- docs/ux/desktop-scenario-coverage-20261026.md:27–31：十五类目录、23任务卡映射、桌面工程验收及真实用户/供应商/客户端独立边界。
- 同文35–47：15/15不是完整目标比例；必须通过G03且有完整链、相关回归/构建、修复复测、截图证据，不能靠别的pass抵消必过门。
- 同文55–79及126–145：十五旅程和三必过门的采用关系；同文94–112固定历史662而未声称全部重跑。
- docs/testing/bondbuddy-test-plan-v6/user-scenarios.md:237–260：G03原始卡。245–248是一次缺料、暂停、补齐、继续；252–254要求同run、新输入、旧工作/调用保留和可理解的正确账务。没有要求V3或任意次数补料。
- 因此当前V1→V2一次补料可完成此卡；V3/再次补料未实现应明确披露，不能声称无限多轮续做。
- AGENTS.md:85允许主链自动化/合成证据作为工程Issue关闭口径，但要求合成标注及“最终统一验收待办”；这不把真实供应商、专业签认或真实用户效果变成已通过。

## 历史十五旅程源码关系

审计命令：git diff --name-only 4cd1c39 -- apps/web/src；git diff --stat 4cd1c39 -- apps/web/src；对共享模块逐项查看diff；另查看db7ffc95到当前的三workspace diff。

- 核心文件/一致性/项目浏览、QA、诚信、助手等模块未出现在自4cd1c39的web产品差异中：project-files、file-consistency、consistency-confirmation/history、project-browser、project-task-refresh、project-qa-workspace、qa-continuation、integrity-workspace/continuation/recovery、project-assistant、assistant-view-cache、assistant-upload-recovery、upload-recovery、文件往返实现保持。D04/D05/D10/D11/D12/D13/D14/D15的历史证据可按其原范围采用，不能写为本轮重新执行。
- D01/D02/D03/D06/D07/D08/D09共享的project-execution/review-workspace/material-workspace自历史基线确有变化，主要是人工暂停/充值反馈和补料面板挂载、普通resume前读取补料状态；不能称这些整个文件未变。后继证据分别为manual-pause（7单元/11桌面）、supplement-preparation-real（6真实主页面/44后端）、supplement-input（7真实主页面/17组件/相关实际loader），以及本次37组件/3真实采用续做链与88相关回归。各自按切片采用，不相加成用户场景数。
- 这三workspace从db7ffc95到当前的产品差异只有采用后的resume文案分支；普通准备、执行、下载动作没有重新实现。新run-supplement-adoption与现run-supplement-draft承担新增协议和恢复边界，由本次专项直接验证。
- source-prospectus自历史基线增加准确pin和scope隔离，保持既有调用默认scope；应沿用来源专项的源信息/隔离单元及桌面证据，不能泛称原稿输入控件未变。
- review-editor/cache自历史基线固定执行身份及准确恢复pin，历史V1兼容和导出已由execution-editors独立封存（19桌面、20缓存及真实PG/Word集合）；不把该证据误写为本次V2完整卡。
- api.ts自基线增加补料请求方法；本次production采用端点/费用消费者/worker变化需要本次API/worker回归证据，旧mock浏览器证据不能单独证明后端账务仍正确。主执行者已报告最终API15/15、相关回归88/88、worker5/5和mock37/37，最终真实链尚待补证。本审计未将这些重复计数合并。

## 完整G03最后证据条件

1. 五点钱包：原任务运行/暂停前、安全暂停后、补料保存后、明确采用前、成功后，分别保存available、reserved/frozen、consumed和ledger。原卡254明确要求。当前real-main:46–47仅保存安全暂停后before，150/155保存成功后after；harness:59–66含reservation/events/progress但未含bb_credit_lots或creditBalance，不能把它们称为五点钱包直接采样。API adoption test:86–90确实读取creditBalance；100–101证明确认前后账户不变、124–126证明replay不重复收费、137/148验证audit一致，但仍应补本次同run五点证据。主执行者已安排round4测试补证。
2. 新材料进入成果：原卡252要求最终成果反映新材料。现synthetic provider fixture的codex-file-input-v1分支刻意V1/V2输出同OOXML，其他分支仅加入input_hash；real-main:135–136只检查Word非空。当前证据能证明材料字节到实际worker/provider workspace和准确V2成果下载，不单独证明新材料内容传播到Word。建议round4专用、可选synthetic seam从新增材料读出独特标记写入新Word，再解析下载Word断言标记，旧Word hash保持不变；保留原worker相同字节identity案例的默认行为。
3. 新旧工作/调用：本次真实链已具备同run/head2、两个完成call、旧artifact行和字节不变、无localStorage时current权威读取后普通resume不新增quote/consent/fee、准确私有授权下载等断言。API拒绝竞争/不足/过期、worker持久重放无第三次call共同补足可靠性，不能仅凭页面显示已采用认定。

## 当前建议状态

在上述最后两项补证完成前，产品能力已实现，G03工程验收仍partial，完整目标保持active；无需新增产品改动，也无需重问B/B1。补证通过且源/构建未变、截图和归档可审阅后，可关闭FG002/G03并标记本轮已登记桌面工程目标complete。

无论是否complete，都不声称学习成本、实际完成率、attrition/留存或转移成本已测得改善；真实供应商/支付/Azure、Word/WPS真实客户端和专业正确性仍属最终统一验收。未推送/PR/发布。
