# 项目名称自动生成（#361）

用户于 2026-10-11 根据更新募集说明书创建页截图确认：必填标记移到项目基本信息，项目名称由发行人生成。对应产品决定 docs/product-decisions/2026-10-11-project-auto-name.md。

基线：develop 0359a4b4；原型 project-workspace.js / .css。原型与实现源码均随本 PR 提交。

## 同尺寸对照

| 视口 | 原型 | 实现 |
| --- | --- | --- |
| 1440 × 960 | [原型](prototype-1440.png) | [实现](implementation-1440.png) |
| 390 × 844 | [原型](prototype-390.png) | [实现](implementation-390.png) |

原型测试只加载项目基本信息模块；实现截图保留现有导航、助手入口和后续选填分区。对照范围为基本信息中的标题、发行人、只读名称、市场/方式及报告期；这次不调整页面其余布局。用户确认的偏离为发行人先填、名称自动展示、必填标记移至标题。桌面双列、手机单列且长名称换行，无水平溢出；已有项目保留原名称和可选编辑。

## 验证

Windows / Node 22.14 / Edge；使用 synthetic API 和合成发行人，无真实模型调用或扣费。

- npm run build：通过。最初仅构建 web 缺少其他工作区类型产物；完整依赖顺序构建后通过。
- npm run check:contracts：通过。
- draft.spec.ts、project-conversation.spec.ts、prototype-workflow.spec.ts（排除旧的 unavailable modules 场景）：31 项通过。首次旧工作台选择器失败，改为当前三个入口及具名导航后该场景复验通过。
- project-auto-name-prototype.spec.ts：1 项通过。
- 覆盖空白发行人不提交、仅发行人即可创建、市场/方式实时更新、不兼容方式清除、长 Unicode 名称、保存重开、旧自定义名称不被发行人编辑覆盖。

未运行依赖独立 API/数据库的旧 live 测试；未把合成界面验证当作真实供应商或专业内容验收。此改动只涉及网页与原型，无契约、数据库、worker 或费用变化。
