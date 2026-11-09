# 本地上线前测试：桌面界面复核

本记录覆盖创建提示、参考募集书采用状态，以及材料不可读后的恢复提示。仅使用本地环境和合成示例；不涉及线上账号、真实客户文件或手机端。全文内容质量与支付账务结果另由各自的真实集成测试记录证明。

当前复核镜像为 `76b8e3c1dece9b50a745c3ff4e144f63d88aebfc`。创建提示、当前项目标识、采用状态、材料保存数量、材料行管理提示，以及两处残余文案的直接视觉证据已补齐。本轮验收源码 `73bf7b433dff853e3bfb513f0b5c971caa988525` 仅新增长文验收测试与脚本，产品镜像仍为前述 76b 版本。本记录中的生成／恢复通过只指 `fc76c9c7` 的短合成最小修订用例；新的完整 synthetic 长文与真实客户 sample 仍待主验收，不在这里标为已完成。

76b 最终图随后发现两个开始入口并列的恢复问题，文字可见不代表该交互已通过。唯一开始入口和旧输入冲突恢复已在本地源码修复，定向模拟 API 浏览器回归通过；**新镜像上的真实服务、零余额恢复及最终截图仍待复验**，以下 76b 图保留缺陷当时状态。

## 依据与固定版本

- 原型截图基线：`55a073c1d280836ee14d6f8c32786baaeaf95fca`。
- 当前实现镜像／四张最终截图版本：`76b8e3c1dece9b50a745c3ff4e144f63d88aebfc`。
- 本轮验收源码：`73bf7b433dff853e3bfb513f0b5c971caa988525`，相对 76b 仅新增九个测试／辅助脚本文件，没有产品代码变更。
- 历史四张补充截图版本：`f79d8589d0f7738b941140c5a4ad7e5a0945dc35`，保留修正残余文案前的原始证据。
- 历史三屏实现镜像／截图版本：`fc76c9c7e74aa420cba8a97962fc4e422565ee44`。保留该时间点的原始图，未用新截图覆盖旧证据。
- 上传／采用原型：`product-prototype/public/prospectus-reference.html`，文件最后修改提交 `fe3022cb3244140a569d8a13fe9c8b27a35e938b`。
- 失败恢复布局原型：`product-prototype/public/authoring-live-progress.html?state=word_failed`，文件最后修改提交 `9429841587dadba34bdb7ae8454be587ebdedf3a`。
- 实现：`apps/web/src/main.ts`、`prospectus-panel.ts`、`project-execution.ts`。
- 产品依据：[2026-11-05 参考募集书必填与材料区精简](../../product-decisions/2026-11-05-required-reference-prospectus.md)，优先于旧的无稿首稿决定；[上传后原稿信息必填](../../product-decisions/2026-10-03-source-information-required.md)。

原型截图均在上述基线的原始 HTML/CSS 上运行。使用 Windows、Microsoft Edge headless、1440 × 1000 视口、1 倍缩放；三张截图已目视检查，样式请求无失败。静态原型没有登录、真实 API、模型或付款动作。十一张实现截图由本地完整服务的合成账号产生，均为 1440 × 1000，原字节复制，未裁剪、修改页面或修饰图像。顶部黄色提示是本地模拟支付环境标识，不计为产品布局问题。

## 已核实的交互与文案

| 场景 | 原体验风险 | 当前实现核对 |
|---|---|---|
| 新建项目 | “没有历史募集书，也可以编制首稿”与新任务必须有参考稿的决定冲突 | 改为“先保存项目，再上传历史／参考募集书并填写原稿信息。”；下一步及必填材料明确 |
| 已采用参考募集书 | 材料行一律说“已保留在版本历史”，易让用户误认为当前稿未采用 | 改为“在上方募集书版本卡管理”；真实采用状态与下载／删除仍由上方版本卡显示 |
| 原稿或其他材料不可读 | 通用失败原因不说明如何纠正；将同一错误码一律归因于募集书又会误导旧任务 | `MATERIAL_UNREADABLE` 保留明确原因，提示“有材料无法读取”，通过“继续修改”检查并重传可读副本；原任务与已保存材料保留 |
| 当前项目标识 | 尚未启动任务也显示“正在处理” | `f79d8589` 改为“当前项目”，不暗示任务已执行 |
| 材料保存数量 | 首次上传后显示“已恢复”，并暴露“本次会话／服务端确认”等技术描述 | `f79d8589` 按材料 ID 去重后统一显示“已保存 N 份材料” |
| 材料保留原因 | 仅有不可变输入引用、尚未创建任务时也显示“已被任务或关联文件使用” | `76b8e3c1` 两处提示改为“已作为编制依据保留”；保留／删除判断未改变 |
| 已保存输入操作 | “继续上次提交”未说明按钮还会启动更新 | `76b8e3c1` 改为“用已保存内容开始更新”，与选择输入后调用 `start()` 的实际行为一致 |

第三项已核对旧 `materials_ready` 路径：财务／其他材料解析失败也可能返回 `MATERIAL_UNREADABLE`，因此通用提示不能声称一定是采用的募集书损坏。新增浏览器断言分别覆盖原稿及旧材料阶段，且两次刷新后仍显示同样原因；通过结果由主验收记录补充。

终态“继续修改”复用现有 `prepareNextVersion()`，为下一轮解锁材料；不要求用户停止已经失败的任务。恢复过程不得覆盖原任务输入，也不应重复结算旧任务。

## 76b 文案验收（启动恢复问题见下节）

| 场景／1440 × 1000 实现截图 | 直接视觉核对 |
|---|---|
| [创建页](implementation-76b-creation-reference-guidance-1440.png) | “先保存项目，再上传历史／参考募集书并填写原稿信息。”完整可见；已填发行人、市场、方式和目标报告期清晰 |
| [项目与空参考稿](implementation-76b-project-context-empty-reference-1440.png) | 顶部为“当前项目”；0 份材料、必填参考稿、格式／大小限制和空态指引一致；开始按钮不可用并说明缺少材料 |
| [保存并采用后](implementation-76b-saved-adopted-reference-1440.png) | “本次更新已选用”“已作为编制依据保留”“已保存 1 份材料”同时可见；底部明确为“用已保存内容开始更新”，不再使用“继续上次提交” |
| [材料行与原稿信息](implementation-76b-source-material-row-1440.png) | “在上方募集书版本卡管理”可见；同企业、上交所、普通私募公司债、2025 年末原稿声明与采用文件相对应，并位于财务材料之前；底部开始操作清晰 |

四图已逐张目视复核，没有发现文字重叠、目标提示被遮挡或按钮不可辨认。创建页提交按钮在视口下方，同次测试已通过该按钮创建项目；材料信息图顶部处于滚动截面，未将截面外内容当作缺失。四张 PNG 尺寸均由文件头复核为 1440 × 1000，复制前后 SHA-256 一致。

复用非模型 `local-prelaunch-source-correction.spec.ts`，最终执行结果为 **1/1 通过，26.7 秒**。原始证据在 `.local/local-prelaunch/bad-cases/final-76b-ui-2026-11-09T02-34-47-411Z-c8ec3027/user-corrects-valid-but-mistaken-source-declarations-reload-immutable-in/`。已直接复核 `evidence.json`：

- `synthetic:true`、`apiMocked:false`、入口 `http://localhost:18087`；运行身份记录为 `production_server:true`、`synthetic_payment:true`、`model_results_synthetic:false`，`release_sha` 为完整 76b SHA。
- `finalized:true`、`phase:finished`、`status:passed`、`errors:[]`、`pageErrors:[]`、`finalDatabaseObserved:true`，且存在 `final-database`，没有将中间状态当作完成。
- 最终数据库：`runs=0`、`creditEvents=0`、`reservations=0`、`modelCalls=0`、`remaining=0`、`frozen=0`；保存 1 份材料、1 个项目和 2 份不可变输入。本用例未充值、执行模型任务或扣费。
- 用户纠正格式有效但内容错误的原稿声明后，重新加载保留正确选择；原不可变输入仍保留。旧输入配旧报价返回 `409 INPUT_REVISION_CONFLICT`，新旧输入／报价交叉混用均返回 `409 QUOTE_CHANGED`，三个拒绝场景均没有创建任务、预留或模型调用。

“用已保存内容开始更新”不是单纯选择或保存按钮。其处理函数在核对已保存补充要求并选择输入后调用 `start()`，因此文案明确告知用户会开始更新。本次无模型用例只证明截图文案、声明纠正和被拒绝提交没有副作用，不把它记为按钮成功启动或模型生成的实测证据。现有三项定向浏览器回归与 web build 已通过，执行、选择、保留、删除和计费逻辑未随本次文案改动调整。

| 76b 实现文件 | SHA-256 |
|---|---|
| `implementation-76b-creation-reference-guidance-1440.png` | `866b230d036c2b0b3215c2dc5efddd0caa2f4ee2ec0712e4e4b5bfe3db5f1b25` |
| `implementation-76b-project-context-empty-reference-1440.png` | `1efdfec9094227ed7c0b70f66db6e44c33b498136881ec0ee3790e6b5a7915f2` |
| `implementation-76b-saved-adopted-reference-1440.png` | `254344a1f382a6ae3f098ec055ae3018ed9cc6b54a87d325f58d35e395dd43b4` |
| `implementation-76b-source-material-row-1440.png` | `ed4abb2f06405af78106df7ba7ff0ebb62b6b421ec21f9d55cf8d3c8c1c687c0` |

## 76b 发现的启动恢复问题：本地修复，待新镜像复验

保存采用图底部同时出现“用已保存内容开始更新”和“开始更新”。前者直接选择恢复的不可变输入，后者通常按当前页面重新锁定输入，用户看不到差别。76b 会对所有“已有输入但没有任务”的准备页显示恢复入口，余额不足后返回、提交失败后刷新也可能出现，不仅是本次测试的特例。

继续修改原稿声明后，旧恢复入口仍可能选择过期输入。当前付费 API 会拒绝过期输入或错配报价，已有真实服务证据没有任务或扣费；但前端在明确的 `INPUT_REVISION_CONFLICT` 后未清除旧选择，下一次主按钮仍可能重试旧输入。因此此处的后台保护通过不能替代前端任务可完成性验收。

本地修复仅涉及 `project-execution.ts` 及测试，未改变后端、计费或契约：

- 页面仅保留主“开始更新”。保存响应丢失时先重新读取；只有读到紧接已知版本的下一输入，且本页修改状态、草稿版本及材料版本匹配，才保留恢复候选，仍须用户明确点击主按钮。另一页面造成版本跨越时不会误认作本页回执；当前保存契约没有请求 ID，不能将这组检查描述为完整证明所有并发保存归属。
- 原稿信息、目标、材料或补充说明发生修改即退出旧输入恢复，下一次按当前内容保存。回读本身不保存或启动。
- 输入冲突被明确拒绝后清除旧选择、预检和报价，允许下一次主按钮锁定当前输入。不确定执行仍保留完整原请求及幂等重试路径。

定向模拟 API 浏览器测试的首次运行 **4/4 失败**，复现双入口和报价／执行拒绝后的旧输入复用；修复后 **13/13 通过，36.0 秒**，包含回读后修改原稿、目标、说明、材料，丢失保存响应不重复 POST，丢失执行响应使用原请求，双击与配额拒绝重试。结果分别在 `.local/local-prelaunch/ui-single-start-red-20261109/` 与 `.local/local-prelaunch/ui-single-start-green-20261109/`。`npm run build -w @bondbuddy/web` 通过，仅保留既有包体积提示。这些测试使用模拟 HTTP 边界，不能报告为真实服务或模型通过。

随后加入跨页晚版本反例，完整运行 `project-execution.spec.ts` 与 `authoring-continuation.spec.ts`：**118 通过、1 失败、1 跳过，5.1 分钟**，证据在 `.local/local-prelaunch/ui-single-start-full-20261109/`。唯一失败为旧的“删除所有原稿后仍能以首稿开始”用例，与 11 月 5 日参考稿必填决定直接冲突；原失败记录保留，跳过项是既有的条件截图用例。该旧用例已改为验证缺稿时阻止开始且保留旧任务／输入／财务材料，提供已保存采用原稿并刷新后才新建一轮，上传原稿对应的 `edit_base:null` 断言仍保留。调整后仅复验该例和相关恢复场景，**7/7 通过，26.2 秒**，证据在 `.local/local-prelaunch/ui-single-start-current-reference-20261109/`；没有将先前全量结果改写为 120 项全通过。最终源码 web build 与严格 TypeScript 检查均通过，独立审查未发现本补丁范围阻断。

`local-prelaunch-source-correction.spec.ts` 已扩展真实服务回归：恢复页纠正原稿声明后点击唯一主按钮，核对新的输入／报价及声明版本，并在零余额路径确认没有任务、预留、扣费或模型调用。该新增段落尚未运行；此前 76b 的 1/1、26.7 秒结果不包含它。待主任务构建新镜像、运行窗口空闲后复验并补新截图，不能用 76b 截图证明双入口已消失。

## 历史 f79 文案补充验收

| 场景／1440 × 1000 实现截图 | 直接视觉核对 |
|---|---|
| [创建页](implementation-f79-creation-reference-guidance-1440.png) | “先保存项目，再上传历史／参考募集书并填写原稿信息。”完整可见；不再承诺无稿首稿。已填发行人、市场、方式和报告期均可见 |
| [项目与空参考稿](implementation-f79-project-context-empty-reference-1440.png) | 顶部为“当前项目”；0 份材料、必填原稿、文件格式和空态指引一致 |
| [保存并采用后](implementation-f79-saved-adopted-reference-1440.png) | “本次更新已选用”和“已保存 1 份材料”同时可见；没有“正在处理／已恢复”歧义。图中两项残余文案保留当时状态，修正结果见上面的 76b 最终验收 |
| [材料行与原稿信息](implementation-f79-source-material-row-1440.png) | “在上方募集书版本卡管理”真实显示；下方原稿信息与采用文件相对应，位于财务材料之前；“已保存 1 份材料”可见 |

四图没有出现文字重叠、目标提示被遮挡或不可辨认的按钮。创建页的提交按钮位于视口下方，不因未在本图中出现就推断缺失；同一次既有测试已经通过按钮创建项目。

复用的非模型用例为 `local-prelaunch-source-correction.spec.ts`。原始证据在 `.local/local-prelaunch/bad-cases/final-f79-ui-2026-11-09T02-16-28-671Z-fb2a3759/user-corrects-valid-but-mistaken-source-declarations-reload-immutable-in/`。已直接复核审计：

- `finalized:true`、`status:passed`、`errors:[]`、`pageErrors:[]`，最终存在 `final-database`，不使用运行中的临时 `passed` 字段判断完成。
- 最终数据库：`runs=0`、`creditEvents=0`、`reservations=0`、`modelCalls=0`、`remaining=0`、`frozen=0`；保存 1 份材料、2 份不可变输入。该用例未执行模型任务、未充值或扣款。
- 错误但格式有效的原稿声明纠正后，重新加载仍保留正确选择；旧不可变输入保留，新的报价不复用错误输入。旧输入／报价混用的提交被拒绝。
- 同轮可读取的空白发行人与无效金额两个场景也均为 `finalized:true`、`passed`、错误数组为空，最终无任务／账务／模型写入。本 UI 记录不代替完整测试报告的计数。

| f79 实现文件 | SHA-256 |
|---|---|
| `implementation-f79-creation-reference-guidance-1440.png` | `475e5e0a968fc0f004178bf8437cdf0f46f0f09fc4a0f9f4ca33f6a64e2a052f` |
| `implementation-f79-project-context-empty-reference-1440.png` | `545657bc6a66c71ae478da655b5b77d830bc6aa0f04fb267a58caaae189d5348` |
| `implementation-f79-saved-adopted-reference-1440.png` | `d1bccac1049bb32bd3c0d0d49e59807051e678a70fc293cced08309a0509736f` |
| `implementation-f79-source-material-row-1440.png` | `da86eed074082c7ae4eadd6b277120fd84a15a9b2b8de87341e5773181556721` |

## 历史 fc76 同尺寸原型与实现

| 状态 | 原型 1440 × 1000 | 实现 1440 × 1000 |
|---|---|---|
| 尚未上传参考稿 | [原型](prototype-reference-empty-1440.png) | [实现](implementation-reference-empty-1440.png) |
| 已上传并采用参考稿 | [原型](prototype-reference-saved-1440.png) | [实现](implementation-reference-adopted-1440.png) |
| 失败后的恢复入口 | [原型](prototype-word-failed-1440.png) | [实现](implementation-unreadable-source-1440.png) |

已完成的逐屏核对：

- 空态：必填标题、Word（.docx）限制、每次一份、100 MB 上限、选择后自动保存并采用、空态操作指引均与原型一致。底部开始按钮不可用，并明确要求上传采用及填写原稿信息；没有额外“确认上传／采用”步骤。
- 采用后：文件名、采用标记、DOCX／版本／时间、版本详情、下载原文件及删除均可见且无截断。绿色选中卡与“本次更新已选用”一致；材料数从 0 变为 1。
- 坏文件失败：显示“本轮未完成”，错误提示明确材料无法读取、点击“继续修改”后检查并上传可读副本；原任务与已保存材料保留。预留已释放 8,864 积分，与独立账务检查一致；“继续修改”和“查看材料”均在截图中可见。未将失败任务错误标记为完成或要求用户先停止任务。
- 实现放在完整工作区中，保留已有导航、步骤、项目标题、材料区和底部操作栏。原型是独立组件页；可用宽度接近，组件内容／操作顺序一致，不要求整页的顶部坐标相同。
- 这两张历史参考稿截图停留在材料页，未覆盖创建页文案和下方材料行的“在上方募集书版本卡管理”；直接视觉证据由上面的 f79 补充，不倒填到旧截图中。

原始证据均在 `.local/local-prelaunch/bad-cases/` 下，审计标记为 `synthetic:true`、`apiMocked:false`、入口 `http://localhost:18087`：

- 两张参考稿图来自 `final-fc76-model-2026-11-09T01-51-53-796Z-452ebab7/real-queued-authoring-survives-browser-refresh-and-delivers-source-based/`，截图发生在模型运行前。该用例随后审计为 `passed`，页面异常为空。
- 正式坏稿图来自 `final-fc76-cursor-fixed-2026-11-09T01-58-34-524Z-862814ad/corrupt-adopted-DOCX-releases-credits-without-model-use-then-corrected-s/`。截图发生于真实坏稿任务失败、开始纠正前；当时 worker 尝试一次、模型调用为 0、积分预留已释放、重复提交没有再扣费。
- 第一轮的坏稿用例保留了红证据：脚本错误假设任务事件 `next_cursor` 末页为 `null`，实际接口返回最后 seq，空页保持该游标。修正为核对终态 seq 并读取空尾页后，第二轮才到达正式截图点；没有改变 API 或绕过账务断言。
- 第二轮审计记录 `status:passed`、`errors:[]`、`pageErrors:[]`，并包含 `corrected-source-new-round-old-failure-preserved` 与 `final-database`：短合成稿替换可读原稿、独立下一轮、真实交付与唯一结算的整例已完成。该结论来自完整测试审计，不能仅由失败时点的截图得出；不代表完整长文或真实客户样本通过。

| 实现文件 | SHA-256 |
|---|---|
| `implementation-reference-empty-1440.png` | `8be4c195d3e281729f15bb4abea5656228d56fc21e88ed369d9ab6d8f924544a` |
| `implementation-reference-adopted-1440.png` | `70df8e7f5773b86debf8ad2975c3e0f83c74b81102f74068e6f31a2cc2b8a25e` |
| `implementation-unreadable-source-1440.png` | `76c752c179686ec3d00f6e8bb7d078965ddc79e45b3478661af018f50ab7c9d5` |

原型没有“不可读材料”的独立示例状态。失败原型仅用于对照现有失败面板和“继续修改／查看材料”入口；它的 Word 保存失败文案不是坏材料文案，本记录不宣称两者逐字一致。历史原型中的计费说明不能覆盖当前成果计费规则。

实现截图复用 `apps/web/tests/local-prelaunch-generation.spec.ts` 的既有合成测试流程，保持 `test.use({viewport:{width:1440,height:1000}})`：正常用例在打开新项目后保存 `reference-empty-1440.png`，上传并填写原稿信息后保存 `reference-adopted-1440.png`；坏原稿用例在现有失败断言后保存 `unreadable-source-actionable-1440.png`。每次先滚动到所核区域，均为未缩放的视口截图；原有 `unreadable-source-actionable.png` 长页面证据仍保留。截图点不改变测试断言、模型输入或账务操作。

f79 与 76b 文案复核沿用非模型 `local-prelaunch-source-correction.spec.ts` 的四个截图点。只滚动页面、必要时展开已有材料详情并截图，不新增写请求或改变断言；strict TypeScript 检查通过，两版各四图已由实际执行产生并完成目视检查。

## 已修正的额外文案

fc76 截图暴露的两处既有文案歧义，已在 f79 实际页面复核修正：

- 新文件上传采用后，材料区从“已恢复 1 份材料”改为中性的“已保存 1 份材料”。
- 尚未提交任务时，顶部项目上下文从“正在处理”改为“当前项目”。

旧 fc76 图继续展示修正前文案；新 f79 图单独记录修正结果。

## 残余文案修正与验收边界

- f79 保存采用图中，未创建任务（`runs=0`）的原稿仍显示“已被任务或关联文件使用，保留依据”。API 的 `used` 原因也包括不可变输入引用；76b 已将两处提示统一改为“已作为编制依据保留”，最终截图已核实。
- f79 图中的“继续上次提交”已在 76b 改为“用已保存内容开始更新”，最终截图已核实。进一步源码核对确认按钮选择输入后实际调用 `start()`，因此此前建议只描述为“使用已保存输入”等准备操作不准确，以本次明确启动的措辞为准；原恢复及防重复逻辑未改动。
- 两项残余文案在 76b 均已修正；历史 f79 图继续保留旧提示。后续发现的双入口及旧输入恢复问题另列上节，本地修复尚待新镜像复验。
- 短合成原稿失败后替换文件、独立下一轮、成功下载与唯一结算已有真实 worker 测试审计；截图不代替这些断言。
- 新的完整 synthetic 长文与真实客户 sample 仍为待完成事项；本记录不报告它们的成功或内容质量结论。
- 本记录不代表线上发布、真实商户支付接入、完整文件内容正确性或行业专业签认。
