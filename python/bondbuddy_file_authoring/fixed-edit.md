# 保留原稿格式的编辑接口

仅当 input.json 含 format_tools 时使用本接口。先读 input.json、相关知识和原稿。事实编制、修改范围与批注文案继续遵守 task.md。

固定工具每次从锁定原稿及操作日志重放。模型只提交文字与位置数据；worker 用固定程序生成正式修订版和清洁版。不要通过任意 Word 脚本替代操作日志。

## 读取位置

```sh
/opt/venv/bin/python -B -m bondbuddy_file_authoring.fixed_edit inspect --input input.json --operations output/operations.json --offset 0 --limit 40
```

首次没有 operations.json 是正常状态。inspect 分页返回 node_id、kind、text、属性和 limitations；通过 --node 指定一个位置可取完整原文。template-manifest.json 保存整体结构、标题候选、样式链及 property_formats 属性字典。清单中的 *_ref 字段引用该字典；text_truncated=true 的原文必须用 inspect 读取完整内容。

原节点 ID 绑定原稿部件、原始序号和原文指纹，新增段落或行后仍然可用。不要自己拼原节点 ID。before 必须等于该节点当前完整 text，不能只写拟替换的词句。重新 inspect 能看到已应用操作之后的文字。

## 提交操作

将同章、同表的相关操作组成数组写入 scratch/operation.json；单项修改也可直接写一个操作对象，再执行：

```sh
/opt/venv/bin/python -B -m bondbuddy_file_authoring.fixed_edit apply --input input.json --operations output/operations.json --operation-file scratch/operation.json
```

apply 自动创建并绑定操作日志，无需手写日志外壳。成功后原子追加；失败不追加。操作数组按顺序执行，整批通过才保存；同批后续操作的 before 应对应前序操作之后的文字。每个 id 在本轮唯一，只能使用英文字母、数字、下划线、连字符，最多80字符。reason 可记录简短修改依据，不把回查过程塞进正文。

每次 inspect/apply 都会重新读取锁定原稿并重放累计日志，耗时随原稿大小和已保存操作增加。优先按同章、同表合批提交，跨章继续分批，不必每个字段单独调用。inspect 按需读取相关位置或分页，避免每项修改后重新展开整份文档；该性能边界不改变全文更新与依据核对要求。

同一事实在表格、正文、释义和指标注释中分别有自己的节点；修改表格不会自动同步其他位置。按 task.md 的本期事实与位置记录，把有关联的节点一并处理，包括期间定义、正文序列末项、金额与占比、公式口径及依赖这些数据的定性结论。分批保存后用 inspect 读取这些节点的当前完整文字，确认实际重放结果已经同步；不能仅检查操作数量、成功返回或修改前的原文。遗漏的普通文字继续用 replace_text 或 replace_cell_text 保存；只有工具实际返回限制或事实依据确实不足时，才记录具体未完成事项。不得将未尝试的漏项归为工具限制。

普通段落替换：

```json
{"id":"p_update_1","kind":"replace_text","node_id":"从inspect复制","before":"截至2024年末，净资产为100万元。","after":"截至2025年末，净资产为120万元。","reason":"根据本项目本期财务材料更新。"}
```

单元格替换（node_id 为 cell）：

```json
{"id":"cell_update_1","kind":"replace_cell_text","node_id":"从inspect复制","before":"100","after":"120"}
```

多段落单元格的 after 使用字符串数组，数组长度须与原单元格段落数一致；before 仍是 inspect 返回的完整 text。例如 after=["120","本期口径说明"]。新增段落使用 insert_paragraph；当前没有删除段落或表行的结构接口，不把多个段落压成一段。replace_text 可删除段内文字，但保留该段落。

新增同级段落：

```json
{"id":"new_p_1","kind":"insert_paragraph","node_id":"插入位置段落ID","before":"插入位置段落的完整原文","position":"after","style_node_id":"同级样式来源段落ID","text":"有材料依据的新披露内容。","reason":"补充本期所需披露。"}
```

position 可为 before 或 after，默认 after。style_node_id 默认插入位置段落；要新增标题时明确选择同级标题的样式来源，不选择正文。新增节点 ID 为 op:new_p_1:paragraph，可继续 inspect 或修改。

新增普通表行：

```json
{"id":"new_row_1","kind":"insert_row","node_id":"来源表行ID","before":"inspect返回的行内完整文字","position":"after","values":["负债","50"],"reason":"补充已核对的项目行。"}
```

values 与物理单元格一一对应。多段落单元格对应项使用数组，例如 values=[["项目名称","项目说明"],"50"]。逐段继承原有样式；段落数量必须匹配。新增行 ID 为 op:new_row_1:row，单元格为 op:new_row_1:cell:0（从0开始），第一段为 op:new_row_1:cell:0:paragraph，第二段为 op:new_row_1:cell:0:paragraph:1。

新增财务期间列（普通矩形表）：

```json
{"id":"half_year_2026","kind":"insert_column","node_id":"inspect返回的table节点ID","before":"该表当前完整text","column_index":1,"position":"before","values":["2026年6月末","120","50"],"reason":"根据本发行人最新报表新增一期，保留历史比较列。"}
```

node_id为整张表的节点，before为该表当前完整text。column_index从0开始，指定沿用样式的原列；position为before或after，默认before。在常见“项目、2025年、2024年”三列表中，column_index=1、position=before会得到“项目、2026年半年、2025年、2024年”。values必须覆盖该表每一行，含表头；多段落单元格使用逐段字符串数组，数量与样式来源单元格一致。新列逐行继承相邻列的单元格、段落及文字样式，不复制旧数据；各列按原宽度比例分配，并保持原表总宽度，避免增列导致超出页面。增列不等于重排目录或重建表格。

新增节点为op:half_year_2026:cell:0（行序号从0开始），段落为op:half_year_2026:cell:0:paragraph，第二段为op:half_year_2026:cell:0:paragraph:1。原节点ID保持有效，可继续改写新增单元格、插入表行或挂接批注。增列的真实修订包括cellIns、tblGridChange及原单元格宽度变更；接受修订得到新列，拒绝本轮修订恢复原表和宽度。

合并单元格、嵌套表、旧修订、域／嵌入对象或无法可靠确定列宽的表暂不支持增列，返回WORD_EDIT_*_UNSUPPORTED；须逐表记录实际限制，继续处理支持的表，不能以一张复杂表为由跳过全部财务更新。

追加批注（正文或表格内段落）：

```json
{"id":"comment_1","kind":"add_comment","node_id":"原段落或新增段落ID","before":"该段落的当前完整文字","text":"请核对本期净资产采用的合并范围。"}
```

批注第一句直接说明需处理的问题。保留已有批注，不复制原模板批注全文。页眉页脚批注暂不支持；可在相关正文位置说明问题并记录原位置。

## 没有修改与局部缺项

确实不需要本轮修改时执行：

```sh
/opt/venv/bin/python -B -m bondbuddy_file_authoring.fixed_edit no_changes --input input.json --operations output/operations.json --reason "说明已核对的范围以及为何无需改动"
```

工具保存 no_changes_reason，不伪造本轮修订。已有实质修改时不能使用此命令。tracked 保留原有修订；clean 接受包括原有修订在内的全部受支持修订，不能称为只接受本轮修订。

如工具返回 WORD_EDIT_*_UNSUPPORTED，读取具体位置和能力限制，继续处理其他支持的更新。将错误码、node_id、命令、尝试过程及技术原因保留在 scratch/工作记录.md。output/delivery.md 按 task.md 的“面向用户的交付说明”约定，只说明受影响的实际章节或表格、未完成的结构变化及其用户影响、已知原因和需人工处理的事项，不照搬内部路径、哈希、工具命令或能力清单，也不把处理限制写成用户缺材料；有适用正文位置时用 add_comment 挂接待处理事项。不要用 no_changes 跳过应完成的更新，不宣称不支持的改动已经完成。

当前支持普通矩形表增列；尚不支持修改合并关系、整章移动、域结果编辑及与旧修订重叠的文字修改。普通多段落单元格、表行及新增列可以逐段处理。正文增长引起的自然分页不是格式错误。

## 全文出现位置与实际重放核对

跨期更新先按 task.md 从完整原稿建立财务表格、摘要及正文／附注叙述的出现位置清单，使用 inspect 返回的稳定 node_id 和章节上下文。清单必须包含未修改位置和同一事实的每次重复披露；不能把已提交操作、已核对主表或单元格数量当作全文覆盖。原稿的“报告期内”“最近两年及一期”等文字要结合实际释义、章节期间说明及主体口径判断，逐项区分本期更新和历史比较期保留。

每个位置在工作记录中对应原材料 hash／定位、主体及合并／母公司口径、指标、时点／累计期间、单位、金额、比例和计算依据，以及输出 node_id 与处理状态。普通表格和叙述要交叉核对，不能因主表已改而跳过盈利、现金流或其他分析文字；不对全文作无上下文的数值替换，不为凑一致性重写原章或删减历史比较值。

更新偿债分析时，保留有依据的历史事实和解释并明确历史期间，补充本期分析与具体缺口，不机械保留过时乐观结论。更新现金流表时保留历史聚合行的标签范围；只有本期狭窄子项值时，不得把原聚合行改名为子项并沿用历史聚合金额，应保留聚合范围、按品种规则标明本期缺项并挂注待核，已知子项另明范围和期间。

同一当前主体信息、法定代表人、联系方式或备查信息的重复位置也逐项登记和核对。先区分当前信息、历史签字与明确时点的事件；没有变化依据时保留已知原值和原有时点，不把缺少新一期材料当作必须清空原字段。确需确认或材料冲突时，所有相关当前位置按 task.md 和目标品种规则一致处理并记录，不让一处待确认与另一处无提示的当前事实互相矛盾，不替换历史签字或事件。

完成后对清单逐位置重新 inspect，读取累计 operations 从锁定原稿实际重放后的文字和单元格，再核对来源、期间、口径、单位、金额、比例及各重复位置的一致性。检查原稿清单是否有未覆盖项、未保存修改或冲突；新增披露也纳入清单。操作日志合法、主表数值正确、工具执行成功及模型交付说明都不等于全文已核对。未解决位置按 task.md 处理并如实记录，不能以泛化“已核对”结论替代，不能宣称财务或人工验收通过。

## 按锁定来源行反向回查

有财务 XLSX 时，结束前按 task.md 运行 `bondbuddy_file_authoring.reverse_audit`，按 source_groups.occurrence_ids 读取 occurrences 的完整实际文稿及 source_contexts 的来源表头，逐组回查其待核列表。辅助程序从锁定原件缓存取值，重放累计 operations，列出 changed=false 的原段、表行、页眉页脚和身份字段。逐处回查真实来源、时点、口径及单位，不能把报告运行成功或默认 retained 当作核对。修改日志后重跑；身份冲突先读取已挂接批注，不强行替换历史签字或有待确认的姓名。程序永远不输出金融 passed，独立发布验收仍必须执行。

review_queue 将尚未修改且带有关期间和数值的正文突出为待核候选，包括未匹配来源的正文；不给 expected/actual 定论。优先逐项读取它及对应 source_groups、source_contexts 缓存，明确本期／历史期间；有批注或未改都不等于已核。队列处理后仍回查全部适用来源行和出现位置。

## 提交前累计质量预检

```sh
/opt/venv/bin/python -B -m bondbuddy_file_authoring.fixed_edit preflight --input input.json --operations output/operations.json --report scratch/word-quality-preflight.json
```

operations 必须是当前已保存的完整日志，报告路径只允许 scratch 下的 JSON 普通文件。工具在独占临时区重放临时双稿，直接调用宿主同一 `quality.verify`，不修改锁定输入、材料、日志或 output 正式文件。报告绑定 input／底稿／operations hash，标为 model_preflight_diagnostic_only；host_acceptance、delivery_registered 和 release_authorized 均为 false。自写报告不会被用作检查输入或宿主批准。

失败退出码为1，stdout 给报告路径和问题摘要，stderr 标为 WORD_PREFLIGHT_REJECTED。读取报告 quality_report 和 diagnostics：失败章节含标题、原文／当前有效段落零基位置、稳定 inspect node_id 和 operation_ids；标题变更含 recognition。正文诊断有界，text_truncated／truncated 为 true 时使用 inspect --node 读取完整当前文，不带 operations 的 inspect 只作底稿对照。缺日志、哈希冲突、不安全路径或检查不可用不能通过。

本次工具的简短 stdout 若给出 `host_handoff.action=defer_page_rendering_to_host`，表示 `snapshot_current=true` 且当前精确操作版本仅有 `WORD_PAGE_COUNT_UNAVAILABLE` 渲染基础设施失败，可以把页数渲染延后到 worker。`authoring_completion=not_verified` 仅表示预检工具不判断业务编制完成度，不新增人工确认或资料齐备门槛。此指引不能证明原任务已完成，也不能跳过剩余材料阅读、章节和事实更新、来源回查及其他待办；继续按原任务和既定局部缺项可出工作稿政策完成本轮编制。之后对最终 `output/operations.json` 重新完成来源回查及预检；若最终日志仍只有该环境失败，保留 `status=failed`、退出码1和原始失败报告，完成诚实的 `output/delivery.md`，用 `bb_continuation.checkpoint` 保存 `phase=prepare_download`、当前实际待核事项及“结束本次模型执行，交宿主验收”的下一步，然后正常结束本次模型执行；不等待沙箱页数预检转为通过。worker 在模型沙箱外从锁定原稿和同一最终操作日志独立重建、真实渲染并执行全部质量验收。不要只为渲染环境错误反复改正文、重跑相同预检或尝试放宽沙箱；指引和模型结束均不表示编制、预检或交付已通过。指引只绑定其 `operations_sha256` 及报告里的输入／底稿 hash；中途修改日志后不能复用旧报告，必须重新回查及预检。没有该指引、存在混合／其他质量失败或快照已变时，仍修复对应问题，不能自行把错误归为环境问题。worker 的正文及实际页数70%门禁、失败处置和已有有界基础设施重试不变；渲染基础设施故障不会额外调用模型改稿。

模板检查保留章节编号、层级、顺序及字体、段落和表格格式，允许按目标主体、品种和事实依据更新标题文案、替换或精简正文。全文／分节相似度和逐章字数比例仅作诊断；整篇长稿另有篇幅下限；不要为提高保留率补回旧主体事实或旧市场条款。整节正文或整表被清空、章节缺失及格式破坏仍会失败。按 task.md 核对事实适用性及期间，缺本期材料局部挂注或按品种规则缺项。更新日志后重跑来源回查与预检，再结束执行。预检通过只适用于报告绑定的日志，不能声称财务／视觉／人工验收通过；宿主仍在执行结束后独立重建并检查。

整篇长稿还执行独立的篇幅门禁：正文总字符数低于原稿70%即拒绝；原稿至少50页时，实际渲染页数低于70%且减少至少20页也拒绝。读取 quality_report.document_size_check 核对指标；原文相似度及逐章字数比例不恢复为门槛。渲染缺失或失败不能记为页数已通过，只有上述精确交接指引可将当前操作交给 worker 继续真实验收；不要以缓存页数、修订稿旧文、扩大字体或空白填充规避检查。已有失败可能跳过渲染以避免重复开销，仍保持失败。

## 完成编制

保留 output/operations.json，按 task.md 的“面向用户的交付说明”约定写好 output/delivery.md，准确说明实际修改、局部缺项、未完成事项的用户影响和未执行的视觉检查；内部执行证据留在私有工作记录，不向用户复述操作过程。worker 从锁定原稿重放操作并生成正式文件，再独立检查双稿、内容保留、目录和格式，通过后才能发布成功成果。跨期更新仅写批注、no_changes 或替换日期不能证明本期数据已更新。必要的新增列当前不支持时，必须如实记录未完成，不能覆盖应保留的历史比较数据。质量检查不代表财务事实、法规或 Word/WPS 专业验收。

报告期定义另列 period_definition_occurrences，覆盖释义表行及独立段落，不因没有财务行标签或已修改而略过。review_queue 的来源组为空仍必须查原件；保守词面别名仅是 ambiguous_needs_review 候选，原标签及主体／范围限定始终保留，不能借别名自动选择财务事实。


共享质量检查器还将锁定的完整 target.details.target_reporting_periods 与明确当前募集说明书释义中的报告期定义比较。仅对能确定绑定且可完整解析的日历年度／累计季度期间进行检查；确定矛盾报告 WORD_REPORTING_PERIOD_DEFINITION_CONFLICT，模型预检和模型结束后宿主检查执行同一规则。修复实际释义及对应正文后重跑预检。不能把历史比较句中的六月日期统一改成新期间，也不能用新增正确定义掩盖仍存在的冲突定义。输入缺项、期间口径冲突或不可解析的释义保持 needs_review，不代表金融事实通过。
