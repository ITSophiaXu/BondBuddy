# #643 募集说明书摘要名称

代码及原型基准：`90b55025702657fbd6cdd0400eeb537d99383541`，Windows / Node 22 / Edge，synthetic 输入和模型响应。

- 完整 build、contracts 通过；技能固定哈希调整后 worker 重新构建通过。
- Playwright `m4-workspace.spec.ts` 的执行、重复提交、输入变化、成果、续改、保存重试及原型对照：9 pass，0 fail；名称截图定向复验通过。
- `node --test apps/worker/dist/m4-runtime-skills.test.js apps/worker/dist/m4-stages.test.js`：指定已安装 Python 后 21 pass、0 fail、1 skip（Windows 软链接隔离用例）。初跑因默认 python3 不存在失败，未作为成功证据。

同尺寸视口：1440×960 / 390×844。`implementation-summary-label-*` 和 `prototype-summary-label-*` 对照生成按钮；`saved-file-*` 展示摘要选中状态；其他截图为同一轮执行与原型回归。原型材料入口原先即使用“募集说明书摘要”，现实现统一到此名称；成果标题、知识选择项和生成技能同步修改。保留既有布局与支持范围，没有新增流程。

内部 private_summary、价格映射和支持范围不变；已交付历史文档不改写。最终统一验收待办：用户页面试用及真实生成正文标题确认。
