# M3 Word 客户端兼容性检查

2026-10-02 在本机实际 Microsoft Word 中，对六份 synthetic 文档完成打开、另存、关闭、重新打开和 PDF 导出，6/6 成功。报告可读性和空标题修复后，最终报告再定向往返 1/1 通过。批注正文、作者/日期、锚点、修订记录及表格内容保留。此证据覆盖当前版本的 Windows Word；WPS 未检测到，不能记为通过，也不能据此完成全部 Word/WPS 支持矩阵。

## 环境与操作边界

- Windows；Microsoft 365 Apps for enterprise，WINWORD.EXE 文件版本 **16.0.20430.20118**，COM `Version=16.0`、`Build=16.0.20430`。
- Word 路径：`C:\Program Files\Microsoft Office\Root\Office16\WINWORD.EXE`。
- Word.Application 已注册。KWPS.Application、WPS.Application 未注册；应用路径、卸载项及常见 Kingsoft 安装路径均未检测到 WPS。
- 只使用 `New-Object -ComObject Word.Application` 建立独立隐藏实例；启动前和结束后均无 WINWORD 进程。未使用 GetActiveObject，未连接用户已有文档。
- 文件均由仓库 Python 测试夹具生成。输入位置固定在任务的 `.local/m3-word-client-2026-10-02/fixtures`，按 manifest SHA-256 校验，只将副本写入其 `word-roundtrip` 子目录；原始六份字节均未变化。
- 禁用该实例的宏执行，不加入最近文件，不启用 OpenAndRepair；只保存测试副本。批注/修订显示设置仅作用于只读打开的副本文档，关闭时不保存。未安装客户端、改用户模板或改 Word 全局选项。
- 第一次沙盒内创建 COM 返回 `0x80070520`；经正常自动审批在沙盒外运行后可创建 Word。第一次 COM 可选参数绑定失败，经改用显式参数后，正式六例全部成功。失败探测不计为兼容通过。

## 样例与结果

来自 `python/tests/test_review_word.py` 与 `python/tests/test_word_delivery.py` 的夹具，实际调用 `bondbuddy_word_delivery.review` 和 `writer`；未用人工拼接的 Word 输出替代生成器。

| synthetic 样例 | 验证重点 | Word 批注数 前/后 | Word 修订数 前/后 | 结果 |
|---|---|---:|---:|---|
| native-comments.docx | 正文 100 万元、表格 90 万元两处精确批注 | 2/2 | 0/0 | 保留文本、两处范围及粗体 |
| existing-comments.docx | 已有批注加同一位置的两条新批注 | 3/3 | 0/0 | 三条批注及范围保留 |
| comments-existing-revision.docx | 已有插入修订内添加原生批注 | 1/1 | 1/1 | 既有作者与插入内容保留 |
| tracked-revision.docx | 100→120、插入期间列、待核说明批注 | 1/1 | 6/6 | 修订、表格和批注保留 |
| clean-revision.docx | 对应清洁版和待核批注 | 1/1 | 0/0 | 无修订节点；批注仍保留 |
| review-report.docx | 可编辑问题报告 | 0/0 | 0/0 | 打开、保存、重开、正文保留 |

每份均为 1 页，打开/另存/重开/PDF 导出均成功；没有尝试接受或拒绝修订。`tracked-revision` 的 Word COM 计数为 6 个修订对象，OOXML 有 7 个 `ins/del/cellIns` 节点，两种计数粒度不同；前后各自保持一致，未以节点数充当用户界面计数。

## 结构对比与观察到的差异

比较不要求 ZIP 字节一致：Word 会改包元数据及元素序列化。按语义检查正文段落、物理表格列数/单元格文本、每条批注内容/作者/日期、所在段落定位与字符范围、原生 comments relationship/content type，以及插入/删除/单元格插入的类型/内容/作者/日期。批注 ID 可被 Word 重编号，因此以内容和范围核对。

- 六例的批注、修订、关系和 content type 检查全部通过。
- 既有修订批注稿与问题报告的正文签名完全相同。
- 其余四例原本以表格结束；Word 保存时只在末尾表格后增加 **一个空段落**。前后所有原段落文本和物理表格结构一致。对比程序只接受“原稿以表格结束，保存稿以该表格加一个空段落结束，段落列表恰好多一个空串，表格签名一致”这一特定差异，仍记录 `body_exact:false`，不吞掉其他变化。
- 六份源文件 SHA-256 与生成 manifest 一致，没有回写源稿。

原始结果：[COM 打开保存记录](m3-word-client-evidence/word-com-results.json)、[OOXML 前后对比](m3-word-client-evidence/ooxml-comparison.json)、[源文件 SHA-256](m3-word-client-evidence/manifest.json)。正式 COM 完成时间为 `2026-10-02T11:28:58.4202125Z`。

## 视觉检查

documents 技能的 `render_docx.py` 在当前依赖包中因缺少 `soffice.exe` 失败；未调用或安装用户桌面 LibreOffice。改用本次被测 Word 自身 `ExportAsFixedFormat` 生成 PDF，再用 bundled Poppler 渲染 PNG。

逐页查看六份普通视图及三份带标记视图：正文、中文、金额和表格无裁切或缺字；批注连线指向 100 万元及表格中的 90 万元；重叠位置保留三条批注；修订稿显示 100 删除、120 插入、新增期间列和待核说明批注。普通 PDF 未显示批注不被当成批注丢失。

- [正文和表格原生批注](m3-word-client-evidence/native-comments-markup.png)
- [原生修订和新增列](m3-word-client-evidence/tracked-revision-markup.png)

初次问题报告直接显示 source/scope/locator JSON 及 `error/rechecked` 标签，已改为中文范围、来源、结论、段落及表格位置。无定位限制时不再生成空标题；未放置批注的原因保留为人类可读说明。相关 Python 定向测试 **7/7** 通过，包括无空节、可读定位及缺失位置/复杂修订边界/PDF 限制。

最终报告 Word 往返 **1/1**，保存前后均为 **1 页**、正文签名完全一致、源文件未改变。完成于 `2026-10-02T11:36:35.5468590Z`。已逐页确认没有先前单独占第二页的空标题：[最终报告渲染](m3-word-client-evidence/report-final.png)、[最终 COM 记录](m3-word-client-evidence/report-final-com.json)、[最终结构对比](m3-word-client-evidence/report-final-ooxml.json)、[最终源文件哈希](m3-word-client-evidence/report-final-manifest.json)。这些检查不替代业务结论验收。

## 复现

生成器来自协调工作区 `m3-runtime`，基于 `e25ce7b2b5ab5002f713325a9e59ddf65043a575` 加当时尚未提交的 M3 Python 文件。第一组六例由初版夹具生成，保留的 manifest/COM/OOXML 记录标识其准确输入；初次未在生成前采集 review.py 源码哈希，不将最终修复后的源码哈希倒推为初次版本。下表记录最终报告定稿及定向复测时的源码 SHA-256，生成器改动由协调分支提交：

| 文件 | SHA-256 |
|---|---|
| python/tests/test_review_word.py | `e3cbf5245a67e2388aa97d5216bdf577fb174ef582173a680b25b438925a7d7a` |
| python/tests/test_word_delivery.py | `84761f6f107408810dad6a0fd091d6fd252190720ac5a4ab52d7344902ea8905` |
| python/bondbuddy_word_delivery/review.py | `3162d2040d7537cf5222ceb20aa2f02d5640d77fc9380dd3db768c0be6556a01` |
| python/bondbuddy_word_delivery/writer.py | `8a26b332443296fb598fb9bb651338912e04bd0f2e1e54268c5c0e63f5770ac8` |

随记录保存生成、COM 往返、结构对比及带标记导出脚本，需在上述实际代码版本且已安装 Word 的 Windows 环境运行。Python 使用 Codex bundled runtime（含 python-docx/lxml），脚本只依赖仓库测试夹具；第二个参数为测试输出目录。示例：

```powershell
$runtimePython=$env:BONDBUDDY_TEST_PYTHON # 已配置、含 python-docx/lxml 的 Python 可执行文件
$repo=(Get-Location).Path # 在仓库根目录执行
$fixtures='.local\m3-word-client-2026-10-02\fixtures'
& $runtimePython -B docs/acceptance/m3-word-client-evidence/prepare.py $repo $fixtures
& docs/acceptance/m3-word-client-evidence/roundtrip.ps1 -FixtureRoot $fixtures
& $runtimePython -B docs/acceptance/m3-word-client-evidence/compare.py $repo $fixtures
& docs/acceptance/m3-word-client-evidence/export-markup.ps1 -FixtureRoot $fixtures
```

仅复测最终报告可将 `prepare.py` 改为 `prepare-readable-report.py` 并使用新的测试目录，然后运行相同的 `roundtrip.ps1` / `compare.py`。不会访问其他目录内的文件；新 manifest 的 SHA-256 用于新一次试验，不能覆盖本记录原始证据。

## 尚未覆盖

WPS、macOS Word、网页版 Word、其他桌面版本尚无本次证据；真实长文档、复杂节/域/目录/合并表格的排版和业务结论需在最终统一验收中单独覆盖。此处是**真实 Word 客户端 + synthetic 数据**，不是行业签认、真实模型/业务成果验收或部署验收。未将未安装的 WPS、未执行的交互按钮测试记为通过。
