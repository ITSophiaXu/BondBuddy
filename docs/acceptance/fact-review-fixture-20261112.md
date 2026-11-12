# #1081 / PR #1083：事实审核测试 HTTP 夹具

## 结论与固定版本

本次只补齐 `apps/web/tests/fact-review.spec.ts` 的外壳读取夹具。原 5 例全部通过，产品实现、5 个用例及 40 行原断言没有删除或放宽，未修改 skip/exclusions。普通上传页继续不展示或请求事实审核；保留组件仅由隔离测试挂载，遵守 #384 的已批准边界。

- 已测代码：`4cc03789cd1481add2a076129fba19e5a328fd24`；Git tree：`770c19adf323d9f5f27beaeff0f904d86b4d9a49`；基线 develop `8a7dc38a9546831346805d8cb36ce88aae456da3`。
- 运行时间：北京时间 2026-11-12 11:43:21—11:45:42；包含归档、contracts 编译和清理的总时长 141.320 秒，退出码 0。Playwright 5/5 passed，51.0 秒，单 worker、0 retry。
- Node `v22.23.3`、Playwright `1.63.0`；匹配锁文件的现有依赖缓存，镜像 `sha256:e081d9ca27e8ef07e6a658183b50b15a568a8126a67d70a3065ff630dfb7fdb9`，`--pull=never`。
- 每个归档源码按原始 Git blob 审计：3,625 文件运行前后均 0 差异。运行后工作区仍干净；后续提交仅添加本文与证据。

## 原失败与覆盖

原完整 gate `1794418350450-38278111` / commit `d3028cb2f5e98e5b9a9ad36deb68e461de4a6df2` 中，该隔离组件用例最后的 console 检查报告三个 404：`/commerce/catalog`、项目 `/prospectus-versions` 和 `/tasks`。保留 [原始失败摘录](fact-review-fixture-20261112/original-failure.json)，未改旧回执，其 749 文件整体状态仍为 failed。本单不把此测试夹具缺口视为已证实产品故障，也不声称解决其他 F/M 文件。

完整通过的 5 例为：身份不一致拒绝与服务端账号字段排除；普通上传页无事实审核入口和请求；全部分页、503 重试原 ID 与来源仍未核验；409 保留输入、禁止过期提交并显式刷新；不完整分页拒绝开放决定表单。原 console 检查保留；新夹具对未知方法/路由仍返回 404 并严格断言没有未处理请求。

## 隔离与执行

仅 `bb-fact-review-round1` 一个测试容器，实际配置 network `none`、1 CPU、2 GiB 内存（swap 同限）、mounts `[]`、ports `{}`。Vite 在容器内 `127.0.0.1:5189`；没有使用共享候选、5288、数据库、模型或公网。浏览器总超时 240 秒、整个容器执行上限 600 秒；未启重试。

合同编译完成后在 `apps/web` 执行：

```sh
BB_E2E_BASE_URL=http://127.0.0.1:5189 playwright test tests/fact-review.spec.ts --workers=1 --retries=0 --global-timeout=240000 --reporter=list,json
```

执行产物复制后自动删除容器，随后 `docker ps -a --filter name=bb-fact-review-round1` 确认无残留。原用例写入 `/tmp` 的四张临时截图不在报告输出目录，补取时容器已清理，未取到；没有为取图重复运行测试。本次提交测试日志与结构化结果，不声称已交付截图或新 UI 验收。

## 证据和边界

- [完整宿主输出](fact-review-fixture-20261112/host.log)、[总时长和退出码](fact-review-fixture-20261112/host-timing.json)
- [5 例输出](fact-review-fixture-20261112/browser.log)、[结构化报告](fact-review-fixture-20261112/browser.json)、[固定提交和状态](fact-review-fixture-20261112/result.json)
- [运行前源码审计](fact-review-fixture-20261112/source-before.json)、[运行后源码审计](fact-review-fixture-20261112/source-after.json)、[实际隔离配置](fact-review-fixture-20261112/isolation.json)、[依赖与运行时](fact-review-fixture-20261112/runtime.json)

完整本机运行目录：`work/fact-review-tests-20261112/round1`（宿主输出与总时长在同级）。这里是有界定向回归，不是全量 gate、五流程、真实模型、用户验收或部署证据。源码修正与定向回归完成，尚未部署。
