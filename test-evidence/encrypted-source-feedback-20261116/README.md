# 加密原稿提示：开发自测证据

关联 #1479。代码及原型均来自提交 `4448ac710d52ebec44b55d06f1ad1dedee3511bf`，基线 develop `279caf4e80f72fb8983187482b75d3fdd6fba2f3`。以下全部为本机合成样本，不含客户原件，不是用户验收或生产发布证明。

已保存的历史／参考DOCX若是Office加密包，可信prepare返回专用错误，worker保留为已有公共码MATERIAL_ENCRYPTED；任务页说明另存未加密DOCX、通过继续修改替换原稿。上传和通用错误提示同步明确未加密副本要求。识别基于有界CFB的EncryptedPackage流目录记录，同时覆盖使用DataSpaces的权限加密包；不尝试解密。哈希检查、普通损坏、IO及取消错误保持原语义。

## 验证

- Python原稿准备：12/12通过。`PYTHONPATH=python python -B -m unittest discover -s python/tests -p test_authoring_source_errors.py -v`。
- worker实际Python回调：7/7通过，0跳过。`BONDBUDDY_TEST_PYTHON=<本机Python> node --test apps/worker/dist/file-authoring-bad-input.test.js`。加密文件未到供应商调用；纠正后的正常DOCX能进入合成供应商回调。
- 网页API与上传提示：33/33通过。`node --test apps/web/dist-test/api.test.js`。
- 公共契约：72/72通过；179个公开合成例、12个内部库例及4个生命周期例通过。执行check:examples中的全部脚本，未改公共枚举或schema。
- 浏览器：11个不同场景全部通过，包括已有7种处理失败、桌面/移动加密提示2种、原型2种。新增2个测试初轮因未等待合成提交完成失败，修正测试竞态后2/2复跑通过；产品逻辑未因此改动。
- contracts、domain、rule-pack-registry、rule-applicability-context、worker构建通过，web类型检查及Vite正式打包通过。
- 全仓默认build在本次全新工作区有既有API/worker跨包测试产物循环：API测试引用worker dist，缺少声明时TS7016，生成声明后API emit又遇TS5055覆盖输入。未修改API或构建配置来规避，不能将默认全仓build记为通过。
- Windows，Node 22.14.0；真实Python准备模块与本机Edge。浏览器采用本分支实际Vite页面、合成HTTP边界，没有生产API/数据库/模型调用。

## 原型与实现

原型为现有 `product-prototype/public/authoring-live-progress.html?state=encrypted_source`；实现沿用 `apps/web/src/project-execution.ts` 的失败说明区和继续修改按钮。变更限于错误分类及对应文字，没有新增页面、布局或业务步骤。两边代码提交均为上述4448ac71。

| 尺寸 | 原型 | 实现 |
|---|---|---|
| 1440 × 960 | prototype-encrypted-source-1440.png | encrypted-source-1440.png |
| 390 × 960 | prototype-encrypted-source-390.png | encrypted-source-390.png |

已查看四张截图：文字可见、手机换行正常，无裁切或重叠；阶段定位为编制募集书，后续操作仍为继续修改。原型的简化外壳与实际应用已有导航、进度日志的差异不是本次布局变更。用户本轮明确要求提供未加密文件提示；尚未进行用户实际验收。

无数据库迁移、无新增运行依赖。仅需发布本批worker/Python及web代码。代码和定向自测完成，尚未部署，待统一集成与发布。历史已失败任务不由此PR改写或重跑；生产端到端验收留待统一测试。