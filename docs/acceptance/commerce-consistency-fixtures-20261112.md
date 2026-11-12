# 历史报价与一致性工作台测试维护回执

Issue #1094；PR #1097；测试日期 2026-11-12。

本次只维护 `commerce-task-scopes.spec.ts`（9 项）和 `file-consistency-workbench.spec.ts`（25 项）。完整第三轮 **34 pass / 0 fail / 0 skip / 0 flaky**，每项仅执行一次。固定受测代码 `ab32268e72b6a1eff2184a25ae92a305cf3e7263`，tree `ac132eb01f902f93045dd2b9c43d469475dbdad6`，基线 develop `d06203702675e5f4f992359325c08d9f8e60ec37`。后续仅增加本回执和 JSON，不改变受测代码。

## 维护范围与保留约束

- 通过已有 fixture helper 校验真实 int64 字符串协议后比较数值域；局部补齐 QA 所需募集书，公共 fixture 不变。
- 按 2026-10-29 单步开始决策与 2026-11-09 简化工作流，验证缺少知识选项、默认 use_knowledge=false、只读要求及原题目不变；不恢复已取消的范围编辑控件。
- 历史免费检查与每份 4,500 积分更新显式关闭新 commerce/subscription 模式。保留金额、范围、取消、异常恢复、幂等、人工事项和布局断言；新增加免费重试精确两字段请求、无新增收费写入与相同原字节重放核对。
- 支付恢复链接使用当前文案，原 href/项目/恢复断言保留。下载响应补正式 Content-Disposition，原文件名断言保留，增加实际字节比较及 URL/name 诊断。
- 原 34 个用例标题、顺序及条件 skip 保持一致。本轮条件 skip 实际为 false。原 expect 表达式仅有已复核的选择器或文案变更，matcher 数由 47→51、229→234。独立只读复核未发现阻碍。

## 执行结果

| 轮次 | 受测提交 | pass / fail / skip / flaky | 浏览器秒数 | 含准备清理秒数 |
| --- | --- | --- | --- | --- |
| round1 | 9a33ba3b | 31 / 3 / 0 / 0 | 282.061 | 342.904 |
| round2 | ab32268e | 33 / 1 / 0 / 0 | 337.391 | 394.954 |
| round3-utf8 | ab32268e | 34 / 0 / 0 / 0 | 335.320 | 394.667 |

三轮均完整执行两文件，单 worker、零重试；浏览器全局上限保持 540 秒。缓存镜像为 `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`，Node v22.23.3、Playwright 1.63.0。1 CPU / 2 GiB、network none，无挂载/端口/PG/模型。源码通过 git archive 取原始 Git blob；每轮 3,626 文件执行前后零差异，缓存依赖锁一致。容器均已删除并核验。第三轮与第二轮源码归档、用例顺序及容器内执行器 SHA256 完全相同，仅测试进程的 LANG/LC_ALL 为 C.UTF-8。

## 下载残余的环境诊断

第二轮唯一失败为下载建议名回退成 `download`，元数据和 HTTP 头有正确中文名，字节核对通过。Issue #1103 独立进行同镜像、固定 develop `867dbb22988a450cda05a004cdc2589ff68a7f9c`、同探针与回放 SHA256 的 7 路径×2 次对照：默认 POSIX 环境 12 个中文名全回退、2 个 ASCII 名正常；仅子进程设置 LANG=C.UTF-8、LC_ALL=C.UTF-8 后 14/14 名称与字节正确。原生 anchor（删除/保留 DOM）、产品 helper、File-backed、fallback 和真实工作台回放均包括在内。点击时 download property/attribute 始终正确，全部字节 SHA256 不变。

因此 #1103 更正为测试环境任务，不计为新增产品功能 Bug，无产品改动，也未将 `download` 改为期望。两轮诊断各 3,627 原 Git 文件零变化且容器均清理。随后第三轮才完整复跑原 34 项；诊断完成本身未当作原测试通过。

## 证据与边界

同目录 JSON 登记所有 34 项标题/结果、三轮汇总和原始报告 SHA256、隔离与清理记录、静态断言审计以及 14 项 locale 对照。完整原始回执位于本机 BondDraftAI 的 `work/commerce-consistency-tests-20261112/{round1,round2,round3-utf8}`，诊断位于 `work/download-filename-diagnostic-20261112/{round1,round2-utf8}`。失败 trace 和失败摘要保留。

真实网页和 Chromium 执行，HTTP 项目、金额与文件均为固定 synthetic 响应；无真实后端/PG/模型/支付调用。本回执覆盖这两文件，原 d3028cb2 全量 gate 的相关 15 个失败原始记录保留，完整 gate 仍为 failed。不能据此宣称完整 gate 通过或用户已验收。

测试维护代码和定向验证完成，尚未部署，待统一发布。
