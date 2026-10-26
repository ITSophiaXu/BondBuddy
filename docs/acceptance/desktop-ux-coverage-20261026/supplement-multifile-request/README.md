# 复核与文书续做请求准备：本地专项

本切片将真实暂停时捕获的 M3 复核文件、M4 文书及候选材料变化，交给各自生产 stage 共用的实际 prompt/workspace builder。**仅准备请求，没有采用补料、V2、报价确认、模型续做、追加扣款或补料后的新 Word。G03 / UX-A03 与完整 goal 仍 active。** 未推送、创建 PR 或部署。

## 行为与边界

- API 与已有 M1 preparer 共用回执、准确执行/输入、暂停 checkpoint、stage prompt、唯一完整 captured result 和私有文件核对。候选 compiler 与 HTTP 草稿响应共用；完整材料变化保留新增、替换、未变和来源项目，不以项目最新草稿替代指定回执。
- M3 实际 stage 与内部 preparer 共用 `buildReviewFileRequest()`。候选源稿、原复核要求及准确历史报告选定的问题范围进入实际 `input.json`。旧报告和批注放在 `previous_work/` 并明确为待重新核实的来源参考，不自动扩展问题范围或成为已核事实。准确修订、接受提案及纯导出不因此获得补料执行权限。
- M4 共用 `buildM4DocumentRequest()`；旧正文和编制说明独立放入 `previous_work/`。原执行 gate 核对真实来源项目、主文档、模板、正式 edit_base、知识及要求；skill、helper 和模型 method 必须匹配旧结果。候选输入不伪装成 run/lease 的原输入，也不替换正式底稿或已交付成果。
- 两类 preparer 在 workspace I/O 前后重核真实暂停边界、plan 和准确来源；实际文件副本及 continuation 元数据参与 hash 核验。返回的 preparation 为深拷贝，调用方修改它不能改变内部请求。私有正文读取保留既有访问审计，不能声称数据库完全无写入。
- 没有保留 scratch 或建立可靠章节/问题依赖图。请求明确要求结合完整候选材料重新核对，不证明已执行精确局部复用或恢复任意中途进度。M4 的 project_file 分支额外核验关联源文件的 scratch 副本完整性，因此不宣称所有 V1 行为完全不变。
- B“必要重做另行报价、确认后继续”已选；B1/B2 具体计算规则仍待确定。请求准备不授予采用、恢复队列、模型调用、收集成果或收费权限。

## 最终采用结果

| 独立集合 | 通过 | 失败 | 跳过 |
| --- | ---: | ---: | ---: |
| API 文件准备、原 M1 准备、候选输入、草稿与已保存工作 | 194 | 0 | 0 |
| Worker M1/M3/M4 共用 writer 与真实请求准备 | 28 | 0 | 0 |
| Worker 原执行、暂停、交付与 M4 回归 | 82 | 0 | 5 |

contracts、API、Worker 构建及 web typecheck 通过。最终前后各 **2,410** 项源码、编译输出、Python、固定 skills/编制知识与配置冻结相等；snapshot SHA-256 均为 `1a764f015afd36cfd44ac355ab114877efdb5f3636a075b8f1d3cbf90415ebd7`。确切范围见 snapshot/verifier；外部运行时与依赖包不在冻结范围。20 个变更源码/测试文件另与实际 Git 过滤后的 staged blob 核对，不能将 CRLF/LF 归一化误报为源码变更。

回归中的 5 项跳过受平台条件及未配置的 Blob/Azurite 测试环境限制，分别为 M4 端到端交付/计量与输出 symlink 两项，以及 DOCX/PDF 复核交付恢复与 symlink 三项；复核 DOCX/PDF 链路还明确要求 Linux。它们没有通过复验，不据此次结果声称这些完整流程通过。其余集合使用真实 PostgreSQL/HTTP、合成 Word/模型结果和内存私有对象实现；没有调用真实供应商、Azure Blob、支付服务或客户文件，也没有浏览器、Word/WPS 视觉或专业内容验收。测试计数不换算为用户旅程覆盖率。

## 失败、修复与证据

初轮 API 为 193 通过/1 失败，Worker 准备为 26 通过/2 失败，回归为 69 通过/13 失败/5 跳过，分别保留。前三个失败来自 differential 夹具的历史来源 run 尚活跃；修复为实际 claim、报告登记、合成 Word 交付及成功终态后再创建当前 run，未绕过项目互斥。13 个回归失败来自 M4 单测 fake job 缺 checkpoint；夹具现返回 queue writer 的真实 stages 和执行身份 stamp，业务断言与生产 gate 均保留。

早期两次 Worker 构建因新增测试类型错误失败，修正后重新构建；失败回执独立入档，不计入采用结果。一次编辑期探索性 Worker typecheck 在受控 verifier 外运行，无本档受控回执；本档不声称涵盖所有 shell 命令。最终独立只读复核未发现来源、返回数据变更、复核范围或固定方法的阻断问题。

采用轮次及原始记录见 [summary.json](summary.json)、[selection.json](selection.json)、[raw-files.json](raw-files.json) 和 [manifest.json](manifest.json)。每次命令、全部 verifier 版本及原始失败分别保留；压缩副本按原始字节 SHA-256 核对。已测试源码与准确暂存文件证明见 [sources.json](sources.json)。不将失败、重复执行或跳过合计成通过数。

专用 PostgreSQL 使用 `.local/report-postgres/data`、loopback 15540、`bb_report_test` 和 `bb_execution_report_template_20261027`；启动、身份与停止记录核对同一 PID **50972**。最终审计后按准确身份停止，确认无 PID 文件；数据库审计仅涵盖 verifier 明列的表，不推广至未列出的表。源码冻结、停止与最终采用回执由 selection 明确指定。
