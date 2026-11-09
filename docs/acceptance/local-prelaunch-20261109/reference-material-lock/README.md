# 参考募集书沿用材料只读状态

本轮修复正在编制和终态查看期间仍显示参考稿上传入口的问题。本目录六张截图均为 synthetic 项目、文件和 API 响应；真实客户截图保留在工作区外的私有质量目录。本轮只访问独立 Vite `5187/5188`，未访问或重启 `18087`，未对真实任务执行写操作。

## 固定版本与依据

- 源码基线：`03e7b3dab1dd8e70aaf90abdf79dd05dde52750d`；`before/` 为基线，`after/` 为该基线加本次未提交前端补丁。最终六个源码／测试文件哈希见 `source-sha256.json`。
- 真实截图对应运行版本由主验收记录确认为 `05ed9bc1`，本轮合成证据不表示此修复已经部署。
- 上传／采用原型：`product-prototype/public/prospectus-reference.html`，最后修改提交 `fe3022cb3244140a569d8a13fe9c8b27a35e938b`。
- 材料工作区原型：`product-prototype/public/project-workspace.js`，最后修改提交 `5b135ea4372384c6eace4191db46355e41342a4e`。
- 产品依据：参考募集书必填、上传即采用及现有材料锁定行为。原型中未运行的上传布局保持原样；运行和终态查看的参考稿现与其余材料共用执行区可编辑判定。

## 缺陷与修复

`#prospectus-panel` 位于普通材料的禁用 fieldset 之外。此前只在不确定提交期间设置 `inert`，开始任务后未收到材料只读状态；除上传大框仍可见外，拖放、晚到文件选择、采用和删除事件也没有同样的前端守卫。

执行区现在通过已有构造回调模式传递可编辑判定。参考稿组件在只读时隐藏上传说明、大框、编辑和删除入口，显示“本次编制材料已锁定，仅可查看和下载”。文件详情和原下载流程保留；各写入口及异步保存后重新校验只读状态。点击“继续修改”后，上传和版本管理恢复可用。无 API、契约、费用、worker 或下载门槛变更。

## 代表性对照

以下六图均为 `1440×960` 原始视口截图，定位到同一参考稿卡片。旧图由独立 `5188` Vite 从 `git show 03e7b3da` 只读加载本次涉及的四个前端文件，未覆盖共享源码；新图来自 `5187`。同一合成场景分别核对旧、新按钮状态后截图。

| 状态 | 基线 | 修复后 |
|---|---|---|
| 运行中 | [旧图](before/running-desktop.png) | [新图](after/running-desktop.png) |
| 失败只读 | [旧图](before/failed-desktop.png) | [新图](after/failed-desktop.png) |
| 继续修改 | [旧图](before/next-version-desktop.png) | [新图](after/next-version-desktop.png) |

六图已目视核对，无横向溢出。运行中与失败查看时只收起编辑入口，卡片及文件仍在原型位置；继续修改后上传框、原稿信息及下一轮准备流程恢复。未新增业务流程或修改业务规则。原型的未运行上传布局也经 `1440/390/320` 宽度对照；私有目录保留原型／实现图及全部状态截图。

继续修改后图另做 1/1 定向取证：原截图已通过 `toBeEnabled()`，但截到按钮 150 毫秒透明度过渡（`disabled=false`、opacity≈0.64）。现图等待 opacity=1 后拍摄；原图与前后 DOM 记录保留在私有 `button-state/`，没有修改按钮逻辑或新增任务。

## 回归结果

- 红：扩展 `project-execution.spec.ts` 的既有材料锁定用例，在 `#choose-prospectus-version` 的 `toBeHidden()` 断言失败，实际仍为 visible；原始失败图保留在私有证据 `red/`。
- 绿：同一回归通过，覆盖准备、运行、刷新重进、暂停、等待补充、失败、取消终态和继续修改。只读下晚到 change/drop 不写 API，原稿信息仍禁用，详情与下载可用。
- 补充组件回归：伪造点击仍不能采用或删除；晚到文件选择清空；刷新后保持只读；只读时真实浏览器下载返回合成原文件；解锁后可打开删除确认、采用旧版本并上传下一轮文件，且没有任务或账务请求。
- 完整 `prospectus-panel.spec.ts + project-execution.spec.ts`：**123 通过、1 跳过，5.2 分钟**。跳过项是已有环境变量控制的 `M2 deferred charge prototype screenshots`，不是功能失败。
- 最终定向复验：**8/8 通过，22.7 秒**，覆盖锁定、晚到事件、原采用下载、丢失快照恢复和原型截图。构建及最终 TypeScript 检查通过；构建只有既有大包体积提示。独立只读复核未发现可确认的回归。

验证命令（Windows、Microsoft Edge headless，API 全部由 Playwright route 模拟）：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5187'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_MATERIAL_LOCK_EVIDENCE_DIR='<私有证据目录>/final-states'
npm.cmd test -w @bondbuddy/web -- project-execution.spec.ts --grep 'authoring materials stay read-only'
npm.cmd test -w @bondbuddy/web -- prospectus-panel.spec.ts project-execution.spec.ts
npm.cmd run build -w @bondbuddy/web
```

其余证据位于工作区外 `quality-prelaunch-20261107/reference-material-lock-20261109/`，包括红图、全状态截图、原型对照和最终定向日志；临时合成取证脚本位于被忽略的 `.local/reference-lock-evidence/`。这些记录不代表真实模型任务、支付或生产发布验收。
