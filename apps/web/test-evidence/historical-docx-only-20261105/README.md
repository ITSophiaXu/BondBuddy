# 历史／参考募集书仅支持 DOCX：验证记录

实现与原型源码均为 `8a72e175`，基线 `a8936895`。范围由用户 2026-11-05「把 PDF 去掉，上传的时候只支持上传 word 格式」确认；本次格式变更没有额外设计偏离。

对应页面：`product-prototype/public/prospectus-reference.html`、`project-workspace.js`；实际组件：`apps/web/src/prospectus-panel.ts` 和更新材料入口 `main.ts`。

## 同尺寸截图

| 视口宽度 | 实现 | 原型 |
| --- | --- | --- |
| 1440 | [实现](implementation-empty-1440.png) | [原型](prototype-empty-1440.png) |
| 390 | [实现](implementation-empty-390.png) | [原型](prototype-empty-390.png) |

两组空状态截图分别具有相同 SHA-256，提示、字号、按钮位置、换行与间距一致；另检查 320 宽度及已上传状态无水平溢出。截图已人工查看。确认范围为新格式提示与原有布局；参考稿是否必填由其他改动处理。

## 验证与边界

- Windows / Node 24.22.1 / Microsoft Edge。第三方依赖复用本机已安装版本，工作区包指向本分支。contracts、domain、registry、context、API、worker、web TypeScript 检查和 Vite 构建通过；Vite 保留既有大包体提示。
- 契约校验对应 `check:contracts` 的全部子命令：72 个测试、179 个公共示例、12 个内部参考库示例、4 个生命周期示例通过。
- web `api.test.js`：25 个测试通过，覆盖公开错误原因与安全中文文案。
- `prospectus-panel.spec.ts`：29 个场景均已通过。首轮 27 通过；冷启动模块导入超时和 QA 入口重选脚本使用了隐藏按钮的 2 项已复验通过，相关重选路径及截图共复验 8 项全部通过。覆盖选择／拖拽拒绝 PDF、拒绝 `.doc`、大写 `.DOCX` 成功、所属更新项目的共用入口、非更新项目 PDF、原上传重试及已有文件。
- API `prospectus-upload`、`material-role-copy`、`upload-reuse`：独立 PostgreSQL 16 / Azurite 的 5 个测试通过，非 skipped；最终上传守卫调整后单独复验 `prospectus-upload` 通过。覆盖新上传拒绝、旧未完成会话拒绝、审计 PDF、其他项目 PDF、旧 PDF 读取／下载／采用、原完成回执、同哈希复用和容量边界。
- 另 5 个兼容回归通过：项目文件集合、更新项目端到端、旧 PDF 原稿信息更正（2 项）及上传频次控制。项目集合旧样例补齐当前版本、原稿引用及原稿信息后复验通过；这些调整只修正测试输入，不改变生产行为。

所有样本为 synthetic；真实 API、数据库和 Blob 链路用于上传验证，浏览器组件使用模拟 API。未调用模型，未验证完整募集书生成质量，未接触生产或客户材料。无数据库迁移、依赖新增和 worker 行为变更。代码完成后仍需本地集成验收与专门发布 chat 统一上线。
