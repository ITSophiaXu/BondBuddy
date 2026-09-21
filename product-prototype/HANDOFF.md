# 开发交接：新版 BondBuddy 体验

这是 `http://127.0.0.1:4320/#dashboard` 对应的新产品完整源码，归档版本为 1.6.0。用它查看实际页面、表单、导航与状态变化；业务实现细节和历史验证记录见 [README](README.md) 与 [QA](QA.md)。

## 先看界面

安装 Node.js 22 或更高版本，在此目录执行：

```sh
npm start
```

打开 `http://127.0.0.1:4320/#dashboard`。没有 npm 第三方运行依赖，无需先执行 `npm install`。也可以双击 `Start-BondBuddy.cmd`。如果 4320 已有原应用运行，请另开端口，例如 PowerShell 中执行 `$env:PORT=4322; npm start`，然后访问 `http://127.0.0.1:4322/#dashboard`。

首次启动是独立的空工作区。使用测试手机号，如 `13800008000`，点击获取验证码，再输入页面显示的演示验证码。查看任务表单时可选择套餐并点击“确认演示支付”；这套演示不会发送短信或真实收款。查看页面和填写表单不需要模型密钥；执行 AI 任务需要另外配置服务。

建议按下表顺序浏览：

| 页面 | 路径 | 重点体验 |
| --- | --- | --- |
| 工作台 | `/#dashboard` | 导航、成果统计、四个任务入口、最近项目、空状态 |
| 更新募集书 | `/#update` | 主动选择历史更新或参考起草 → 五项必填及分组选填 → 分角色上传 → 检查并开始 |
| 复核募集书 | `/#review` | 待复核募集书必传，支持材料可选；报告期与审阅范围 |
| 材料生成 | `/#generate` | 连续对话、关联项目、附加材料和文稿成果 |
| 项目问答 | `/#qa` | 问题建议、来源材料、专业版外部查询入口与权限提示 |
| 全部项目 | `/#tasks` | 任务列表、处理进度、详情、停止与重试、下载状态 |
| 募集书库 | `/#library` | 分类筛选、搜索、详情、按明确项目匹配并选为参考蓝图 |
| 套餐与用量 | `/#billing` | 套餐选择、演示结算、点数、余量与加购 |

没有复制设计者电脑上的项目、账号和资料库数据，所以新工作区的列表初始为空。公开募集书可按 `docs/募集书库设计与建库.md` 中的流程另行导入。不要把空白工作区误认为页面代码缺失。

## 代码位置

| 位置 | 内容 |
| --- | --- |
| `public/app.js`、`public/styles.css` | 主界面、导航与页面状态 |
| `public/authoring.js`、`public/project-fields.js` | 募集书编制流程、必填与可选字段、材料角色 |
| `public/library*.js`、`public/library.css` | 募集书库的分类、推荐及选用交互 |
| `public/account.js`、`public/phone-auth.js` | 套餐、额度、演示登录 |
| `server.mjs`、`lib/` | 本地接口、任务流程、模型适配、业务权限 |
| `python/` | 材料提取与 Word 写回 |
| `knowledge/` | 当前业务规则包及其文本来源，运行所需 |
| `qa/` | 可重复执行的测试和虚构材料生成脚本 |

Landing page 统一维护在仓库的 `../landing-page/`，避免在工作台中维护另一份官网副本。

## 需要文档处理或完整任务时

安装 Python 3.11+，执行 `python -m pip install -r requirements.txt`。如 Python 可执行文件名不是 `python3`，将 `BOND_BUDDY_PYTHON` 设置为其绝对路径。实际模型任务还需 Codex CLI 和服务端模型配置；按 `.env.example` 新建本机 `.env`。配置项留空即可只看 UI，不需要填入开发者个人凭据来启动页面。

本地数据写入此目录的 `runtime/`，测试生成物写入 `qa/artifacts/`，两者均已忽略。可用 `BOND_BUDDY_RUNTIME` 指定另一个本地数据目录。

## 后续修改

在此目录直接迭代代码，更新 `CHANGELOG.md`。基础检查运行 `npm run check`；完整隔离测试运行 `npm test`（需要上述 Python 依赖）。`qa/smoke_codex.mjs` 和 `qa/e2e_codex.mjs` 另需可运行的 CLI；普通测试不会调用付费模型。现有 `QA.md` 是历次开发记录，本次归档的验证结果另列在 `CHANGELOG.md`。
