# 参考募集书文字灵活更新：开发验证

Issue：[生成结果UX #987](https://github.com/ITSophiaXu/BondBuddy/issues/987)。行为依据：[2026-11-11 用户决定](../product-decisions/2026-11-11-reference-text-flexibility.md)。开发分支：`fix/reference-text-flexibility-20261111`。

## 已验证

Windows 本地独立工作区，Node 22.14.0、项目锁定 npm 依赖、bundled Python。Python 命令使用 `PYTHONPATH=python;python/tests`、`PYTHONIOENCODING=utf-8`，授权原件测试设置 `BONDBUDDY_RUN_AUTHORIZED_DOCX_REGRESSION=1`。

| 检查 | 结果 |
| --- | --- |
| `python -m unittest test_document_quality test_source_outline test_fixed_edit test_format_plan test_period_definition_guard test_file_authoring test_fixed_edit_authorized test_authorized_authoring_quality -q` | 143 tests，0 failures/errors/skips |
| 后续重复标题改写与旧直接生成路径补充验证：`test_source_outline` 和 `test_document_quality.DocumentQualityTests.test_legacy_direct_authoring_uses_same_flexible_policy_and_keeps_real_revisions` | 23 tests，全部通过，与前项有重复 |
| 最终结构比较改为按位置线性比较后的定向复验：`test_source_outline`、`test_fixed_edit.WordQualityPreflightTests`、`test_document_quality.DocumentQualityTests.test_cross_issuer_market_and_product_rewrite_preserves_template` | 45 tests，全部通过，与前项有重复 |
| `npm run build`，测试 helper 更新后另运行 worker build | 全部通过；Vite 提示既有大 bundle 警告 |
| `npm run check:contracts` | 32+29+11 tests，0 fail/skip；179+12 个契约示例及4个生命周期示例通过 |
| 设置 `BONDBUDDY_TEST_PYTHON` 后执行 `node --test apps/worker/dist/file-authoring-quality.test.js apps/worker/dist/file-authoring-format.test.js` | 19 tests，0 fail/cancel/skip/todo |
| yyx 事故的私有本地回放，并用最终代码重新检查 | 1,264 条原操作完整重放；旧报告64个章节内容丢失问题，新报告0 issues、passed |

正例涵盖换发行人、上交所私募公司债改银行间中期票据、标题措辞更新、正文相似度低于10%且字数低于25%的合法改写、简短局部更新及忠实PDF重建后改写。反例覆盖章节清空、短节清空、整表清空、章节删除／换位／重编号／层级变化、字体和格式漂移、双稿不一致、原件hash篡改、日期替换冒充实质更新及公式破坏。worker 的104→39回归使用真正的104/39个OOXML段落，避免把单段内换行误当成段落丢失。

## 事故回放边界

使用已保存原稿、锁定输入及操作日志，先验证原始SHA与输入绑定，再仅映射本地文件路径，按可信编辑器生成双稿并检查。没有修改源文件、输入身份或编辑操作，没有调用模型、重跑生产任务或登记客户成果。输出仍有93张表、945行，章节与公式结构未变化。客户原件及回放成果保留在私有本地诊断目录，不进入本仓库。

通过意味着旧的字数／相似度误拦截已消除，不能推导全部事实正确。该事故稿仍有旧主体内容待核，期间定义检查为 `needs_review`，没有独立财务事实或页面渲染验收，不能直接把回放稿交付为合格募集书。

## 集成与发布交接

没有新增依赖、数据库迁移、公共请求契约或页面交互变更。需要在统一发布时包含新的 Python 检查器、预检、格式诊断和编写指引；不能仅更新提示词。原失败任务状态和积分不作追溯更改，恢复或重跑另按用户授权与当时任务状态处理。队列容量及截图中的状态刷新问题不属于本Issue。

开发和自测完成，尚未部署，待统一发布。最终统一验收待办：集成本批代码；用明确目标主体和品种的真实生成样本核验标题／正文／目录一致性、事实及页面格式；用户验收后由指定发布chat执行当前版本的完整Linux发布门禁、真实模型验收和上线核验。本记录不是发布凭据。
