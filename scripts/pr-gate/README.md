# 合并前检查（PR gate）

每个 PR 合并前自动运行仓库里的全部自动化测试，任何一个失败就不通过。`develop` 合并后直接部署，所以这道检查就是上线前的最后一道自动防线。

它只用模拟模型，不调用真实模型，不替代 `npm run test:release` 和募集书质量门禁。

## 文件

| 文件 | 作用 |
| --- | --- |
| `.github/workflows/pr-gate.yml` | 触发时机、测试环境、8 个并行分片，以及最后的 `pr-gate` 结论 |
| `scripts/pr-gate/run.mjs` | 发现测试、逐个运行、判定是否拦合并；只用 Node 标准库 |
| `scripts/pr-gate/exclusions.json` | 例外清单；每一条都必须写原因 |
| `scripts/pr-gate/run.test.mjs` | 检查脚本自身的 10 项回归测试，会被检查自动运行 |

## 和现有检查的区别

现有 8 个检查流程按文件名手写清单，不在清单里的测试没人运行。这里按目录发现：

| 分组 | 发现规则 | 2026-11-11 的数量 |
| --- | --- | --- |
| `api` | `apps/api/src/**/*.test.ts` | 201 |
| `worker` | `apps/worker/src/**/*.test.ts` | 202 |
| `packages` | `packages/*/src/**/*.test.ts` | 51 |
| `web-unit` | `apps/web/src/*.test.ts` | 66 |
| `scripts` | `scripts/**/*.test.mjs`、`deploy/**/*.test.mjs` | 22 |
| `python` | `python/tests/test_*.py` | 34 |
| `browser` | `apps/web/tests/*.spec.ts` | 186，其中 21 个不在检查里 |

新加的测试文件不用登记就会运行。修 bug 时补的回归测试从合并那一刻起永久生效。

现有 8 个流程先保留不动。原生沙箱容器内的测试、OCR 镜像和募集书质量门禁仍由它们负责。

## 启用步骤

1. **提一个 PR，把这 5 个文件加进仓库**，目标分支是 `develop`。
2. **这个 PR 自己会触发第一次全量运行。** 第一次大概率不通过，因为有相当一部分测试此前从未在自动检查里运行过。打开这次运行，下载附件 `pr-gate-result` 里的 `exclusions.suggested.json`，逐条确认后替换 `scripts/pr-gate/exclusions.json` 并推送，直到 `pr-gate` 通过再合并。
3. **仓库管理员开启分支保护。** 在 GitHub 仓库的 Settings → Branches 里为 `develop` 和 `master` 添加分支保护规则：
   - 勾选 Require status checks to pass before merging，并在搜索框里把 `pr-gate` 选为必需检查。
   - 同一区域里还有一项要求分支在合并前与目标分支保持最新，一并勾选，保证检查的是与最新 `develop` 合并后的结果。
   - 页面靠后有一项不允许绕过以上设置，一并勾选，管理员也不能跳过检查。

   各选项的准确名称和操作步骤见 GitHub 文档：<https://docs.github.com/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/managing-a-branch-protection-rule>

**第 3 步没做之前，这道检查只会显示红绿，不会真的拦住合并。** GitHub 文档写明，私有仓库的分支保护需要 GitHub Pro、Team 或 Enterprise。

## 例外清单

`scripts/pr-gate/exclusions.json` 里有三类例外，每条都要有 `pattern` 和 `reason`：

| 清单 | 含义 | 什么时候用 |
| --- | --- | --- |
| `notInCi` | 不在合并前检查里运行 | 需要真实模型、真实环境或人工时段的测试 |
| `knownFailing` | 照常运行，失败不拦合并 | 已登记待修的失败；恢复通过后结果里会提示移出 |
| `allowSkip` | 允许出现跳过项 | 依赖当前环境没有的组件；其它文件出现跳过会拦合并 |

`pattern` 是测试的源码路径，`*` 匹配一层目录内的任意字符，`**` 可以跨目录。

三条约束防止清单变成新的漏洞：

- 没写原因的条目会让检查失败。
- 匹配不到任何测试文件的条目会让检查失败，所以测试删除或改名时必须同步清理。
- `knownFailing` 里的测试照常运行，修好以后会被点名。

把一个测试加进 `knownFailing` 等于承认这部分功能暂时没有保护。建议每条都对应一个 Issue，并定期清零。

## 判定规则

以下任何一种情况都会让 `pr-gate` 不通过：

- 有测试失败、超时，或者没有运行任何用例，而且不在 `knownFailing` 里。
- 有测试被跳过，而且不在 `allowSkip` 里。
- 浏览器测试重试后才通过。
- 某个分组一个测试文件都没发现。
- 任何一个分片没有交出结果，例如在安装依赖或构建阶段就失败了。
- 例外清单本身有问题。

单个测试文件默认 5 分钟超时，每个分片默认 70 分钟时间预算，超出的文件按失败处理并提示增加分片。

## 本地运行

先按现有检查流程准备好测试数据库、Blob 模拟服务和 Python 环境，并完成构建。

```sh
# 只看会运行哪些文件，不实际运行
node scripts/pr-gate/run.mjs run --group api --list

# 运行一个分组；--report 表示只出报告、不改变退出码
node scripts/pr-gate/run.mjs run --group python
node scripts/pr-gate/run.mjs run --group api --shard 1/2 --report

# 脚本自身的回归测试，不需要数据库和依赖
node --test scripts/pr-gate/run.test.mjs
```

结果写在 `.local/pr-gate/`，失败测试的完整输出在其中的 `logs/` 目录。

## 调整速度和费用

- 某一组太慢时，在 `.github/workflows/pr-gate.yml` 的矩阵里增加它的分片数。最后的结论会自动按矩阵行数核对，不用另外改数字。
- 每个 PR 会启动 8 个并行任务，`develop` 每次合并后再运行一次。PR 多的时候 GitHub Actions 分钟数消耗会明显增加。想用自己的机器运行时，改工作流里两处 `runs-on` 即可。
- 同一个 PR 推送新提交时，上一次还没跑完的检查会自动取消。

## 不覆盖的范围

- **真实模型的生成质量**：仍然靠 `npm run test:release` 和募集书质量门禁。
- **新旧计费兼容脚本**（`npm run test:billing:mock:compatibility`）：依赖本机专用的计费测试环境，没有接进来。
- **原生沙箱容器内的测试**：仍由现有的 M3 CLI review 流程在容器里运行；在这里它们会表现为跳过。
- **旧 Cowork 应用**：仓库根目录 `tests/` 下的测试没有纳入。

## 验证状态（2026-11-11）

已验证：

- 脚本自带的 10 项回归测试全部通过（本地 Node 24.22.1），覆盖结果解析、判定规则、例外清单校验、分片、超时终止和结果合并。
- 在 BondBuddy 代码上核对了各分组发现的测试数量，与上表一致。
- 用仓库真实的 34 个 Python 测试模块实际运行了一遍：26 个通过，6 个含跳过项，2 个失败。失败原因是验证用的代码包不含超过 300 KB 的文件，缺少 `knowledge/workpaper-templates/2026-10-27/catalog.json`。本地是 Python 3.12，这个结果不代表 CI 上的结果。
- 工作流文件通过了 YAML 语法和结构检查：每个分组都被一组完整的分片覆盖，分片名不重复。

尚未验证：

- **工作流没有在 GitHub 上实际运行过。** 环境准备步骤照搬了现有流程，但第一次运行仍可能需要调整。
- `api`、`worker`、`packages`、`web-unit`、`scripts` 五组的真实测试没有运行过，因为验证环境无法安装依赖。
- 浏览器分组只用合成的测试报告验证了解析逻辑，没有实际启动过 Playwright。
- 全量运行需要多久、有多少测试会在第一次运行时失败，都要等第一次运行才知道。
