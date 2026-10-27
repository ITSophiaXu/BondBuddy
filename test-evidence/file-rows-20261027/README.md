# 文件清单与底稿操作区改版（2026-10-27）

产品和原型提交：cdb1e495b26c5a1f7246bfc25de27c09ec4c3bfd。关联 PR #762，影响已迁移文件生成页面（#361）。本次不变更业务契约、依赖或迁移。

## 设计与实现

- 模板页将文种勾选区、选择摘要和右侧模板卡片合并为单一文件清单。每行包含序号、原生文种下拉框、模板及折叠的已保存要求/依据、添加或更换模板、移除。
- 默认一条空行，添加一行直接聚焦下拉框；已有文种禁选，替换保持行位置，移除只影响当前清单。模板、资料、单文件要求和原上传恢复范围保持原语义。选项使用公共合同中的文种目录。
- 桌面表格最多520px，表头固定；手机按行纵向排布。新增控件最小44px。原来两个区域间的重复选择和模板卡片堆叠取消。
- 底稿页编制要求增加明确标签、提示和示例；范围确认区分数量、来源、单价/总额和主操作。判断前突出“判断生成范围”，判断后保留逐项理由、明确勾选确认和“确认并生成底稿”。费用规则及资料不足分类不变。
- 进度区分状态、完成数量、来源、时间和费用；统一绿色进度条，已完成文件使用主按钮下载 ZIP。

## 原型与实现对照

| 视口 | 实现组件 | 原型组件 |
| --- | --- | --- |
| 1440×960 | implementation-1440.png | prototype-1440.png |
| 390×960 | implementation-390.png | prototype-390.png |

上述四张图来自同尺寸视口、相同两种文种的合成示例，仅截取文件清单组件；外部固定操作栏避开截图组件。原型：product-prototype/public/file-generation.html、file-generation-preview.js、file-generation-ux.css。实现：apps/web/src/file-workspace.ts。组件布局一致，已有要求文字与图标来自各自示例；原型不调用API。

底稿准备、判断、进度的原型/实现全页对照在 apps/web/test-evidence/workpaper-batch/。原型与实际应用共有 workpaper-entry.css；实际页额外有项目、积分、辅助导航和 BondBuddy 浮层。原型运行状态为示例，实际测试的排队状态来自合成API。用户视觉验收待完成，无自行认定已验收。

## 验证

- TypeScript noEmit、Vite生产构建通过；既有大chunk提示保留。
- file-generation-workbench 37/37、generation-entry-intent 26/26、generation-mobile-workbench 11/11、workpaper-batch 8/8、batch-delivery-workbench 8/8、upload-entry-recovery 9/9，共99个不同用例通过。最终补充提交后重跑文件清单、上传恢复与交付54/54；对照截图位置调整后2/2再次通过。
- 覆盖增行、换类型、重复禁选、移除、插入顺序与刷新、最大12类、空选择、模板上传/复用、账号隔离、补料/要求恢复、确认前不提交、范围变化、费用及下载。测试API为mock，不代表新的真实模型生成。
- 旧移动布局断言随本次明确改版改为文件行交互，保留原保存恢复与输入锁定检查；11项现已全通过。

## 实际本地验收

http://localhost:5211 已更新到网页 cdb1e495；API/worker仍为9e9ddf35。仅更新本任务隔离Compose的web。就绪接口database/blob_storage/evidence_gate/worker_heartbeat均ok。

实际浏览器验证了四种文种逐行添加、类型替换、移除空行、法律意见书模板窗口、重复禁选及44px下拉框。1440/390px无页面横向溢出。测试项目当前四行尚缺模板，没有发起新上传、判断、生成或扣费。

原四项已完成底稿记录、原V1来源和目录保留。“下载已完成文件（ZIP）”实际下载成功，包内仍有1份底稿、1份编制说明、3份未生成说明和1份清单，共6项。无新增模型调用；此前生成使用真实后端/模型、合成样本及测试积分，边界见前序交接。

实际截图：documents-local-desktop.jpg、documents-local-mobile.jpg、workpapers-local-desktop.jpg、workpapers-local-mobile.jpg。账号和项目均为隔离的合成验收数据。

状态：开发和自测完成；本功能独立本地版可验收；用户尚未验收。代码完成，尚未部署，待统一发布。启停沿用 work/local-acceptance-20261027/control.ps1，不修改共享集成测试交接文件。
