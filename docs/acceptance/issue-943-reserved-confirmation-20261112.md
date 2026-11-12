# #943 小文件确认保留槽：开发验证

Refs #943。基线 `8a7dc38a9546831346805d8cb36ce88aae456da3`；本记录不是生产验收或发布许可。

## 原因与范围

确认消费者逐个完整回读 Blob 并核对字节、SHA-256、对象版本，保存扫描 PDF 不做 OCR。大文件回读慢会阻塞后续小文件。本改动保留一个 FIFO 通用槽，增加一个仅领取不超过 16 MiB 声明的小文件槽。不能据此声称单个大文件跨区域读取已提速。

小槽在 SQL 领取前按确认记录的 byte_size 及 owner/upload 关系过滤，保留 SKIP LOCKED、续租和提交 fence。大文件仍由通用槽处理，不能通过增加容器数量扩并发。

复用 PR #1028（`ede30fb29ccb7a84135a0b77dbc937c50db08a2f`）必要的后端声明限读与三个回归测试：直传 HEAD 长度不符先拒绝，读取后核对同一 ETag，条件清理不删除替换对象。为本次并发安全，旧代理上传也按声明限制实际读取。源流、转换流和文件写入全部结束或取消清理后才返回、释放暂存预算；没有增加总 deadline。canonical 复用先核对 owner/project/role/size/hash，按同一大小界限作流式校验，不另建完整暂存副本。

## 启用与恢复

- `BB_UPLOAD_CONFIRMATION_SMALL_SLOT=0` 默认关闭；启用必须同时开启确认，且仅允许纯解析进程。
- 主站纯解析服务使用 `BB_UPLOAD_CONFIRMATION_SPOOL_MAX_BYTES=134217728`（128 MiB），映射到进程的 `BB_UPLOAD_SPOOL_MAX_BYTES`。启动校验至少能容纳 100 MiB + 16 MiB，暂存目录必须为明确绝对路径、磁盘挂载。
- 实际 Blob 流及文件写入按各自声明硬限读，所以两个槽最多产生 116 MiB 完整暂存内容。这不是进程 RSS 上界；解析、SDK 缓冲和运行时内存另计。两端配置、磁盘余量、准确镜像和现有部署互斥仍须发布前核验。
- 回退此选项为 `0` 后按正常流程排空并重建该消费者；保留原配置/hash。无需数据回滚，不改迁移、公共 DTO 或计费，不直接回滚到不兼容旧镜像。

## 定向验证

Node.js 22、独立 PostgreSQL 16/HTTPS Azurite（`--skipApiVersionCheck`），仅合成字节和受控阻塞，无生产业务或模型调用。相关六个包 build 成功，`git diff --check` 通过。

| 命令范围（均在编译后运行） | 最终结果 |
| --- | --- |
| `node --test --test-concurrency=1 apps/api/dist/upload-confirmation.pg.test.js apps/api/dist/direct-upload.pg.test.js apps/api/dist/blob-range-reader.test.js apps/api/dist/upload-spool.test.js` | 42 通过、0 失败、0 跳过 |
| 运行时两文件定向 `reserved`、`controlled fact producer`（下列命令） | 4 通过、0 失败、0 跳过 |
| `node --test --test-concurrency=1 apps/api/dist/blob-range-reader.storage.test.js` | 6 通过、0 失败、0 跳过 |
| `npm run check:contracts` | 32 + 29 + 11 测试通过；179 合成示例、12 内部示例、4 生命周期示例通过 |

```sh
node --test --test-concurrency=1 --test-name-pattern='reserved|controlled fact producer' apps/worker/dist/runtime-upload-confirmation.pg.test.js apps/worker/dist/runtime-entry.test.js
```

同一场景：两个 71 MiB 文件和三个小文件（6 MiB、233771 B、147886 B），阻塞第一个大文件确认。关闭选项时小文件 0/3 完成、峰值一个读取及 74448896 B 暂存；开启时小文件 3/3 先完成、峰值两个读取及 80740352 B 暂存，第二个大文件未被小槽领取。全部完成后每个 upload 只有一条材料，实收大小/hash 匹配。阻塞观察为 2306/1797 ms，属于合成对照，不能换算生产加速百分比。

边界还覆盖：16 MiB 原子并发领取、较大任务不消耗小槽重试、canonical 声明变化零读取、租约过期旧 token 不可提交、声明超限及对象替换、取消流延迟关闭和既有文件不误删。

首轮失败均保留：API 39/1 为专用 Azurite 缺 CORS，补合成 origin 后通过；运行时新配置测试缺解析版本、峰值观察时序和共享暂存统计污染已修正，保留峰值断言；API 第二轮新测试遗留 pending 记录干扰全局领取，已让各用例完成自身工作，未删原断言。旧入口 smoke 在提交任务前得到 `422 INPUT_REQUIRED`；在干净的上述基线另行编译，原用例独立运行同样为 0 通过、1 失败、0 跳过，错误相同，证明不是本次补丁引入。它未纳入最终定向四项，不修计费/输入范围。契约检查首次因稀疏检出缺原型文件失败，补齐原文件后通过。

最终完整日志 SHA-256（原日志受保护留存）：

- API：`bf44d0d1b5c29c2941e786d0003953808a5f8059431279c0687367760438b268`
- 运行时：`3f65e9a78923b44115e99753ac0283791f0678c668fc9c50a9b0f8c860d9e994`
- Blob：`bd0b3cde73a88df611a2a94be6ef82cb2952f482459de3b77d34f185202ff8c6`
- 契约：`6239fbbf08861796b956e3d4025205faeb37bb16b41bdb1f345b53196d4f2f7e`
- 旧入口基线失败：`1c681dde8d8a76b45cb1dabca1908e56c07d302e8f25e4571626740074274566`

## 界面和剩余验收

原型为 `product-prototype/public/authoring-materials-entry.html`，基线同上；现有“保存后再采用”、材料列表与状态协议不变，没有修改 `apps/web`。已审 #993（`b012230d174c2f676ea04d7cd02e89b7b062b742`）的可信成功行收敛仅作为单独发布候选依赖，不在此开发 PR。

未部署，未声称 CI、完整旧入口 smoke、新版本真实金样或原浏览器双行验收通过。待最终受控候选核对版本/兼容性与发布门禁后，验证实际大文件阶段耗时、小文件解除排队、原上传恢复和成功行收敛；#943 保持开放。
