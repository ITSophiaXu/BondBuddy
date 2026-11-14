# 上传四路并发候选验收

Refs #943，集成 PR #1338 的准确源 `e446762b8b74177ae57331780ab3100eee88909e`。原提交是四项在途、两路实际 PUT；本补充将全部 ApiClient 共享实际 PUT 上限提高到四，并将原文件 SHA 改成单路、1 MiB 分块增量计算。页面布局、文案及业务采用顺序不变。

独立确认新增显式 general4 + small1 配置：448 MiB disk spool、1 CPU、1.5 GiB memory、384 MiB heap。原 general1 + small1 配置及既有放置继续可用；未变的身份、租约、fence、原对象完整 SHA 和最终事务校验不省略。

截至 11 月 14 日 21:25（北京时间）的本地实测：

| 验证 | 原始结果 |
| --- | --- |
| 完整工作区构建 | 通过；首次缺依赖的环境失败保留，安装完整依赖后通过 |
| 浏览器调度／摘要／恢复定向单元 | 302 pass，0 fail，0 skip；包含原失败 journal、未授权重 PUT 和顺序恢复 |
| 确认部署守卫 | 5 pass，0 fail，0 skip |
| PG16／HTTPS Azurite 确认、回执复用、篡改、隔离及运行时 | 29 pass，0 fail，0 skip |
| Chromium 四个 100 MiB 原文件 SHA | 总 9.093 s；每次最多 1 MiB、一个实际读，无 whole-file ArrayBuffer；537 渲染帧，最大帧间隔 77.6 ms |
| 六个同字节 8 MiB 文件实际 XHR PUT | 串行峰值 1／3.156 s；四路峰值 4／1.753 s；第 5、6 项等待，全部真实 Blob size/SHA/ETag 通过 |
| 四个 100 MiB + 一个 16 MiB 确认 | 实际同时 5 个读，416 MiB reservation；4 个 general 大件 gate 保持期间小槽独立完成；空 spool／reservation 0，完整性、唯一性及 200 回放通过 |
| 相同原字节确认批次，无人工延迟 | general1 + small1 为 11.258 s；general4 + small1 为 9.568 s；门控预算用例不计速度 |
| 实际受限确认 cgroup | 1 CPU／1.5 GiB／无额外 swap；预算用例 peak 543522816 B，非门控四路 peak 538419200 B；OOM 0 |

`scripts/upload-four-browser.mjs` 使用真实 Chromium／XHR／HTTPS Blob；`scripts/upload-four-confirmation.mjs` 使用真实 PostgreSQL、Blob、落盘读取和受限容器。合成 PDF 声明是 opaque 原件字节，不代表最坏 PDF 解析，也不代表国内浏览器吞吐或生产四倍提速。独立传输测试不替代正常认证的 `browser-input-chain`。

生产状态仍为已验收的 execution general1 + small1。本候选尚待准确集成源的独立审查、当前质量与真实模型金样凭据、正常浏览器输入链以及定向部署。API 和独立确认所含 API 实现必须一致；保留当前混版及四槽复核，不能整栈发布。已完成放置证据复用；历史下载超时及测试 401 原件不改写，不放入上传部署回调。CI 未执行，不声称通过。
