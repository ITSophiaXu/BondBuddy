# 审计 PDF 快速抽查验收（2026-11-18）

关联 #1606；基线 develop 53f911f46235cd70384d13898b95597ddd77830d，分支 perf/audit-pdf-quality-sampling。交付前对齐b7267630（新增内容仅为另一PR的Word表格操作，与本次文件无重叠）；本次已测实现及测试文件内容不变。

## 行为与边界

原版本虽不做 OCR，仍按页读取整份 PDF。v3 对长材料最多抽查8页：优先5/8/12页，再查首页、四分之一、中间、四分之三、末页；去重。8页以内检查实际页数。发现一页低清就结束，继续执行原“换清晰电子版才能继续”的前后端门禁。v2有效结果可复用，v1不放行。

原始像素/页面放置尺寸读取，不渲染、不解码图片、不提取全文、不调用模型。v3 sampled_pages记录实际页码；服务端和网页都校验页序及完成条件。超时、错误输出、缺失完成条件不能放行。检查本体软预算3秒、独立进程硬上限5秒；上传、hash、私有存储读取及排队仍有额外耗时。页面说明抽查页数，首次状态轮询1秒、后续最长3秒。

抽样必然可能漏掉未抽中的个别低清页。合成100页报告在第2页单独低清时不会被这套确定性抽样命中，已写测试明确边界；不宣称全页清晰、自动财务报表语义定位或模型生成必然成功。策略不含任何项目/文件名特例。

## 同环境性能对比

沧州授权原件10份去重、903页，SHA-256与上轮一致。只本机读取，原件未向模型/外部服务发送，也未提交Git。Windows Python/PDFium在同一进程内交替运行旧全页与新抽查，各3轮取中位数（毫秒）。排除Python启动、上传/网络与后台排队；结果不能当作整条用户链路耗时保证。构建与浏览器测试结束后顺序复测，仍可能受本机负载/缓存波动影响，短文档不保证更快。

共检查903→34页，减少96.2%；10份分类与旧算法一致。6份年审各查第5页即可确定低清。以182页历史募集书验证长清晰PDF，检查182→8页。此样本只检验通用探测器；上线拦截范围仍仅update/audit/pdf。

| 材料 | 实际检查页数 | 全页 → 抽查中位毫秒 | 两版一致的结果 |
| --- | ---: | ---: | --- |
| Y-4-1沧州港务集团有限公司2023年度经审计的合并及母公司财务报告.pdf | 114 → 1 | 55.86 → 4.14 | 低清 |
| Y-4-2沧州港务集团有限公司2022年度经审计的合并及母公司财务报告.pdf | 112 → 1 | 66.60 → 7.58 | 低清 |
| Y-4-3沧州港务集团有限公司2021年度经审计的合并及母公司财务报告.pdf | 126 → 1 | 86.60 → 34.83 | 低清 |
| Y-4-4沧州港务集团有限公司2024年度一季度财务报表.pdf | 8 → 8 | 15.06 → 17.27 | 未发现低清 |
| 沧州港务集团有限公司2021年度第一期中期票据募集说明书.pdf | 182 → 8 | 2499.87 → 121.40 | 未发现低清 |
| DY-4-1沧州交通发展（集团）有限责任公司2022年度经审计的合并及母公司财务报告(1).pdf | 109 → 1 | 39.88 → 11.28 | 低清 |
| DY-4-2沧州交通发展（集团）有限责任公司2021年度经审计的合并及母公司财务报告.pdf | 84 → 1 | 24.95 → 6.00 | 低清 |
| DY-4-2沧州交通发展（集团）有限责任公司2023年度经审计的合并及母公司财务报告.pdf | 156 → 1 | 94.97 → 5.13 | 低清 |
| DY-4-3沧州交通发展（集团）有限责任公司2023年半年度合并及母公司财务报表.pdf | 4 → 4 | 11.25 → 9.38 | 未发现低清 |
| DY-4-3沧州交通发展（集团）有限责任公司2024年半年度合并及母公司财务报表.pdf | 8 → 8 | 23.36 → 10.53 | 未发现低清 |

真实 Node worker 检测入口另测10份原件：全部complete、分类一致，含Windows独立Python启动的耗时1.819–4.804秒。不可用检测本体的毫秒数冒充上传端到端耗时。本地原始数据保存在ignored work/pdf-quality-sampling-benchmark.json、work/pdf-quality-sampling-wrapper.json。

## 验证

- npm run build：全工作区通过；最终测试fixture修正后另编译API。无新增运行依赖、无本PR数据库迁移。
- npm run check:contracts：72 pass / 0 fail / 0 skip；最初179公开+12内部+4生命周期合成样例通过；补充3个PDF回执样例后，check-examples.js复验182公开+12内部通过。
- python -X utf8 -B -m unittest python/tests/test_pdf_quality.py -v：12 pass / 0 fail；超时测试后改为确定性时钟并单独1/1复验。
- node --test apps/web/dist-test/material-processing.test.js：12 pass / 0 fail / 0 skip，包含抽查放行与准确文案、旧v2完整/低清/partial兼容。
- Linux Node22 / PostgreSQL16 / Azurite：10项其他相关回归通过；历史fixture修正后，audit-pdf-quality.pg.test.js最终定向复验6 pass / 0 fail / 0 skip，合计16个不同用例全部通过。批量命令：node --test packages/contracts/dist/pdf-quality.test.js apps/api/dist/pdf-quality.test.js apps/api/dist/audit-pdf-quality.pg.test.js apps/api/dist/required-audit.pg.test.js apps/worker/dist/pdf-quality.test.js apps/worker/dist/material-parse-job.test.js。
- Playwright Edge：audit-pdf-quality-gate、required-audit、authoring-source-guide、pdf-quality-warning共21 pass / 0 fail / 0 skip；原型配色校正后两项抽查成功对照另行2/2复验（与21项重叠）。
- 真实上传合成120页低清PDF只检查1页，合成1600页清晰PDF只检查8页；待检查、低清、部分检查、替换/删除、报价/任务、幂等、所有者隔离、错误流与进程超时、旧回执复用均在集成范围。编制输出为synthetic，不替代真实模型验收。
- 中间失败如实保留：首次测试模板库未初始化；初始化后旧回执测试错误地更新不可变parser_version，被DB约束拒绝。已改为正式enqueue/claim/checkpoint/release接口准备历史fixture，不弱化约束。其后普通解析取消接口不适用于独立质量任务，fixture再次调整为先完成自动任务后创建独立v2记录。最终node --test apps/api/dist/audit-pdf-quality.pg.test.js 6/6通过，覆盖并取代旧fixture失败，不改生产约束。

## 原型与交付

原型product-prototype/public/audit-pdf-quality-sampling.html与实现apps/web/src/material-processing.ts在同一提交交付，影响既有募集书材料步骤；只更新检查状态文案及轮询间隔，无页面/导航/布局变更。用户本轮抽查要求为行为确认依据。

apps/web/test-evidence/audit-pdf-quality-sampling包含1440×900、390×900同尺寸组件原型/实现，以及两种宽度完整材料页面。两组组件原型与实现PNG字节相同，全部页面已视觉检查无裁切或溢出。截图来自合成API，真实上传后端链路另测；没有把页面fixture当作真实模型输出或用户验收。

代码自测与用户实际验收分开。API、解析worker与web须协调发布，先确保解析worker支持v3再启用API新入队；旧worker不能领取v3任务。v2回执复用无需重扫或数据迁移。代码完成，尚未部署，待统一发布。

最终统一验收待办：统一测试版实际上传及队列/私有存储服务可用性、用户操作验收、本批发布质量门禁及授权上线。本chat不执行生产变更。
