# 账号页精简验收

用户 2026-10-08 提交的两张截图及其文字要求为本次交互依据。原型页面为 `product-prototype/public/account-credits.html`，原型基线及实现基线均为 develop `4c32f8c0e0d28894128a535000f9b6acb5452e83`。本目录对应实现和原型的提交号见本 PR 的源码提交。所有截图使用 synthetic 账号 owner_a、合成手机号及合成积分，未修改真实账号或计费数据。

## 变化及原型对照

| 项目 | 原型基线 | 本次实现 | 依据 |
| --- | --- | --- | --- |
| 基本信息 | 用户名、电话及五行其他信息 | 仅账户名、绑定手机号 | 用户明确要求两项基本信息 |
| 低频操作 | 五个常驻折叠卡片 | 单一账号设置入口，弹窗内保留功能 | 用户要求图 2 区块不必展示；实现采用弹窗收纳 |
| 积分预留 | “任务占用”，含零值 | 非零才显示“进行中任务预留”及说明 | 对用户关于含义的疑问作显示澄清，不更改账本 |
| 小屏 | 信息在充值卡片后 | 基本信息优先显示 | 本次精简布局适配 |
| 用户名修改 | 只读登录名 | 仍只读 | 已向用户说明当前无修改能力 |

- `prototype-before-1360.png` / `implementation-account-1360.png`：1360×900 视口，同尺寸全页对照。
- `prototype-before-390.png` / `implementation-account-390.png`：390×844 视口，同尺寸全页对照。
- `prototype-after-1360.png` / `prototype-after-390.png`：更新后静态原型，已实际打开并检查账号设置按钮和 Escape。
- `implementation-account-zero-1360.png`：预留为零时不显示预留说明。
- `settings-mobile.png`：手机端账号设置弹窗。浏览器检查包含修改密码和会话管理，桌面/手机均无横向溢出。

已有静态原型的旧侧栏样式与当前实现侧栏不同，保持在此前版本范围内；本次未重写工作台或侧栏。低频功能仍可从账号设置访问，旧充值订单上下文和数据说明链接保留。

## 验证

Windows / Node 22.14.0 / Playwright Chromium / synthetic API fixtures。

- `npm ci --ignore-scripts --no-audit --no-fund`。
- `npm run build`：全部工作区构建通过。首次单独构建 web 因新工作区尚未生成 API/domain 的 dist 失败，按仓库顺序完成全仓构建后通过。
- `npm run check:contracts`：契约样例和所带 40 项契约测试通过。
- `BB_E2E_BASE_URL=http://127.0.0.1:5188 npm test -w @bondbuddy/web -- account.spec.ts data-policy.spec.ts`：10/10 通过。
- 调整手机基本信息排序后，定向复测 unified account 场景 1/1 通过，并再次构建 web。
- 覆盖两项信息展示、零/非零预留、打开/关闭/Escape/焦点返回、密码输入/错误/成功、会话撤销、注销阻断/确认/多窗口退出、充值订单返回项目、旧数据说明深链接。
- `account-live.spec.ts`、`account-recovery-live.spec.ts` 同步适配新入口；本次未运行需要独立数据库的真实接口测试。无 API/数据库/鉴权实现修改。

尚未部署，未执行真实用户账号的密码修改、注销或计费。
