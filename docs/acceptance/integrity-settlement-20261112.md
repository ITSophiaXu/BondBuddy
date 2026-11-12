# 诚信核查费用说明与窄屏步骤条：独立修复验证

## 修复与固定版本

- #1068：原结果页只显示总实扣，不能对应实际计费范围。现在只读投影已保存的有效查询范围、原预留、实扣及实际释放事件；在原费用位置解释部分成功和未交付全释放。不改变报价、结算算法或任务写入路径。
- #1075：原有诚信流程步骤条在 320px 视口横向溢出 17px。独立 CSS 提交让步骤文字在窄屏自然换行，保留步骤顺序、当前标识和桌面布局，不隐藏溢出。
- 原 develop 基线：`8a7dc38a9546831346805d8cb36ce88aae456da3`。
- #1075 独立分支 `fix/integrity-narrow-steps-20261112`：`56cd4498afc0004130286a01691574c2c4718da2`，基于上述 develop，仅修改诚信核查 CSS。
- #1068 分支 `fix/integrity-settlement-explanation-20261112` 堆叠在 #1075 分支上。最终浏览器测试代码：`644a5f0edc1c6c1493395ddec902e5a0bc7bee24`，Git tree `bb8d6318edfb82f7e55bdfa4d6e71d96efdda280`。随后提交只添加本文和证据，不能把文档提交 SHA 当作已重新跑过测试的代码 SHA。

## 验证结果与实际失败

| 轮次 | 固定代码 | 实际结果 |
|---|---|---|
| round1 | `148fdbd61d413e8a2239badcf52c25b5ac8ff8ef` | API/依赖编译通过；归档漏掉 `scripts/local-integration/config.mjs`，web 类型检查出现 3 处缺失导入，未运行浏览器。归档配置补齐后重跑。此轮只有运行前源码审计，不声称有运行后审计。 |
| round2 | `8d9ac1e7393e675660f436d74133fdbcc0e39e58` | contracts/domain/rule packages/API 编译及完整 web 类型检查通过；12/12 单元测试通过；179 个合成合同样例与 12 个内部库样例通过。浏览器 6/7，320px 实际宽 337px 失败。随后发现合成 v4 夹具缺完整 `commerceMetadata`，查询列表没有展示；这 6 个通过及其截图不作为最终有效夹具证据。 |
| layout3 | `faa62c868b64aa7c6fd5597b8910a3f9cfc2c693` | 补齐 v4 元数据且严格验证 5 条查询记录后，两项 320px 检查中实现仍因宽 337px 失败；原组件对照截图成功。两边唯一越界都是既有 `span.step.current`，left=234/right=337/width=103，由此单列 #1075。 |
| final4 | `644a5f0edc1c6c1493395ddec902e5a0bc7bee24` | contracts 编译和完整 8/8 相关浏览器用例通过（1.7m，单 worker，无 retry）。实现 1440/390/320px、全部成功、失败全释放、缺证据、运行中、旧合同、免费导出及三尺寸原组件对照通过。320px `scrollWidth=305`，越界元素 0。 |

round2 至最终代码之间 API、contracts、费用说明 helper 及结果页实现内容完全相同；后续变更为测试夹具、诊断和独立 CSS。没有为 CSS 重复完整 API/web 类型检查，最终仍重编译 contracts 并重新执行全部相关页面用例。

单测命令：

```sh
node --test packages/contracts/dist/billing-wire.test.js apps/api/dist/integrity-settlement.test.js
node packages/contracts/dist/check-examples.js
```

页面命令（在 `apps/web`，Vite 仅监听容器内 `127.0.0.1:5189`）：

```sh
BB_E2E_BASE_URL=http://127.0.0.1:5189 playwright test tests/integrity-settlement.spec.ts --workers=1 --retries=0 --reporter=list,json
```

断言覆盖真实组件上的原预留/实扣/释放、两项精确对象与网站标识、五条查询记录、无收费快照冲突、刷新不修改合成 workspace 且写请求为零。单元测试覆盖缺失、重复、格式错误、越界查询范围、账务矛盾、legacy/export/running 与 int64 wire 金额。未把模拟 HTTP 数据称作真实账本或官网执行。

## 隔离和源码审计

每轮单独容器，`--network none --cpus=1 --memory=3g`，无宿主挂载、无发布端口；使用固定 Git archive 和现有依赖缓存，锁文件比对通过。final4 Node `v22.23.3`、Playwright `1.63.0`；镜像及配置见 [隔离记录](integrity-settlement-20261112/final4-isolation.json)。没有生产访问、数据库服务、官网或模型调用，没有真实收费。

round2、layout3、final4 的 3,631 个归档源文件逐个按原始 Git blob SHA-1 在执行前后核对，均 0 差异。final4 已复制证据后删除容器，`docker ps -a --filter name=bb-integrity-settlement` 无残留。完整本机日志保留于 `work/integrity-settlement-tests-20261112/{round1,round2,browser-only/layout3,browser-only/final4}`；本目录保留可审阅的合成证据。

- [最终浏览器日志](integrity-settlement-20261112/final4-browser.log)、[结构化结果](integrity-settlement-20261112/final4-browser.json)、[固定提交和退出状态](integrity-settlement-20261112/final4-result.json)
- [源码前审计](integrity-settlement-20261112/final4-source-before.json)、[源码后审计](integrity-settlement-20261112/final4-source-after.json)
- [12 项单测](integrity-settlement-20261112/round2-focused-unit.log)、[合同样例校验](integrity-settlement-20261112/round2-contract-examples.log)

## 原组件比较和视觉核对

`product-prototype/public/` 没有独立诚信结果页。本次对照使用 `8a7dc38a` 的**完整原始结果组件**；`apps/web/tests/reference/integrity-settlement/provenance.json` 保存来源与 SHA-256，测试校验后在相同 Vite、HTTP 夹具、周边页面及 CSS 下加载该组件。final4 两侧共同含 #1075 CSS，以隔离费用说明变化；它不是完整旧站快照，也不是新原型批准或用户验收。

三尺寸实现和原组件共 6 张 final4 截图已逐一查看：费用仍在原位置、展开范围可读、五条查询记录完整、桌面布局延续，窄屏步骤自然换行。#1075 的原始窄屏缺陷另保留 layout3 的未修复 CSS 对照。

| 视口 | 原组件（共用 final4 CSS） | 费用说明实现 |
|---|---|---|
| 1440px | [原组件](integrity-settlement-20261112/baseline-1440.png) | [实现](integrity-settlement-20261112/implementation-1440.png) |
| 390px | [原组件](integrity-settlement-20261112/baseline-390.png) | [实现](integrity-settlement-20261112/implementation-390.png) |
| 320px | [原组件](integrity-settlement-20261112/baseline-320.png) | [实现](integrity-settlement-20261112/implementation-320.png) |

#1075 修复前：[原组件 320px](integrity-settlement-20261112/layout3-original-320.png)、[越界诊断](integrity-settlement-20261112/layout3-original-320.json)。修复后：[320px 无越界诊断](integrity-settlement-20261112/implementation-320.json)。

## 交付边界

无需数据库迁移；只读释放汇总使用已有 owner/reservation/kind 索引。#1068 的 API、contracts 和 web 应同批集成；缺少可信持久证据时显示无法核对，不能猜算或冒充已核对。#1075 仅 CSS，可独立集成。真实账务和官网结果的一致性仍需统一五流程验收在固定版本验证。

状态：开发和自测完成，代码完成，尚未部署，待统一发布。没有声称本地集成版已交付、用户已验收、真实五流程已通过或已经上线。
