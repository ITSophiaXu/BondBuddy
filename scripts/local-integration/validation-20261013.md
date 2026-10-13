# 2026-10-13：本地集成版纳入操作栏滚动修复

用户明确要求把开发 PR #694 纳入现有本地测试。集成 chat 当时空闲，工作区干净，远端 #693 的 head 与本地 `facae54d45be3a3dd6059909fc0868a42af22317` 一致。仅 cherry-pick 已提交的两个来源：

| 来源 | 集成提交 | 内容 |
|---|---|---|
| PR #694 `55fe62c1ff7857e9513462177663069d97cd5fe0` | `14e2663` | 删除操作栏吸附定位；记录用户新的显示要求 |
| PR #694 `87c061ddfa719dca20715f6e09570c10ce3a7639` | `7058471580a01084f0f1a77fe8c324661ed66728` | 开发自测与原型对照证据 |

本次验证源码快照为 `7058471`，本文之后的提交只补交接文档。API/worker 产品基线仍为 `6cd5d2cb`，本地工具及生成链路保留 `facae54d`。运行中 Vite 直接加载本工作区源码，新 CSS 已通过真实 HTTP 获取和浏览器计算样式核对。没有重启服务、迁移数据库、重建 worker 镜像或发起模型调用。

## 实际验证

- 浏览器真实登录原本地测试账号，读取已有合成示例项目 `53a40522-9188-4e31-99f9-0efaf743353f` 的两份材料及补充说明。没有模拟或拦截 API，没有提交新的生成任务。
- 1440×960 和 390×844，刷新后分别检查页首、页中、页尾，共 6 组检查通过。操作栏计算样式均为 static，与材料/补充说明区域相隔 20px；页首/页中不出现在视口，页尾完整显示，没有横向溢出。
- 两种尺寸均实际点击“上一步”并返回材料页，材料恢复、开始按钮可用；没有页面脚本错误。
- 原样式文件 SHA256：`0512a0c901e5ef0c9fa9d4fcfce259e8cea246dd1e2ca1a9fb3ca67cd5621baa`；网页 TypeScript 检查和 Vite 构建通过。保留既有单包大于 500 kB 提示。
- Windows 下 Node 22 便携程序在沙箱中无法启动，编译使用可运行的 Node 24.19.0；运行中服务继续使用原 Node 22.14.0。Docker 状态在沙箱内无法读取，申请额外权限后只读确认五项服务、API readiness 和原 Linux worker 全部正常，ready=true。没有将沙箱读不到 Docker 的结果当作 worker 故障。

证据保存在共享运行目录 `work/local-integration-runtime-20261012/evidence/footer-20261013/`：`verification.json`、`live-1440-top.png`、`live-1440-bottom.png`、`live-390-top.png`、`live-390-bottom.png`；状态见 `footer-status-before-20261013.json` / `footer-status-after-20261013.json`。开发阶段的其他尺寸、3 项既有浏览器回归及 contracts 证据随本次 cherry-pick 一并保留。

## 验收入口与状态

打开 http://localhost:5178，使用原账号 `integration_user` / `Local-Test-2026!`。进入更新募集书材料页，刷新后向下滚动；“上一步 / 开始编制”应只随填写内容在底部出现。也可直接打开上述示例项目的 `?step=materials` 页面。

启停方式仍见 README，无新增依赖或迁移。`services.json.productCommit` 记录原后端产品基线；本次网页源码增量以本记录、共享交接文件及 `frontend-version-20261013.json` 为准，不把旧 worker 镜像标成新前端提交。

状态：开发和自测完成；本地集成版可验收；用户尚未验收；尚未部署。既有最小真实生成验证保留，本次没有重跑模型或扩大到完整募集书质量验收。
