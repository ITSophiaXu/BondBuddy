# 材料生成固定价与提交反馈（2026-10-08）

四类完整材料采用用户确定的固定价，按 Spec 的 PROJECT_DOCUMENT 档 4,500 积分／份执行。生成前报价并明确确认、冻结；正文 Word 和编制说明均交付后扣款。失败或取消全额释放，内部重试及重复下载不另收费。材料生成不依赖模型成本率配置，QA 和已运行历史任务按原规则结算。见[产品决定](../../product-decisions/2026-10-08-m4-fixed-document-price.md)。

报价或执行失败会在生成按钮旁显示 role=alert，单独记录保存失败，仅实际保存失败才提供“重试保存草稿”。保存内容和任务幂等不变。

## 原型与实现

- 关联 #57、#66、#361；表单基线 a47e0dc，product-prototype/public/material-studio.js。
- 本 PR 同步原型页尾固定价文案，实现增加现有报价区的固定价确认。用户确认来源：2026-10-08 当前会话“材料生成用固定价就可以”。
- 原型已有提交区内错误提示，实现补齐同处反馈。
- 同尺寸原型／实现 1440×960、390×844 截图：apps/web/test-evidence/m4-form-20261008/，文件来自本 PR 当前源代码。表单结构与基线一致；价格在报价后显示于确认按钮上方。
- 价格截图：[桌面](implementation-fixed-1440.png)、[手机](implementation-fixed-430.png)。错误截图：[桌面](implementation-error-desktop.png)、[手机](implementation-error-mobile.png)。全部是 synthetic HTTP fixture，不含真实客户数据。

## 本地验证

- Windows / Node 22.14.0 / PostgreSQL 16.14 隔离克隆 / 独立 Azurite / Edge。
- npm run build、npm run check:contracts 通过：167 公共示例、12 内部示例、4 生命周期示例及 40 契约测试。
- 浏览器 m4-workspace.spec.ts：20 passed，0 skipped，含桌面／手机固定价、报价错误、保存重试、输入保留、同尺寸截图。
- API m4-workspace.pg.test.ts、billing.pg.test.ts、review-billing.pg.test.ts：6 passed，0 skipped。真实钱包、双 Word 交付门、固定成功扣 4,500、失败／取消释放、重复终态只结算一次，M1/M2 回归。
- API m4-fixed-billing.pg.test.ts：1 passed，0 skipped。四文种无成本配置报价、余额竞争仅一方冻结、不可变报价、旧未执行报价重新确认、已运行旧按量任务保留原金额。
- Worker m4-pipeline.pg.test.ts：1 passed，0 skipped。无成本配置下实际生成 synthetic Word 双文件、私有 Blob 回读和授权下载、崩溃后复用结果、固定价不因未知 usage 暂停、QA 未知 usage 待核恢复、自然语言明确执行只产生一次冻结。

## 发布边界

迁移 0099 仅新增报价字段、分流现有账务终态触发器；不改写旧报价和任务。需要 API、worker、web 同版本发布。合成模型注入测试不冒充真实供应商或专业内容验收。具体 master SHA、线上迁移和回滚状态另记发布记录。
