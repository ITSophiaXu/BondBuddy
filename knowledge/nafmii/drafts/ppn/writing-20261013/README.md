# 20261013 PPN 模板接入交接

用户于2026年10月14日指定本文件夹对应的Word模板及批注，用于目标品种PPN的募集说明书更新。本次属于写作框架接入，关联 #26；不关闭该Issue其余法规效力及真实项目验收事项。

## 资产与来源

- 版本：`ppn-writing-2026.10.13-v1`。
- 来源：`20261013-PPN债务融资工具定向募集说明书.docx`，678927字节；SHA-256 `91c22882815f78bf1d9fb1dc9cf14a488bd505bbe6690eb1de20e52ebf513944`。
- 读取范围：正文5668段（含空段和表格单元格）、90张表、108条批注。97条是只有 `commentReference` 的单点批注，11条含范围；全部有正文定位。没有检测到插入／删除修订。段号为原XML顺序，不是Word页码。
- `method.md` 为可审阅的章节及更新方法；`curated-source.json` 保留108条批注全文、锚点、标准条文、改写标记及90张表的字段结构；`writing-framework.md` 是两者生成的完整运行知识，无外部链接依赖。
- 原件和完整含示例的抽取结果只保留本地阅读证据。提交内容移除了源企业及联系人实例，财务表保留科目行与字段而非源企业数值；行业参考表单独标明来源／期间未知，不能作为已核本期比较基准。原件未修改，未作为模板Word交付或进行页面排版验收。

## 运行接线

`apps/api/src/unified-authoring.ts` 仅为目标 `nafmii/ppn` 的编制任务追加本包Markdown，沿用现有内容及SHA-256锁定。源稿品种不决定目标知识。M3复核通过同一加载器的review用途参数保留原有知识，不追加此写作模板。worker按输入快照将完整内容写入只读知识文件，配合 `python/bondbuddy_file_authoring/task.md` 的PPN指令使用。旧任务继续使用已固定的知识字节，局部续改遵守实际授权范围。

新模板将定向信息披露、持有人会议、受托管理、投资者保护、主动债务管理依次放在第九至十三章。旧 `chapter-template.json` 的DM表号及研究法规资产保持原义；运行时的新写作结构优先。已有 `build_nafmii_knowledge.py` 不覆盖本子目录，标准Dockerfile已复制整个NAFMII drafts目录，无需改变部署脚本。

源文存在章节交叉引用、编号跳号、风险分母、缺来源行业均值及C21自主条款歧义，逐项处理记录见 `method.md`。模板默认条款不覆盖本期已有权利，不将“无受托人”“无评级”“已批准”“无重大事项”当作已核事实。

## 重建与检查

```text
python scripts/build_ppn_writing_framework.py
python scripts/build_ppn_writing_framework.py --check
python scripts/test_ppn_writing_framework.py
```

持有原件时追加 `--source <原件路径> --check` 验证原始哈希、全部批注及可复用内容与提交资产一致；不写文件。需要检查完整本地正文时使用 `python scripts/ppn_template_source.py <原件路径> --out <本地证据JSON>`。完整抽取包含源企业实例，应保留在Git外。

## 验证与状态

2026年10月14日本地验证通过：

- `scripts/test_ppn_writing_framework.py`：3/3，覆盖单点／跨段表格范围批注、全部锚点与重建、去除示例及指标口径。
- `scripts/build_ppn_writing_framework.py --source <原件> --check`：与指定原Word逐条一致，运行Markdown SHA-256为 `6e67dfe2b4da4ebbca802e79e959af0f83ee65b9230dfa19c8a3740355c757b3`。生成器及Git属性固定LF，Windows和Linux使用相同字节。
- contracts、domain、rule-pack-registry、rule-applicability-context、API及worker TypeScript编译通过。
- API `unified-authoring.test.js`：6/6，覆盖全部11种目标、PPN完整知识固定、源稿品种不影响目标选择及M3复核知识隔离。
- worker `ppn-writing-workspace.test.js`、`file-authoring-delivery.test.js`、`unified-input.test.js`：5/5。真实workspace准备将完整知识写入文件，篡改锁定内容会拒绝；模型阶段用合成回调，不调用供应商。
- domain `nafmii-knowledge.test.js`：8/8；`check_nafmii_knowledge.py` 核对79项收件、72份原件、7份官方快照、7194条研究记录及18条未启用规则通过。
- contracts：171+12个示例、4个生命周期示例；OCR及主体绑定相关回归40/40通过。
- `git diff --check`通过。没有前端变更，不新增原型或浏览器验收。

无数据库迁移、依赖或前端变化；无需用户重新上传PPN写作模板。后续统一发布需同时纳入API知识文件和worker任务指令。完整PPN实际生成及用户验收由本地集成测试流程继续验证，本次未调用真实模型、未创建生产任务、未部署。

交付状态：开发和自测完成；代码完成，尚未部署，待统一发布。未将模板读取或自动化检查等同于用户验收。
