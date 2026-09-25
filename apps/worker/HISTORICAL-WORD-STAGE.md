# #34 历史 DOCX 修订交付首个切片

`historicalWordDeliveryStage()` 消费 #31 的完整 `historical-update-plan-v1`，并通过 `defaultRunStages({ word_delivery })` 安装在 worker。只支持当前 #31 已实现的有历史 DOCX、上交所普通私募切片；不将 `deliverable=false` 的模型计划本身标成成果。计划 hash、run 身份、input revision/hash、原件版本和 Blob 字节 SHA-256 必须一致，且至少有一项有依据的替换或插列，才调用 Python OOXML writer。

writer 从原上传文件的独立副本接受既有简单插入/删除修订，保留原件，并输出有效基线、**本轮原生 OOXML 修订版**和清洁版。三份 DOCX 各自进入已有 `promoteWordArtifact` 质量检查和 Blob 读回；只有三份全部可用，run 才进入 `succeeded`。writer 在产出时核对逐块有效原文、UTF-16 位置、表格物理网格和 #31 的清洁预览；内部接受本轮修订等于清洁版、拒绝本轮修订等于有效基线的正文/表格语义结构，不用整篇删除重插。

局部 `reviewNotes` 以 `【待人工确认】` 原生插入修订与普通批注保留在修订版，在清洁版保留正文标记和批注；`GET /api/v1/artifacts/{revision_id}` 的 `word_delivery` 摘要包含待确认内容、源文件 SHA-256、逻辑基线 hash、有效基线 DOCX SHA-256、计划 hash、writer 版本、三份成果 ID 及变更计数。清洁版与有效基线分别通过其 ID 获取短期授权下载，下载和重新获取不会调用模型。旧成功 run 的成果不因另一个 run 失败而改变。

原有普通批注及关系部件在未修改位置保留。若源批注锚在要编辑的段落，或旧修订归一化会删除已有批注锚点，writer 停止而不静默移位。复杂 inline 结构、旧版结构性修订、被编辑的合并表、超出交付限制的文档也停止；未修改的合并表保留。PDF/扫描重建、无历史稿新编、跨品种章节重排、复杂表和完整专业校验不属于这个切片，#34 保持开放。

## 验证与发布边界

- Python 合成回归覆盖原件不变、旧修订有效基线、正文替换、物理表格插列、现有普通批注保留、受影响批注拒绝错位、局部待确认及未编辑合并表；worker 组件测试覆盖计划 hash、身份和 pending notes 的失败关闭。
- 三份样本均需通过 `inspectDocx`；逐页渲染用于布局复核，不代替真实 Word/WPS 接受、拒绝、保存重开和往返操作。
- #146 负责目标 Windows WPS/Word build 的实机矩阵。未完成实机验收前，兼容状态为**未验证**；此切片不宣称 M1 发布可用。
- 当前 #19 生产规则 selector、#15 事实与发行人身份绑定仍阻止真实 run 穿过 `input_lock`；#31 记录的任丘九月大样本 parser 超时须由 #35 在 Linux 预发复测。不能用合成测试代替这些前置项。

本地命令：`PYTHONPATH=python python3 -m unittest python.tests.test_word_delivery -v`、`npm run build`、`node --test apps/worker/dist/historical-word-stage.test.js`。真实 DB/Blob/Word/WPS 证据见后续 #35/#146 验收记录。
