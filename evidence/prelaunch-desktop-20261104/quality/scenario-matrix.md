# 文件生成质量场景矩阵

状态口径：`机械通过` 只涵盖本行客观断言；`部分覆盖` 不可计为完整验收；`政策缺口` 是现行行为不符合 2026-11-01 质量决定；`待执行` 没有本轮运行证据。所有真实模型、独立业务和视觉结论保持未完成。

| ID | 必备场景与客观标准 | 本轮证据 | 状态与剩余依赖 |
| --- | --- | --- | --- |
| Q01 | 原稿/补充材料原字节、大小、版本清单与 manifest SHA 完全一致，原件不变 | `authorized-samples.log`：15 原件、4 案例；授权 parser/fixed-edit 原样复核 hash | 机械通过；只证明已登记样本完整性 |
| Q02 | 输入锁定精确已采用原稿、模板 material/version/hash、源/目标期间；替换/过期选择不写新输入；自动采用迁移不改旧输入 | `api-input-lock.log` 的 source-format unit/PG、auto-adoption 共 6 项 | 部分覆盖；#871 新增 prospectus-source-lock/none-baseline 仅在独立分支，最终候选必须补固定清单 |
| Q03 | 真实注册/会话→项目→上传→解析→原稿/issuer 引用→不可变输入；跨账号、撤回或错版引用拒绝 | `api-http-input-chain-full.log` 5/5；真实 Fastify/隔离PG/本机Azurite，含 synthetic XLSX parser | 机械通过；不含浏览器到 worker 的 #871 独立 browser-input-chain |
| Q04 | worker 在处理前检查 owner/project/input_hash/material pin，不接受后来变动的版本替代已锁定输入 | `worker-mechanical.log` unified-input；`file-authoring-format` 精确来源/续改模板选择 | 部分覆盖；是阶段/fixture检查，不是完整真实 worker 运行或 #871 恢复不变量验收 |
| Q05 | DOCX 段落/表格、XLSX 单元格/单位/隐藏页/缓存与 PDF 页锚点可追溯；损坏、加密、hash错、超限不得伪造成功 | `python-mechanical.log` parser 39 项＋授权 DOCX parser 1 项，材料工具真实 stdio MCP | 机械通过；扫描财务表真实 OCR、全部 15 份逐值提取及业务口径仍未验收 |
| Q06 | 财务来源必须绑定实际主体/期间/单位和准确单元格；不确定值保持 needs-review | `worker-authorized-facts.log` 7/7，含授权任丘稿真实 parser 与有限 16 个年度位置 | 部分覆盖；不是当前季度全文更新、公式或 #871 固定43位置独立验收 |
| Q07 | 同金额不同期间不全局替换；缺事实保留原文并具体标注；来源链接同时绑定源/目标文字；未知/重复 fact ID 拒绝 | `python-project-files.log` 5/5；Linux首稿writer8/8；revision CLI5项 | 机械通过；当前真实正文是否完整处理所有事实须独立全文复核 |
| Q08 | 目录/标题层级/编号/顺序与正文结构分开；旧修订不隐藏真实标题变化 | `python-mechanical.log` source-outline7项 | 机械通过；没有对最终真实生成稿全章节逐项确认 |
| Q09 | 四份真实历史 DOCX 经 synthetic 编辑保持包资源/样式/媒体/未改内容，源hash不变 | `python-mechanical.log` authorized-fixed-edit 4 子案例、fixed-edit18项 | 机械通过；不代表真实模型选择了正确原稿或正确修改范围，也不证明页面排版 |
| Q10 | 修订稿含真实增删；接受修订等于清洁稿、拒绝本轮修订还原基线；首稿无伪造历史 | `python-mechanical.log` file-authoring7、unified-word8、word-delivery5；Linux首稿8项 | 机械通过；Windows目录权限断言1失败保留，Linux原样复验通过；整套固定Linux门禁未跑 |
| Q11 | 双Word归属、run/version、MIME、元数据与下载字节hash一致；foreign/missing/tampered Blob不交付 | `worker-mechanical.log` 交付边界；本批其他[任务流程记录](../task-flow/README.md)含下载fixture回归 | 部分覆盖；本quality任务没有下载生产真实模型双稿，不能把fixture读回作为内容验收 |
| Q12 | 实际 worker 从锁定材料经工具/沙箱/调用journal到检查点/私有Blob/终态；断线恢复不重调未知模型 | 本轮未启动worker供应商执行，仅运行阶段/工具机械测试 | 待执行；准确候选Linux沙箱、PG/Azurite、真实worker集成及生产模型验收 |
| Q13 | 可信服务端质量检查失败必须 failed，不登记正常成果，不写 completed checkpoint | 当前 `file-authoring-delivery.test.ts:20` 反而要求 WORD_QUALITY_REJECTED advisory→deliver/content_review=not_performed | **政策缺口/发布阻断**；由独立#871修复及固定gate验证，不能在本任务静默放宽/移植 |
| Q14 | #871当前final commit/tree固定机械、真实模型金样、独立财务/章节/渲染及Word/WPS复核 | 仅只读#871决定与失败记录，未跑其完整gate、未签凭据 | 待执行/发布阻断；机械绿不能替代真实模型或独立确认 |
| Q15 | 新无基线首稿合法双同hash/同ID；真实API/PG的 result/current 精确pin，并能续改准确清洁稿 | 第二轮 subject `8df8b50`，`continuation-api-pg.log/results.json`：真实API/PG/queue登记合成同ID首稿，元数据→编译guard→两选择POST input持久化精确previous_output/format pin，实际下载hash一致 | 当前实现机械通过；synthetic principal/DOCX/内存Blob、无模型；#871最终合入候选仍须重跑 |
| Q16 | 质量拒绝run=failed、artifact=null，不出现正常artifact/生成版本；不能由失败结果建立新input续改 | #871失败checkpoint设计只读审查；本轮没有该候选执行结果 | 待执行；核对真实数据库/HTTP返回及零新input/run |
| Q17 | 准备续改后原成果hash/version/available变化必须0新run；准备/提交两次re-read保留；合法同ID别名不放宽来源约束 | 第二轮真实API/PG：正常新generation改变current version/hash/selection，旧选择409；错hash/版本请求409；合成Blob缺失/损坏使metadata503及两choice guard拒绝；公开DELETE project实际revoked后404。各拒绝新增input/run均0，未手改immutable行 | 部分机械通过；存储为明确故障注入，availability撤销限项目删除；#871合入、首稿expiry及真实浏览器整链待做 |
| Q18 | 已存在passed/available成果不能被自动回填为新word-quality-v1通过，旧漏稿成果不因同ID被“洗白” | 第二轮真实API与PG旧generated_pair_v1/content_review=not_performed在续改读取后不变，未出现word-quality-v1；#871 DTO仅只读审查 | 当前读取行为有有限机械证据；不追认正文或漏稿质量，不证明未合入#871的新gate/迁移 |

不得将 Q15、Q17/Q18 当前实现的有限机械证据，写成 Q16 或 #871 最终合入候选集成通过。#871旧候选真实失败记录也不能因本轮机械通过而更改状态。第二轮7/7包含一个父test和6个场景，真实routes/queue事务/编译guard与合成认证/Word/内存Blob的边界及复跑原文见[README](README.md#第二轮续改跨层机械证据)。routes通过app.inject调用，没有经过TCP/Nginx/ApiClient/浏览器。0新增input/run不等于0数据库总写入：metadata GET仍写下载授权与审计。

## 产品入口与实际输出格式

以下映射按产品入口区分，不把募集书 writer/交付测试当成其他模块已验收。`Linux94` 指 `linux-product-export.log`；`Node54` 指 `product-export-boundaries.log`。两者均无真实模型，Node stage 注入 fake 回调，下载 handler 使用内存 DB/Blob。Node54 在 Windows 的两项 symlink skip 已另以现有 WSL Node 原样复验，`linux-symlink-boundaries.log` 为 2/2 通过、0 skip；保留原始 skip，不代表整套 stage 已在 Linux 重跑。

| 入口 | 实际文件与格式 | 本轮直接机械证据 | 尚不能据此宣称 |
| --- | --- | --- | --- |
| 募集书更新／无原稿首稿 | 修订稿、清洁稿 DOCX；无历史首稿可合法同 ID/同字节，是否有基线按输入决定 | Q01–Q14，真实原件 parser/fixed-edit 与 synthetic writer | 新质量政策已生效、真实原稿完整保留、正文事实完整更新、真实分页合格；Q13 明确阻断 |
| 项目文件更新 | DOCX/PDF 读取与定位，修改后导出修订稿、清洁稿、基线 DOCX | `python-project-files.log` 5 项；Linux94 的 corrections/source pin 与歧义拒绝 | PDF 版式忠实转换、跨文件/全部财务事实更新及真实 worker 注册下载通过 |
| 文件复核／项目文件一致性检查 | 复核报告 DOCX；源 DOCX 的原生批注 DOCX，源 PDF 的批注 PDF；采纳修改后的 DOCX 修订/清洁稿及报告 | Linux94 的 review Word/annotations/corrections；Node54 的 review-file-stage，拒绝无输出、进度文本、空报告及 invalid Word | 复核没有漏项、法规/结论正确、普通文件批次部分失败已恢复；完整 PG/账务/真实模型链未跑 |
| 文件生成（M4 文书） | 正文 DOCX＋独立编制说明 DOCX，选定 Word 模板副本保持可编辑 | Node54 的 M4 多品种/模板/交付边界；Linux94 的计算工具、期间/单位/主体与 effective source | 各文书真实模型编制内容合格、编制说明与业务全文一致、所有实际模板逐页视觉合格 |
| 底稿生成／目录批次 | 单项正文或不适用/缺材料说明 DOCX；编制说明 DOCX；批量下载 ZIP，内含 DOCX；XLSX 目录是输入 | Linux94 的 shared11、147 中性模板包、source4；Node54 的直接底稿与248文件ZIP逐成员校验 | 真实批次全部内容可信、部分项生成失败后的结算/恢复正确、付费复核及继续修改已端到端通过 |
| 诚信核查 | 企业、个人按实际对象分别导出 DOCX；截图嵌入 Word，证据可由图片/PDF/Word输入 | Linux94 的 integrity_report4：整图保留、未签章、失败/未核实页面不冒充结果、诊断和不利事实进明细 | 官网实际查询成功、证据主体匹配、验证码/登录及部分网站失败恢复、实际导出/重复导出的PG链通过 |
| 问答及附件回填 | DOCX 问题原稿原位回填并输出 DOCX；PDF/旧 DOC 问题转 Word；XLSX 可作证据输入 | Linux94 的 project_qa9：表格/页脚/长文/空值零值/缺材料；真实本机 DOC/PDF 转换；XLSX位置保留 | 回答事实正确、全部问题已覆盖、真实材料多附件部分失败处理/账务/版本注册下载通过 |
| 继续修改／基于成果再次生成 | 沿原入口生成新的 DOCX 或修订/清洁对；已有下载字节与精确来源 pin 应保留 | Linux94 的 fixed source/accept revisions/重复复核保留人工批注；Node54 的 M4 edit-base、hash/版本/owner约束；第二轮Q15真实API/PG/queue+编译guard精确锁输入，Q17/Q18有限机械证据 | 真实浏览器到worker模型续改整链通过、#871质量拒绝合入通过，或旧 passed 成果已被新质量政策追认 |

本轮只验证上述已有输出格式。没有生成 XLSX 成果的验收，也没有将可读 PDF 输入理解成所有产品都提供 PDF 成果。PDF 批注是文件复核的专门输出；普通文书、底稿、问答和诚信报告为 Word。

## 跨入口失败与重试场景

| 风险 | 本轮已直接覆盖 | 必须补做的最终候选场景 | 状态 |
| --- | --- | --- | --- |
| 输出损坏、假格式或无内容 | Node54 DOCX inspector 的 CRC、XML、关系、压缩/大小限制；ZIP 拒绝丢失/截断/损坏文件；复核 stage 拒绝进度/空/invalid Word并保留诊断 | 每个入口真实 worker→私有 Blob→artifact→下载都注入损坏并确认不交付、不误计费；M1 质量拒绝依然有 Q13 缺口 | 部分覆盖，不能外推全入口质量拒绝 |
| 错版、错 hash、异主或撤回材料 | 输入链 HTTP/PG 5项；Linux94 source hash/期间/单位/合并母公司冲突；Node54 M4精确pin和edit-base限制、ZIP pin/name/owner变化失效；第二轮Q15/Q17当前续改API/PG/guard负例和正常换稿证据 | 其他各入口准备后替换/撤回材料或成果、提交/恢复二次读回与错误扣费；Q15–Q18的#871最终合入验证 | 部分覆盖；输入链和本轮募集书续改子集有真实PG证据 |
| 一个批次或多附件部分失败 | 问答扫描/不可读页保留具体缺口、不编问题；诚信失败/未核实页不做成功截图；底稿无依据形成具体说明；ZIP任何坏成员整包拒绝后可重试 | 普通文件批量、底稿多项、诚信多站点和问答多附件在中途失败/取消/断线后状态、已成功成果、重试范围及扣费均准确；未跑现存相关PG suite | 待执行真实集成；ZIP原子失败不是生成批次部分恢复 |
| 重复生成、重复下载或恢复 | 底稿shared crash replay字节相同；ZIP并发复用、pin失效、错误重试、取消；重复批注保留人工内容 | 各产品相同request重放不新增模型调用/收费；更换request后的明确再生成保留旧成果；未知模型结果断线不得重复调用 | 部分覆盖；本轮未跑跨入口真实PG/journal协议 |
| 继续修改与旧版本保留 | 修订接受/拒绝语义、原件hash不变；M4 edit-base类型/owner/version pin；两类Word人工批注在重复复核保留；第二轮Q15同ID首稿准确续改input与Q17正常换稿后旧result保留 | 对真实模型成果从浏览器结果页选择续改，准确下载/准备/提交双读回；#871同ID合法首稿与failed quality拒绝集成、expiry guard按Q15–Q18验证 | 当前API/PG有限通过；完整真实用户/模型与#871合入链待执行 |
| 实际格式与客户端打开 | 实际生成并重新解析DOCX/PDF；248成员ZIP独立CRC/hash验证；本机LibreOffice完成旧DOC转换；147中性Word模板包校验 | 最终各入口真实成果逐页渲染、Word/WPS打开/批注/修订/表格编辑，核对用户文件名、MIME和实际字节格式一致 | 部分覆盖；本轮没有最终成果视觉签收 |

上述待执行项是覆盖缺口，不表示已经复现每个潜在故障；也不能由无模型机械通过签署收费发布质量结论。
