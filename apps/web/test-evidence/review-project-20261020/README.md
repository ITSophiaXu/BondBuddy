# 项目内复核设计对照与 E2E 证据

设计：`BondBuddy-project-materials-design-20261019` 的 `eed245e1`，源码 `apps/web/src/project-design/{app,workflows,review-view,review-model}.ts`。

实现：`c74b37ed`，后续提示修正 `9859f714`、浏览器收尾修复 `279e08eb` / `f18997eb`。截图为同一 1265 × 712 浏览器视口。设计页使用内置演示数据；实现页使用独立本地 API、PostgreSQL、私有 Blob 和 Linux worker，仅上传专门构造的合成材料。结果/编辑截图分别展示 V4、V3，两者都是已保存的真实本地成果。

| 步骤 | 设计 | 实现 |
| --- | --- | --- |
| 先选项目，新建为次要入口 | `design-entry.jpg` | `implementation-entry.jpg` |
| 材料分组、项目募集书版本和四项范围 | `design-materials.jpg` | `implementation-materials.jpg` |
| 真实任务状态 | 设计为演示进度 | `implementation-running.jpg` |
| 项目内成果、下载与历史 | `design-result.jpg` | `implementation-result.jpg` |
| 问题处理与原文修订预览 | 设计结果页内 | `implementation-editor.jpg` |
| 人工处理后免费导出 | 设计内保存新版 | `implementation-export.jpg` |

本次切片保留原线上全站导航，因此“材料生成”、未迁移的诚信核查/项目问答及完整项目文件分类尚未替换。跨文件一致性检查按用户确认另批实现。本批专注复核三步与真实结果编辑，补充实际计费、恢复、错误及版本状态。设计演示提示替换为真实任务信息，文字预览不承诺完整 Word 版式。上述切片边界源于用户确认；页面细节仍待用户验收，未据此自行合并或发布。

自动化验证、迁移、环境访问和实际模型验证记录见 `docs/plans/2026-10-20-review-project-e2e.md`。工程测试通过、真实模型样本通过、专业准确性验收和用户验收是不同状态。

`real-e2e.json` 包含真实调用成功、两次无模型导出、显式当前版本选择和 6 份浏览器下载文件的 hash/修订节点证据。早期结算失败的 V1 历史如实保留，最终 V2/V3/V4 成功；不将失败历史或仅有生成文件标为复核成功。
