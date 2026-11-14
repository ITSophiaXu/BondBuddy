# 募集书恢复快照失败状态页：synthetic 验证证据

本目录仅含 18 张 PNG、manifest.json、本说明和独立 visual-review.json。实现版本为 `b1cb4528dc8cbe540befe82dc8dbc7b5f625d3e0`，全部业务接口使用既有测试 fixture；不含真实模型、真实任务或账户数据文件，不包含完整请求日志、私有脚本。

最终测试 **8/8 通过，用时 58.6 秒**：容量超限、存储失败、完整性失败、保存结果未确认四类原因，分别检查 1440×1000 和 390×844。状态卡标题、原因、可用重试入口、五步阶段及确认弹窗均纳入检查。只打开并取消确认弹窗，**retry POST = 0、外部页面请求 = 0、页面错误 = 0**；其他计数及逐图 SHA-256/尺寸见 [manifest.json](manifest.json)。

## 图片索引

文件名 `synthetic-{capacity,storage,integrity,incomplete}-{status,confirm}-{1440,390}.png` 为 16 张实现截图；`prototype-02db1f35-output-legacy-{1440,390}.png` 为两张原型图。

## 视觉复核及原型边界

本任务 **root 代理已实际逐图查看全部 18 张最终图片并通过自查**，具体结论与绑定哈希见 [visual-review.json](visual-review.json)。这是代理自查，**不是用户验收，也不是负责人确认或生产发布批准**。

原型固定为 `02db1f3567718490d63ac7039678ed6c4ae03fc7` 的 `authoring-live-progress.html` 和 `authoring-status.css`，使用原有 `output-legacy` 状态对照卡片、按钮和五步结构，仅将 CSS 内联用于离线载入。原型没有四种新原因或当前应用内 DOM 确认弹窗，不构造不存在的对应原型。

以下差异尚未获得负责人确认，**不宣称像素对齐**：现有产品外壳、试用计费说明与原型积分示例、实现 2 份材料与原型 3 份材料、手机按钮顺序、第三步文字换行，以及新增原因/应用内确认弹窗的精确呈现。

## 已保留的失败与修正

首轮 PATCH 允许表遗漏导致的 harness 失败仍保留在私有 `work/issue1343-synthetic-ui-a63e4230-20261114/`；只补全既有 fixture 的合成项目 PATCH 后重跑。

旧 `work/issue1343-synthetic-ui-a63e4230-20261114-v2/` 虽通过功能检查，但 root 视觉复核发现手机卡片顶部被固定顶栏遮挡，未被认定为视觉完成。本次修正仅涉及私有截图取景，并对卡片完整入镜增加断言；历史事件文案由实现 commit 修正。旧证据没有删除或覆盖，也不随本目录提交。

最新原始运行证据保留在私有 `work/issue1343-synthetic-ui-b1cb4528-20261114/`。本目录不包含这些完整日志；不能据本模拟验证声称真实模型生成、端到端后端任务、用户验收或上线完成。
