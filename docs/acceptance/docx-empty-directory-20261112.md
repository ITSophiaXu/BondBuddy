# DOCX 空目录兼容修复验收（#1057）

## 问题与修复

首次发现日期为北京时间 2026-11-12。本地发布测试的真实问答成果包含 5 个合法 ZIP_DEFLATED 空目录：压缩字节为 `03 00`、压缩长度 2、未压缩长度 0、CRC 0。原 `parseZipDirectory` 要求目录的两种长度都等于 0，故严格检查返回 `DOCX_ZIP_INVALID`。

共享 parser 现在保留目录未压缩长度为 0 的要求，并在返回任何条目前显式验证所有路径目录和 Unix mode 目录：有界解压最多 1 字节、实际内容必须为空、CRC 必须为 0、DEFLATE 输入必须完整消费。local/central 头、描述符、路径、重复项、链接类型、包数量、大小、压缩比和 OOXML 检查保持原规则。读取器即使过滤掉目录，也不能跳过这项验证。未改动生成器、原始成果或任何限额。

## 固定环境

- 独立分支基线：develop `8a7dc38a9546831346805d8cb36ce88aae456da3`。
- 原应用候选：`f298bc80dabedb1b1b24cd97ecb813dcffbebc56`，tree `c13a761242d2f35c75ca2d301930d6179adab551`；控制器 `f3fe821a`。
- 已缓存 API 镜像：`sha256:d2396d73994d62ea409ac591111a59e1b23e3c5d0e674c60c7d1c382ef9565fa`。
- Windows 主机 Docker Linux 隔离容器：Node 22.23.2，缓存 TypeScript 5.9.3，网络 `none`，1 CPU / 1 GiB。未安装软件、未连接数据库或存储、未启动应用服务、未调用模型。
- 在该镜像中覆盖本次 parser 和 synthetic 测试的编译产物。基线 develop 与固定候选上的 parser、原测试及相邻测试源文件相同。本记录是定向验证，不是完整构建、PR gate 或发布 gate 回执。

## 命令与结果

编译前使用缓存 TypeScript 严格检查（路径位于容器 `/app`）：

```sh
node /tmp/bb-typescript/lib/tsc.js --noEmit --target es2022 --module nodenext --moduleResolution nodenext --strict --skipLibCheck --types node apps/api/dist/docx-inspector.ts apps/api/dist/docx-inspector.test.ts
```

结果：exit 0。相邻 `generated-word-delivery.test.ts` 与 `review-report-content.test.ts` 使用相同参数亦为 exit 0。仅将指定源码用 TypeScript `transpileModule` 编译覆盖到对应 `.js`，没有安装依赖。

| 执行 | pass / fail / skip | Node TAP 总耗时 | 说明 |
| --- | --- | --- | --- |
| 原 parser + 最初 11 项测试 | 6 / 5 / 0 | 1.874 秒 | 明确重现合法空 DEFLATE 误拒；还发现原有 stored 空目录 CRC 未校验 |
| 修复 parser + 最终 `node --test apps/api/dist/docx-inspector.test.js` | 15 / 0 / 0 | 1.735 秒 | stored/DEFLATE 空目录；声明非空、伪装空、单字节、错误 CRC、尾随数据、local/central 不一致、Unix mode 目录、过滤器绕过；原有恶意包及限额回归 |
| `node --test apps/api/dist/generated-word-delivery.test.js apps/api/dist/review-report-content.test.js` | 4 / 0 / 0 | 3.841 秒 | 既有大文件交付策略、正文读取及内部进度内容判断 |

测试数据全部为 synthetic。最终本次覆盖的源码 SHA-256：

- `docx-inspector.ts`：`f1d75326e0d85c3f3af66519718a4a879a476a5e0806543f1d7fe9eb5814727b`
- `docx-inspector.test.ts`：`7ddd754c8ec86da078675bd940f9c3a687854a07a00abdee1d1976880630903c`

## 原始真实成果复核

只读复制发布任务已下载的原始问答成果到隔离容器，未重新生成、调用模型或更改原文件。

- run：`f12ff78b-0975-45c1-89ea-2229d5c69c55`
- 大小：23,887 字节
- 原始与复查 SHA-256 均为 `3da13bcc7861e606e8103b79496110ec7d16fb8dec37e53fae4997df98f48b26`
- 复查时间：`2026-11-12T01:41:28.856Z`
- `inspectDocx`：passed，17 entries，5 项结构检查均 passed，failure codes 为空。
- `readDocxBodyText`：9,426 字符；`readBoundedZipParts`：12 个文件部件。
- 只证明同一字节文件的结构可读性，不代表内容正确、业务质量或整批发布验收通过。客户文件和正文均未提交 Git。

本地原始日志保留于独立工作区的 `work/docx-empty-directory/`（不提交运行资料）：`before.tap`、`final.tap`、`related.tap`、`compile-final.json`、`original-after.json`。

## 剩余发布工作

代码完成，尚未部署，待统一发布。原始失败证据继续保留。修复进入新固定候选后，需要发布主任务重跑全部必需用例、模型探针、当前 commit/tree 质量凭据和部署检查。更新双 Word 的 `DOCX_XML_SIZE_LIMIT` 是另一项额外检查与合法长稿适配的问题，本修复不处理或放宽该限制。
