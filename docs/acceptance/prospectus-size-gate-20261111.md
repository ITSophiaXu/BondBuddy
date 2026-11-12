# 整篇募集书篇幅门禁：开发验证

Issue：[生成结果UX #989](https://github.com/ITSophiaXu/BondBuddy/issues/989)。用户在 #988 后明确补充：保留文字灵活，但300多页的历史募集书不能更新成100多页。实现见[同日决定补充](../product-decisions/2026-11-11-reference-text-flexibility.md)。

## 行为与边界

- 独立检查整篇正文规模与同环境实际渲染页数，不恢复旧句相似度或逐章字数要求。
- 长稿正文总量低于70%拒绝；原稿至少50页、清洁稿低于其70%且减少至少20页时也拒绝。源稿缓存页数只触发检查，不能作为实际页数。仅由缓存提示为长稿、实际渲染却是短稿的，不因陈旧缓存触发正文下限。
- 文字或非空段落数量已达到长稿信号时可先通过整体字符量判定拒绝；其他布局信号触发真实渲染，再据实际源稿规模判断。已有质量失败可以跳过渲染，但明确记为未执行。
- 接入同一个 `quality.verify`，覆盖模型预检和正式交付。`WORD_DOCUMENT_SIZE_REDUCED` 记录原值、新值与指标；渲染缺失／超时／失败记录 `WORD_PAGE_COUNT_UNAVAILABLE` 并拒绝，不能退回模型声明或Word缓存通过。
- 原稿以接受已有修订后的有效正文参与比较，避免修订显示扩大页数。页数通过只说明规模门禁通过，不等于财务事实或页面视觉验收。

## 已执行验证

环境：Windows，Node22、bundled Python。真实渲染使用从The Document Foundation官网下载、签名有效的LibreOffice26.8.2临时提取运行时（未安装到系统）；通过 `BONDBUDDY_WORD_LIBREOFFICE` 指向 `soffice.com`。本机Docker未就绪，已关闭本任务启动的Docker Desktop；没有在生产机器运行这些测试。

| 检查 | 结果 |
| --- | --- |
| `python -m unittest test_document_size test_document_quality test_source_outline test_fixed_edit.WordQualityPreflightTests -q` | 初轮84项全部通过 |
| 新增完整操作日志压缩、预检／宿主一致、陈旧缓存及输入伪造字段后，`test_document_size` 与两项完整流程反例 | 12项全部通过，与前项有重复 |
| `BONDBUDDY_RUN_DOCUMENT_SIZE_RENDER=1 python -m unittest test_document_size_render -v` | 2项真实渲染通过：310→104页拒绝；60→60页全文改写通过 |
| `npm run build`、`npm run check:contracts` | 全部通过；契约72项测试及179+12+4个示例通过 |
| `node --test apps/worker/dist/file-authoring-quality.test.js apps/worker/dist/file-authoring-format.test.js scripts/verify-prospectus-acceptance.test.mjs scripts/prospectus-quality-gate.test.mjs`（`BONDBUDDY_TEST_PYTHON` 指向bundled Python） | 70项通过，0失败、0跳过；含worker交付、格式、发布证据校验及独立财务读取 |

完整流程反例保留310个正文段落及章节、字体格式，通过受控操作逐段压成摘要，确认新门禁拒绝而不是依赖段落数量下降。预检与服务端报告一致；无效输入里的 `enabled=false`／自报页数／passed不会覆盖宿主检查。

真实分页反例保持全部文字与段落数量，只改变分页组织以单独验证页数保护；同一引擎渲染确为310页和104页，字符比例为1，仍拒绝。它是独立门禁的合成反例，不冒充客户文档或财务验收。

yyx事故样本使用上一修复保存的同一原稿、锁定输入和1,264条操作，本地检查通过。原稿实际166页、清洁稿164页；正文字符117,077→114,247（97.5828%），页数保留98.7952%。Word缓存两份均写164页，报告采用实际166/164而非缓存。没有调用模型、修改生产状态／账务或登记成功成果；旧主体内容与期间定义仍需独立事实验收。

## 统一发布交接

无数据库迁移、公共请求契约或新增npm/Python依赖；生产worker镜像已有LibreOffice Writer和中文字体。需要统一带上 `document_size.py`、检查器调用、提示词及新增固定回归。真实渲染套件已纳入 `run-document-quality-tests.py`，新工具及测试已纳入发布验收指纹。

代码开发与本地验证不等于生产已上线。最终统一验收待办：当前固定版本完整Linux门禁（含真实分页）、真实模型更新事实／目录／页面验收、用户验收及授权发布。本次未部署、未重跑生产任务。
