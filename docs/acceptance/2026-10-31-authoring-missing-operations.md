# 募集说明书缺失修订日志：诊断与修复

实际失败任务的模型进程正常退出，但私有结果只有原稿、锁定输入和格式清单，没有 `operations.json`、`delivery.md` 或双 Word。collector 保存 `WORD_FORMAT_OPERATIONS_MISSING`，交付返回 `WORD_DELIVERY_UNAVAILABLE`，队列归一为 `DELIVERY_FAILED`；公共事件投影又丢弃了不在枚举内的具体错误码。模型最后说明和命令输出未被 collector 接收，随后整个临时目录删除，无法回溯失败命令的具体错误。客户输入和取证资料只保存在本地诊断目录，不入库。

生产运行使用 Codex 0.154.0、Node 22.23.3，模型正常结束，非超时。锁定输入含正确的 DOCX 格式来源及 `source-format-v1`。生产 `task.md`、`fixed-edit.md`、`fixed_edit.py` 的 SHA-256 均匹配 `f2dcc921` 源码。已有性能修复 #854 针对长时间重放，本次没有进入重放，不能据此认定同一原因。精确词检索 `operations.json`、`WORD_DELIVERY_UNAVAILABLE` 未命中已有 issue。

## 行为变化

- 仅募集说明书编制启用一个应用提供的只读 Stop hook。文件齐全直接结束；缺失时在同一 CLI 内反馈一次，接续当前文件；仍缺失则结束并保留失败。没有新 CLI、自动重新提交、空日志补造或原稿冒充成果。
- hook 只核对普通文件、大小和固定路径，不检查正文质量、样式或 OOXML，不增加已生成双 Word 的额外下载前置。正式交付仍由原有受控重放和授权存储链路负责。
- 只信任固定应用命令的精确配置哈希，保持用户配置忽略、文件沙箱和网络限制。没有 bypass hook trust。信任算法及同进程继续语义已按 `rust-v0.154.0` 源码与实际二进制验证。
- 缺文件结果追加私有 `diagnostic.json`，保存最后说明、最多24条命令尾部和指定工作记录；总大小上限512KiB，超限明确标记省略详情。证据不进入公共进度或 Word 交付。保存失败保持既有存储失败／待核路径，不重调模型。
- `WORD_FORMAT_OPERATIONS_MISSING` 从交付、队列、公共事件传到任务页面。页面在 `processor_failed` 同时携带此错误时展示具体原因；其他状态沿用原有逻辑。
- 提示词强调章节修改及时落盘及准确完成条件。模板版本升级到 `single-cli-authoring[-format]-v2`，该执行路径适配器版本为 `codex-file-authoring-2`。

## 验证

1. 全工作区编译；worker 作者执行、失败证据、格式重放、原格式继承、错误锚点拒绝、旧任务交付和适配器回归。Python 相关测试实际运行，无跳过。
2. API公共错误投影和复核时间线14项通过；共享契约示例、数据生命周期、OCR和主体绑定检查通过。
3. 使用本地已有生产同版 worker 镜像，`--network none`，运行 `apps/worker/test-fixtures/codex/completion-probe.mjs`，以回环模拟 Responses 服务验证：缺失后补齐、持续缺失、初始齐全。前两者各2次模拟 HTTP响应、后者1次，均只有1个 CLI 进程。最终 usage 分别20/10、20/10、10/5，确认统计的是完整累计输入／输出用量。
4. 浏览器回归使用模拟API及独立本地端口；实际模型的编制质量和原项目格式验收不属于该模拟证明范围。

复现协议探针：先编译 worker，在 Codex 0.154.0 worker 镜像中将新 `file-authoring-completion.js` 挂载到 `/app/apps/worker/dist/`，将探针挂载到 `/tmp/completion-probe.mjs`，以 `node /tmp/completion-probe.mjs` 运行。容器设置 `--network none`，无生产凭据。

## 发布与恢复边界

代码完成后交统一集成测试／发布流程；本开发 chat 不部署。需要共同更新 worker（含新固定脚本）、API/共享契约和 web；没有新增包、数据库迁移或 Codex 升级。

已失败任务没有可重放的操作日志或双 Word，不能使用仅恢复交付的命令补出实质修改。修复不会改写它的失败事件和账务，也不会自动重跑。真实项目需要在修复上线且获得新编制授权后才有新的成果可验收。模型为何未写日志的具体命令错误因旧证据已清理而未完全查明；本修复提供完成反馈并补齐以后同类失败的可诊断性，不声称已经完成本项目全文或专业格式验收。

官方机制参考：[Codex Hooks](https://developers.openai.com/codex/hooks)。固定版本源码对应 `openai/codex` 的 `rust-v0.154.0`。
