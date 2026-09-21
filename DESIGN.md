# BondBuddy 新产品设计与官网

这两个目录供开发同学查看新产品的 UI、交互流程及实现，并在同一 Git 仓库中持续迭代。

| 目录 | 用途 | 启动与预览 |
| --- | --- | --- |
| [product-prototype](product-prototype/README.md) | 新版 BondBuddy 工作台：Dashboard、募集书编制与复核、材料生成、项目问答、募集书库、套餐 | 进入目录执行 `npm start`，打开 `http://127.0.0.1:4320/#dashboard` |
| [landing-page](landing-page/README.md) | “BondBuddy — 债券项目的 AI 工作搭档”官网 | 进入目录执行 `npm start`，打开 `http://127.0.0.1:4321/`；也可直接打开 `public/index.html` |

两者初次归档日期为 2026-09-21，来源是设计者本地 `bondbuddy` 应用。仓库根目录的 `backend/`、`web/` 和 `deploy/` 继续保存现有线上 Cowork 应用。两个设计目录独立启动；本次归档不发布网站，也不替换线上应用。

开发交接从 [新产品体验导览](product-prototype/HANDOFF.md) 和 [官网说明](landing-page/README.md) 开始。完整代码、业务知识文本、测试源码和官网插图生成脚本均在对应目录中；本机账号、密钥、历史任务、上传材料和测试生成物不进入仓库。

后续直接修改对应目录，更新各自的 `CHANGELOG.md` 并提交 Git。产品与官网的版本独立记录；需要稳定分享时可以使用 `prototype-v1.6.0`、`landing-v1.0.0` 这样的 Git 标签，而不用重复复制整个目录。这里列的是命名建议，本次未创建标签。
