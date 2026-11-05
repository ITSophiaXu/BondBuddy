# 历史／参考募集书仅支持 Word 原稿

2026-11-05 用户确认：更新募集书时移除 PDF 上传，只支持 Word，以便沿用历史稿的字体、段落、表格和页面设置。支持格式为 `.docx`；旧版 `.doc` 不在本次支持范围。

- 规则按所属项目生效：`kind=update` 的 `historical`、`reference` 新上传只接受 `.docx` 和对应的 Word MIME 声明。点击选择、拖入文件、项目文件页和文件生成页共用的募集书入口使用相同限制。
- 服务端在创建上传、接收字节、完成上传及参考稿转历史稿时校验。更新前留下的未完成 PDF 上传不能继续保存为新材料。文件大小、归属、哈希和存储校验继续适用；不恢复已取消的上传时全文解析流程。
- 已完成的上传重试、已有 PDF 的查看、下载和版本选择保留，不改旧任务、原始材料或费用。新规则不追溯删除旧稿。
- 审计报告、财务报表及其他补充材料仍可上传 PDF；其他项目类型的原有格式支持保留。
- `ProspectusVersionsResponse.upload_docx_only` 为可选布尔字段，服务端按项目类型返回，供共用入口选择提示和文件过滤器。拒绝返回 `MATERIAL_FORMAT_UNSUPPORTED` 及公开字段原因 `material_upload / PROSPECTUS_DOCX_ONLY`。浏览器使用固定中文提示，不直接展示服务端诊断文字。

原型为 `product-prototype/public/prospectus-reference.html` 与 `project-workspace.js`；对应实现为 `apps/web/src/prospectus-panel.ts`、`main.ts` 及上传 API。本次只调整格式支持，不包含另行开发的参考稿必填行为，也不保证仅靠改格式即可解决所有模板还原问题。

无数据库迁移、依赖或 worker 行为变更。开发、自测和本地原型对照不等于用户验收；由专门发布 chat 统一集成与发布。
