# 2026-10-13 材料生成必填信息提示

状态：开发和自测完成；**本地集成版可验收**；用户尚未验收；代码完成，尚未部署，待统一发布。

来源 [PR #699](https://github.com/ITSophiaXu/BondBuddy/pull/699)：产品/原型 `1e333402a79f65251f08ae8fd29a72fd3c295713`、证据 `574a015a2aea522664b77d33afa55ab52e77cdbd` → 集成 `2658fff900b1c9944ab85309802b3f6108aa9750` / `fa74e1b79fbe82499a25a0694b0fe811d45f4f27`。web/API 产品版本为 `2658fff`；worker 保持 `de494b8` / 镜像 `ac24565c…`。本轮没有新增迁移或依赖，现有动态积分与旧任务不变。

## 行为与验证

- 上传成功后文件直接显示，不再出现“材料已保存并加入当前草稿，不会自动开始制作。”。
- 生成前列出实际缺项，例如“尚未选择交易所，请选择上海证券交易所或深圳证券交易所。”，明确补齐后再点生成。点击列表按钮定位到填写区，字段旁同步标记；填齐后清除，切换文种不残留无关要求。
- 交易所、立项券商／模板、募集书／材料的条件由公共 contracts 统一定义，API 返回 Error.field_errors；页面仅渲染白名单固定中文，不回显任意错误信息或内部编号。原本允许补充材料单独生成及选用全文底稿的路径保留，不新增发行人等必填项。
- 来源浏览器最终 **44 通过 / 1 旧可选跳过**；初轮一项旧成果测试初始化超时，原断言复跑通过。API 错误/下载单元 **15/15**，隔离 PostgreSQL + 公共错误响应共 **9 项最终通过**（新测试账号夹具名称修正后定向通过）。contracts/API/web 编译、Vite、171+12 契约示例、4 生命周期示例通过。
- 合成 1440×960 / 390×844 同尺寸原型与实现证据：`apps/web/test-evidence/material-input-feedback-20261013/`。已有窄屏与动态积分回归保留，真实模型未调用。

14:14 确认无活动任务后，使用原安全 stop/start 生命周期更新本地 API/web。原账号、数据库、文件、parse 存储与 worker 镜像保留；不执行生产操作。前端产物 `index-laACkJeQ.css` / `index-DZMRyWk6.js`。

**真实本地 Edge 1/1 通过**，API 无模拟。独立合成账号真实上传 DOCX，未选择交易所时无报价/执行请求；页面明确缺项、按钮可定位；直接向 API 请求报价也收到 market 字段提示。选择交易所后提示清除，点击生成正常进入积分校验；合成账号余额为 0，未执行生成。刷新后保留选择和文件。新增生成任务、积分预留、扣费、模型调用均为 **0**，页面脚本错误 0。

首轮测试环境漏配协议版本，在注册时 422 拒绝，未创建任务；显式设置 `BB_E2E_TERMS_VERSION=local-integration-20261012` 后通过。测试源码 `apps/web/tests/local-material-input.spec.ts`，运行时需设置 `BB_E2E_LOCAL_INTEGRATION=1`、`BB_E2E_BASE_URL=http://localhost:5178`、`BB_E2E_BROWSER_CHANNEL=msedge`。真实本地截图和 JSON 证据位于共享 `evidence/material-input-feedback-20261013/`，不提交 GitHub。

## 用户验收

访问 **http://localhost:5178**，沿用 `integration_user` / `Local-Test-2026!`。刷新 → 材料生成 → 上传文件但不选择交易所 → 点击生成 → 检查缺项提示及定位 → 补填交易所 → 再点击生成。立项报告未填券商／模板时应一次列出相应缺项。用户正式点击生成后仍按已有动态积分规则执行，本轮自动测试没有生成新文稿。

启停命令保持：`node scripts/local-integration/start.mjs` / `status.mjs` / `stop.mjs`；使用现有 Node 22 运行环境。有活动任务时停止脚本会拒绝执行。来源 PR #699、集成草稿 PR #693，生产发布交统一发布 chat。
