# 第一批验证记录（2026-10-12）

产品基线：`6cd5d2cb254a25963b79f44313440a64c6c38660`。集成分支：`integration/local-20261012-batch1`。本分支新增测试工具、3 项真实浏览器回归及入口测试子进程清理；不修改产品运行逻辑，不新增迁移。

## 已完成

| 检查 | 结果 |
|---|---|
| 全量构建 | 通过（Vite 大 chunk 提示保留） |
| contracts/schema | 11 通过 |
| web 单元测试 | 91 通过 |
| API 计费/进度/历史/复核 | 9 通过，0 跳过 |
| 动态余额专项 | 2 通过，0 跳过；含与其他组重复的 meter 单元测试 |
| Python 原稿批注测试 | 12 通过 |
| 既有模拟 API 浏览器测试 | 70 通过，7 跳过 |
| 真实注册流程 | 1 通过 |
| 新增真实 HTTP/数据库/存储浏览器测试 | 更新、助手草稿 2 通过；复核上传与要求 1 通过 |
| 本地服务停止重启后真实浏览器复验 | 注册、更新、助手、复核共 4 通过 |
| Windows worker 合成回归 | 6 通过，3 失败；POSIX 解析隔离不可用 |
| Linux worker 合成回归 | 9 通过，0 失败，0 跳过（tests-worker-linux.log） |

真实浏览器回归检查自动命名、原稿年份/品种、DOCX/PDF 上传、保存后的刷新恢复、助手草稿恢复和桌面/手机布局。没有 API mock，没有模型调用。保存断言等待真实回执，避免提前刷新产生误报。

## 运行边界

本地入口 `http://localhost:5178` 使用独立 Postgres 与 Azurite；测试账号及启停命令见 README。API readiness 200 说明基础服务可用，不代表模型生成已就绪。

正式 Linux worker 镜像构建的官方 npm 请求报 `ERR_SSL_SSL/TLS_ALERT_HANDSHAKE_FAILURE`。Docker Desktop 已恢复可用；没有降低 TLS 校验或文件隔离检查。未配置真实模型凭据，因此实际解析到生成、真实任务暂停/余额续跑、模型费用及成果质量均未通过端到端验收。

Windows 原始失败与 Linux 回归分开保留。合成 worker 测试里的模型/解析夹具不能作为真实模型效果证明。Linux 测试脚本把只读本地源码和依赖复制进容器临时文件系统，并重建 npm workspace 软链接，避免 Windows junction 和跨系统挂载导致的启动问题。

本机完整日志及截图在相邻 `../work/local-integration-runtime-20261012`，共享交接在相邻 `../work/local-integration-handoff.md`（相对仓库根）。

**限定范围本地可验收；用户尚未验收；尚未部署。**
