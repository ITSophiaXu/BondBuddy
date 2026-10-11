# 复核创建页：自动命名与可展开的检查范围

用户于 2026-10-11 根据复核创建页截图要求：必填提示移到“填写待复核募集书的基本信息，再上传募集书和核验材料”旁，项目名称自动生成；三个 pills 改为能展开说明检查内容、规范和公开核验对象的设计。用户同时要求核实是否真的连接工商网站查询。

## 本次实现

- 新建复核项目只需填写发行人全称，市场、品种、报告期可留空保存。引导文案旁明确“必填：发行人全称”。名称使用既有公共长度限制，按发行人、有效市场／品种和“募集书复核”后缀生成；创建后仍可自定义名称。编辑既有项目不会重新生成或覆盖原名称。
- 以三条标题、简短用途和原生 details/summary 展示财务数据核对、合规与披露、公开信息核验。默认收起，支持键盘，手机单列展开；详情不新增收费选项或确认步骤。
- 合规详情显示检查项和随市场／品种变化的规范范围，区分交易所私募／公募及银行间 PPN／DFI／其他工具。具体规则版本、条款与适用性由实际报告列明，知识研究草稿不等于生效性核验或合规结论。
- 公开信息标题旁始终显示“暂未自动联网核验”。详情列出工商及控制关系、债券与信用、诉讼处罚、重大事项，说明目前需要用户提供查询报告、公告或带来源日期的截图供交叉核对。网站名称仅为可补充的来源提示，不表示已经连接或查询。
- 创建页及完整复核提议使用同一范围说明。保留 #663 同期确认的简化材料页及右对齐操作区，材料页不重复显示范围说明。

## 公开核验能力核查

当前 `apps/api/src/review-workspace.ts` 为新的非修订复核锁定 `review-file-v1`；`apps/worker/src/model-generation-router.ts` 将其送入 `review-file-stage.ts`。该路径通过 file workspace 执行，`codex-adapter.ts` 的 `codexConfigOverrides` 对 files 强制 `web_search="disabled"`。因此当前默认文件复核没有自动在线核验。

仓库另有 `review-public-stage.ts` 的真实检索与来源证据流程，以及 `skills/m3-public-review/SKILL.md`，不代表当前默认路径已经使用。工商商业接口 #52 仍为后续可选接入。本次不启用网络、不新增供应商、不发送任何客户材料或真实工商查询，也不把原型或合成测试当作真实在线验收。

依据范围来自 `apps/api/src/review-file-knowledge.ts` / `unified-authoring.ts` 实际锁定的市场知识、`product-prototype/knowledge/*-review.md` 和 `python/bondbuddy_file_authoring/review.md` 的检查要求。本次仅修改前端及设计说明，无 API schema、数据库、定价、worker 或执行权限变化。

## 页面与验证

设计预览：`product-prototype/public/review-setup.html`（从本次实现生成的合成设计快照，支持折叠和自动命名，无业务提交）。实现：`apps/web/src/review-workspace.ts`、`review-scope.ts/css`、`form-model.ts`。用户本次设计请求为交互变更依据；未增加截图之外的新业务步骤。

验收记录与同尺寸截图：`apps/web/test-evidence/review-setup-20261011/README.md`。关联 #47、#55、#56、#361，较广父任务的未完成事项仍单独保留。
