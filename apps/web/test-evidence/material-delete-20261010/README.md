# #641 已上传材料删除

代码及原型基准：`8c7310ab8485ac7e945daaa0365140a961b9dcee`。后续证据提交仅补充截图/测试记录。所有项目和材料均为 synthetic。

修复：更新页显示统一删除操作；复核页及材料生成页增加可见的删除入口。删除成功清理当前草稿引用并允许重传；失败保留条目可重试；响应丢失后读取服务器状态确认。活动任务期间说明需先停止。跨项目关联文件不能从当前材料工作区被直接删除。API 不再让已删除的共享材料或模板阻断材料工作区读取；历史不可变输入、任务和成果保持原样。

Windows / Node 22 / Edge：

- `npm run build`、`npm run check:contracts` 通过。
- Playwright `data-policy.spec.ts m4-workspace.spec.ts review-workspace.spec.ts --grep 'delete|deletion|replacing the source|first form save|polling keeps|direct upload retries|upload queue keeps|draft-save retry|one failed upload|input conflicts'`：17 pass、0 fail、0 skip。
- `material-delete-prototype.spec.ts`：2 pass，直接加载原型；源材料行截图定向用例2 pass。
- 先前合成路由遗漏 GET 及截图时机失败已修正；以上为最终复验结果。

同尺寸视口 1440×960 / 390×844；`prototype-review-*` / `review-*` 展示复核材料，`prototype-material-source-*` / `material-source-*` 展示材料生成删除入口。人工核对文件名、可见“删除”文字、手机换行及重传入口。裁剪材料行以排除分区外固定页头；现有下载/替换布局沿用已迁移页面，未新增流程。

真实 PostgreSQL 16 + Azurite 隔离集成结果在同目录 Linux 记录中补充；不将缺依赖而跳过的测试计作通过。

最终统一验收待办：用户原账号误传纠正、真实 Word/WPS 文件与历史成果确认。自动化使用合成数据，无客户数据变更或真实费用。
