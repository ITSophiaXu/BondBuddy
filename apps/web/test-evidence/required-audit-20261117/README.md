# 募集书更新：审计报告必填

2026-11-17，开发和自测完成；代码尚未部署，待统一发布。用户尚未验收。

本次用户要求为变更依据。基于 develop c1505ca6；分支 fix/update-audit-required-20261117。

## 行为

- “审计报告（可含报表及附注）”明确标注必填。单独的报表、附注、募集书或上一轮成果均不能替代。
- 只有已保存并选入本轮的 audit 类材料满足条件；上传未完成仍由既有上传门禁阻止。
- 页面、输入锁定、报价及新任务提交共同校验，返回 INPUT_REQUIRED / materials.audit / AUDIT_REPORT_REQUIRED。
- 审计报告已有报表及附注时无需重复上传。已有任务继续按原输入执行，准确重放返回原任务。
- 仅改变募集书编制入口，未修改复核、项目问答及 M4 其他材料生成逻辑。

## 验证

- contracts、domain、rule-pack-registry、rule-applicability-context、API、worker、web 构建及 web 生产打包通过。
- npm run check:contracts 通过（接口样例、生命周期、OCR 与发行人绑定检查）。
- API: required-audit.pg.test + required-source.pg.test + unified-authoring.test，最终相关 10 项通过、0 跳过。新增 PG 用例验证实际上传/确认、输入锁定、补齐后的报价/提交、旧快照拒绝与执行重放，并查询数据库确认无新增任务、报价、冻结。
- 追加兼容回归：billing.pg.test、source-format.pg.test、prospectus-source-lock.pg.test 最终 10 项通过、0 跳过；覆盖并发执行、余额不足、结算/退回、价格变化及原稿/格式/续改版本锁定。旧夹具已补齐审计报告，材料数量同步更新，短期积分过期计时改为上传准备后开始。
- Web: api.test + project-execution-upload.test，38 项通过、0 跳过。
- Edge: required-audit.spec + required-reference.spec，6 项通过，覆盖缺失、仅报表/附注、补齐、移除后重新阻止、续改、既有原稿校验及 1440/390 像素无横向溢出。
- 桌面及手机全页截图已检查，新增必填提示和上传区域无裁切或重叠。沿用当前页面结构与样式；原型 project-workspace.js 同步相同上传规则。

首次测试的定位器匹配到“选择文件”按钮内 strong，已缩小到材料标题；旧快照夹具材料顺序不符完整性校验，已按已锁定清单顺序构造并重跑通过。未通过记录不作为产品失败或最终通过证据。

## 边界与接续

API 测试使用真实 Fastify 和本任务独立 PostgreSQL 16（193 条迁移），合成用户及材料，Blob 为内存适配器；浏览器使用合成 HTTP 夹具。未运行模型、OCR、Word 生成、真实计费或生产环境测试，未声称内容质量/用户验收通过。

Windows CRLF 使既有 0180 迁移中的函数文本匹配失败；另建 bb_audit_lf 测试库，读取相同 SQL 时转为 LF 后完整迁移成功。未修改历史迁移文件。

无新数据库迁移、无新依赖。统一集成时使用本 PR 的 web/API/contracts，复验实际上传缺失提示及补齐后开始；无需为本次上传规则更改 worker 或重新调用模型。本次未更新共享集成验收状态。
