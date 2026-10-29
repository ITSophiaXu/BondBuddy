# 项目问答表格与局部缺项

全部数据均为 synthetic HTTP 夹具，未执行真实模型或计费。原型 `product-prototype/public/qa-materials.html` 与实现 `apps/web/src/project-qa-workspace.ts` 同次提交；依据用户 2026-10-29 对事实答复、表格引用及局部缺项的明确要求。基线 develop `c4e98f51`。

- `answer-table-1440/390.png` 与 `prototype-table-1440/390.png`：同视口、同回答组件宽度。均保留事实段落、表头、数据、单位、附注与一条局部待确认事项。实现保留原有“原文段落”定位、引用依据及全局助手；原型以“问题 2”展示，未改变页面结构。
- 其余截图来自已有 `project-qa-materials.spec.ts` 回归：材料页、问题确认页和回答页，1440/390/320 下页面无横向溢出。
- 表格正文复用现有转义渲染；脚本/图片标签作为文字展示，未执行。手机表格保留列结构，宽表可在组件内滚动。

测试：`project-qa-answer-tables.spec.ts` 3/3、`project-qa-materials.spec.ts` 9/9；最新组件对照再次 3/3 通过。用户尚未验收，尚未部署。
