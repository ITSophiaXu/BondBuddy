# #631 更新开始与扣费时机

原型 `credit-visibility.html`（ready/shortage/running）及 `global-project-assistant.html` 与实现同在本 PR source commit。用户 2026-10-09 要求覆盖旧的费用二次确认；按用户指定积分 Spec 保留服务端原子预留、成功交付结算、失败或取消释放。

同尺寸对照：implementation/prototype-ready/shortage ×1440×960、390×844。已逐图核对：开始前没有任务金额/差额或费用确认；不足提示、充值入口和显式继续可见。实现保留已有完整上传区、固定操作栏、手机导航、可隐藏助手，原型为积分片段，材料与侧栏为演示摘要，因此两侧纵向位置及页面壳不同；本次不改既有整体布局。移动端助手可能覆盖刷新按钮，可按 #623 已增加的隐藏按钮收起，刷新可恢复使用。积分条显示账号余额属于原功能，不是本次任务报价。

Windows Node22.14/Edge synthetic API 边界测试：project-execution 的 M2/credit visibility 与 project-assistant update card 共11/11功能通过，覆盖单次开始、余额恰好够、少1分、变化后重试、丢响应/刷新保留执行ID、充值返回/刷新不执行、运行预留/成功结算回执刷新。可选原型截图用例首次因缺失readFile导入失败，补齐导入后1/1通过。原型助手脚本语法检查通过。最终build/contracts及账户/助手回归结果见PR。

无数据库迁移、公共契约、固定价格变更。后端沿用已验证的原子冻结/交付结算，相关真实PostgreSQL断言由Linux CI执行；本地Docker未运行不把跳过算通过。

最终统一验收待办：部署后真实充值返回与用户长任务验证；当前证据不冒充真实支付/模型调用。生产尚未部署。
最终本地验证：npm run build、npm run check:contracts（171样例）通过；account.spec.ts / project-assistant.spec.ts 22通过、2可选旧原型截图跳过。
