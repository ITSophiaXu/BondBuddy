# 项目材料直接上传验收

本次用户要求：支持格式的原文件直接上传，内容读取由后续 Codex 编制任务负责；不以内容检查、独立解析或用户手动“核对”阻断保存。

诊断：错误编号 `90f234be-4cd5-41a7-aa4e-ab2cc56e1cc5` 对应旧 PDF 签章 profile 拒绝。获授权杞县 2025 审计报告原件在本地复现 `unresolved_pdf_reference`；原件 SHA-256 与线上上传声明一致。保存失败不能推导为原件损坏或 Codex 无法读取。

本地 Windows / Edge 定向浏览器测试 20/20 通过：包含丢失 PUT 回执、丢失 complete 回执、503 自动恢复、取消、登录刷新、归属隔离、重复内容复用、原稿信息必填及桌面／窄屏开始编制恢复。运行 `node ../../node_modules/@playwright/test/cli.js test tests/upload.spec.ts tests/project-execution.spec.ts --grep 'upload|material workflow'`。接口为 synthetic fixture，没有真实模型调用或扣费。

全仓 build 与 contracts 检查通过，最终 web build 通过。原件上传单元测试 2/2 通过，涵盖七种支持格式不解析内容、大小／声明限制，以及获授权 2024／2025 PDF 原字节/hash；本地缺 PG/Azurite，公共上传集成交由本 PR 的 Linux CI 验证，不将 skip 计为通过。旧内容工具仍由独立 legacy tests 覆盖；旧公共上传内容拒绝用例替换为原件保存策略用例。

截图基线是 `58e0ab2` 加本 PR 修改；原型为同一 checkout 的 `product-prototype/public/project-workspace.js`（最后修改 `5b8de08`）。两边均使用真实静态页面源码和 synthetic API；桌面 1440×960，窄屏 390×844，full-page PNG。

| 场景 | 实现 | 原型 |
| --- | --- | --- |
| 桌面已保存 | `recovered-desktop.png` | `prototype-desktop.png` |
| 窄屏已保存 | `recovered-mobile.png` | `prototype-mobile.png` |

已目视核对材料分区、保存反馈、末尾补充说明和开始按钮。实现测试含历史稿必填信息和多份材料，原型截图只上传合成 PDF，所以页面高度不同。沿用已有页面布局与导航，不声称逐像素一致。此次明确变化是：保存状态取代辅助解析状态、回执自动恢复，以及异常持续时“重试保存”取代例行“核对”；确认依据是本次用户要求，见产品决定。原型仍有旧“无法解析需替换”提示，被本次原件上传决定覆盖。

CI、PR、发布及线上复验结果在发布后补充；本记录当前不宣称已部署或已生成真实 Word。
