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

如工具返回 WORD_EDIT_*_UNSUPPORTED，读取具体位置和能力限制，继续处理其他支持的更新。将未完成的结构变化及原因记录到 scratch/工作记录.md 和 output/delivery.md；有适用正文位置时用 add_comment 挂接待处理事项。不要用 no_changes 跳过应完成的更新，不宣称不支持的改动已经完成。

当前尚不支持新增列、修改合并关系、整章移动、域结果编辑及与旧修订重叠的文字修改；普通多段落单元格和表行可以逐段处理。正文增长引起的自然分页不是格式错误。

## 全文出现位置与实际重放核对

跨期更新先按 task.md 从完整原稿建立财务表格、摘要及正文／附注叙述的出现位置清单，使用 inspect 返回的稳定 node_id 和章节上下文。清单必须包含未修改位置和同一事实的每次重复披露；不能把已提交操作、已核对主表或单元格数量当作全文覆盖。原稿的“报告期内”“最近两年及一期”等文字要结合实际释义、章节期间说明及主体口径判断，逐项区分本期更新和历史比较期保留。

每个位置在工作记录中对应原材料 hash／定位、主体及合并／母公司口径、指标、时点／累计期间、单位、金额、比例和计算依据，以及输出 node_id 与处理状态。普通表格和叙述要交叉核对，不能因主表已改而跳过盈利、现金流或其他分析文字；不对全文作无上下文的数值替换，不为凑一致性重写原章或删减历史比较值。

同一当前主体信息、法定代表人、联系方式或备查信息的重复位置也逐项登记和核对。先区分当前信息、历史签字与明确时点的事件；没有变化依据时保留已知原值和原有时点，不把缺少新一期材料当作必须清空原字段。确需确认或材料冲突时，所有相关当前位置按 task.md 和目标品种规则一致处理并记录，不让一处待确认与另一处无提示的当前事实互相矛盾，不替换历史签字或事件。

完成后对清单逐位置重新 inspect，读取累计 operations 从锁定原稿实际重放后的文字和单元格，再核对来源、期间、口径、单位、金额、比例及各重复位置的一致性。检查原稿清单是否有未覆盖项、未保存修改或冲突；新增披露也纳入清单。操作日志合法、主表数值正确、工具执行成功及模型交付说明都不等于全文已核对。未解决位置按 task.md 处理并如实记录，不能以泛化“已核对”结论替代，不能宣称财务或人工验收通过。

## 完成编制

保留 output/operations.json，写好 output/delivery.md，准确说明实际修改、局部缺项、未支持事项和未执行的视觉检查。worker 从锁定原稿重放操作并生成正式文件，再独立检查双稿、内容保留、目录和格式，通过后才能发布成功成果。跨期更新仅写批注、no_changes 或替换日期不能证明本期数据已更新。必要的新增列当前不支持时，必须如实记录未完成，不能覆盖应保留的历史比较数据。质量检查不代表财务事实、法规或 Word/WPS 专业验收。
