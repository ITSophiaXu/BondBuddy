# 开发交接：新版 BondBuddy 体验

这是 `http://127.0.0.1:4320/#dashboard` 对应的新产品完整源码，当前版本为 **1.9.0**。用它查看实际页面、表单、导航与状态变化；业务实现细节和历史验证记录见 [README](README.md) 与 [QA](QA.md)。积分规则及配置以 [CREDITS](docs/CREDITS.md) 为准，旧文档中的套餐及费用确认流程仅用于历史参考。

## 先看界面

安装 Node.js 22 或更高版本，在此目录执行：

```sh
npm start
```

打开 `http://127.0.0.1:4320/#dashboard`。没有 npm 第三方运行依赖，无需先执行 `npm install`。也可以双击 `Start-BondBuddy.cmd`。如果 4320 已有原应用运行，请另开端口，例如 PowerShell 中执行 `$env:PORT=4322; npm start`，然后访问 `http://127.0.0.1:4322/#dashboard`。

首次启动是独立的空工作区。使用测试手机号，如 `13800008000`，点击获取验证码，再输入页面显示的演示验证码。注册赠送 2,000 积分，在“积分与充值”查看余额和奖励，也可以创建演示充值订单；这套演示不会发送短信或真实收款。查看页面和填写表单不需要模型密钥；执行 AI 任务需要另外配置服务。

任务点击开始即执行，系统在后台校验可用积分并冻结本次预算，余额不足时提示充值，没有报价确认页或第二次费用确认。完成后按真实用量结算并释放余量；失败或取消释放冻结积分。模型计量默认采用已披露的参考单价，上线真实收费前需配置实际价格和支付渠道。

建议按下表顺序浏览：

| 页面 | 路径 | 重点体验 |
| --- | --- | --- |
| 工作台 | `/#dashboard` | 导航、成果统计、四个任务入口、最近项目、空状态 |
| 更新募集书 | `/#update` | 创建项目、填写业务信息、分组上传及项目对话，点击开始更新 |
| 复核募集书 | `/#review` | 待复核募集书必传，支持材料可选；报告期与复核范围，点击开始复核 |
| 材料生成 | `/#generate` | 选择材料类型、关联项目和模板、补充要求、生成 Word 成果 |
| 项目问答 | `/#qa` | 问题建议、来源材料、连续对话与按需外部查询 |
| 全部项目 | `/#tasks` | 任务列表、处理进度、详情、停止与重试、下载状态 |
| 积分与充值 | `/#billing` | 可用与冻结积分、邀请、活跃奖励、充值、账单及演示退款 |
| 价格条款 | `/credit-terms.html` | 赠分期限、充值规则、扣分及退款条款 |
| 系数说明 | `/credit-rule-details.html` | 更新、复核、生成、问答与材料格式的详细系数 |

没有复制设计者电脑上的项目、账号和资料库数据，所以新工作区的列表初始为空。募集书库已从客户导航移除，在内部根据业务信息匹配参考材料。公开募集书可按 `docs/募集书库设计与建库.md` 中的流程另行导入。不要把空白工作区误认为页面代码缺失。

## 代码位置

| 位置 | 内容 |
| --- | --- |
| `public/app.js`、`public/styles.css` | 主界面、导航与页面状态 |
| `public/project-workspace.js`、`public/project-fields.js` | 项目工作区、业务信息、材料和执行入口 |
| `public/material-studio.js`、`public/project-conversation.js` | 材料生成与项目对话 |
| `public/credit-account.js`、`public/phone-auth.js` | 积分钱包、充值与演示登录 |
| `lib/credit-rules.json`、`lib/credit-pricing.mjs`、`lib/credit-wallet.mjs` | 系数、计量、奖励、冻结及结算 |
| `server.mjs`、`lib/` | 本地接口、任务流程、模型适配、业务权限 |
| `python/` | 材料提取与 Word 写回 |
| `knowledge/` | 当前业务规则包及其文本来源，运行所需 |
| `qa/` | 可重复执行的测试和虚构材料生成脚本 |

Landing page 统一维护在仓库的 `../landing-page/`，避免在工作台中维护另一份官网副本。

## 需要文档处理或完整任务时

安装 Python 3.11+，执行 `python -m pip install -r requirements.txt`。如 Python 可执行文件名不是 `python3`，将 `BOND_BUDDY_PYTHON` 设置为其绝对路径。实际模型任务还需 Codex CLI 和服务端模型配置；按 `.env.example` 新建本机 `.env`。配置项留空即可只看 UI，不需要填入开发者个人凭据来启动页面。

本地数据写入此目录的 `runtime/`，测试生成物写入 `qa/artifacts/`，两者均已忽略。可用 `BOND_BUDDY_RUNTIME` 指定另一个本地数据目录。旧账本首次迁移前自动备份，旧有效权益按原单位保留，具体迁移规则见 `docs/CREDITS.md`。

更新已有服务时需要重启进程，`/api/health` 应返回 `version: "1.9.0"`、`oneClickExecution: true`。只刷新页面不会替换正在运行的后台。

## 后续修改

在此目录直接迭代代码，更新 `CHANGELOG.md`。基础检查运行 `npm run check`；完整隔离测试运行 `npm test`（需要上述 Python 依赖）。`qa/smoke_codex.mjs` 和 `qa/e2e_codex.mjs` 另需可运行的 CLI；普通测试不会调用付费模型。现有 `QA.md` 是历次开发记录，本次归档的验证结果另列在 `CHANGELOG.md`。
