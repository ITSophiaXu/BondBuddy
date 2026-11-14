# 输出超限暂停与恢复：合成 UI 验证

2026-11-13，本机 Windows、Node.js、已安装 Microsoft Edge。真实 Vite 页面 + Playwright HTTP fixture；未连接真实 API、数据库、模型或生产，不含客户材料。开发与自测完成，用户验收及统一发布尚未进行。

## 版本与范围

原型与实现均从 `1e50c00725042710cbd29489d8825a79e74411db` 加当前工作区改动捕获；截图时尚未提交，不将 base commit 冒充最终候选版本。合并前由根任务登记最终候选 commit。当前文件 SHA-256：

| 文件 | SHA-256 |
| --- | --- |
| `apps/web/src/authoring-progress.ts` | `07551b8f88a6f17d99992693aab108e8b7e4dc0145a2e501027713859449da07` |
| `apps/web/src/authoring-status.ts` | `aae39a019be2efcd712aeb834465fd973f91fc3a925a9c35b4a3272e21b58830` |
| `apps/web/src/project-execution.ts` | `bf6c4369b2248500ee3a9540b175700c31bd0806ef45426dbe6e120b8c89db8a` |
| `product-prototype/public/authoring-live-progress.html` | `5898420b4116e26c2afb409b33aacaae458f97ee22e2f4c7263f678cf8726062` |
| `product-prototype/public/authoring-status.css` | `4ca9bb0cffb5bf632fefe3e4471997d4a90e751eb4dc235946503c5d2c15e059` |

已迁移页面：`apps/web/src/project-execution.ts` 的募集书全文更新任务状态。此次仅新增原型状态、文案和测试，不修改既有布局/CSS。

## 结果

- 前端单元测试编译通过；`authoring-progress.test.js`、`authoring-status.test.js` 共 18 个测试通过。
- 前端 `tsc --noEmit` 通过，包含 Playwright 测试类型检查。
- 相关 Playwright 测试初次 11/11 通过，耗时约 1.4 分钟；随后按 API 真实终态修正 fixture，受影响的 4 个 output-limit 测试再次全部通过，耗时 40.6 秒。补齐主动暂停撤销入口后，最终 5 个 output-limit 测试全部通过，耗时约 1.2 分钟，24 张截图已更新。
- 四个 output-limit reason 分别显示条件核对、已保存后排队、恢复进度未通过、自动恢复次数用完；后两者严格对应 API 的 `failed/failed`，显示“本轮未完成”，没有重试/停止操作，也不显示“关闭页面不会取消任务”。材料保留仅说明一次。
- 通用 `provider_evidence_unresolved` 只说明调用记录待核对，不断言进程仍运行或退出未确认。
- 恢复、排队、刷新保持同一 run、input hash 和 input revision，并保留第 3 步“编制募集书”。
- 旧任务无快照：取消确认不提交，连续两次确认只产生一次重试；请求明确携带 `restart_materials` 和 `confirmed_restart: true`。
- 旧任务同时存在用户暂停时，服务端 `resume` offer 显示“继续本次任务”，复用现有 `/resume` 操作，连续点击仅发一次；仅清除用户暂停后重新 GET 恢复条件，不自动发起 restart。页面刷新后仍需另点重试并明确确认原材料重新处理。
- 回执丢失后核对复用相同请求 ID；后端接收一次，不创建新任务。迟到排队回执不覆盖新成功状态；二次暂停仍如实显示暂停。
- 两种尺寸均无页面水平溢出。初次 20 张截图逐张查看，更新后重新查看受影响及新增代表截图，状态文字、按钮及步骤没有重叠或裁切。

## 同尺寸截图与差异

各状态有 `implementation-<状态>-<宽度>.png` 和 `prototype-<状态>-<宽度>.png`，桌面为 1440 × 1000，移动为 390 × 844，均为相同尺寸视口截图。较长页面可继续纵向滚动，视口外内容不代表被裁切。

| 状态 | 验证含义 |
| --- | --- |
| `output-pending` | 超出输出上限，仍在核对恢复条件，没有承诺工作快照已保存 |
| `output-queued` | 快照已保存，排队接续原任务，第 3 步仍为当前步骤 |
| `output-unavailable` | 恢复进度未通过核验，已停止自动重试并结束为失败 |
| `output-exhausted` | 自动恢复次数已用完并结束为失败，没有重试/停止操作 |
| `output-legacy` | 旧任务无快照，说明使用原材料重新处理且需明确确认 |
| `output-user-paused` | 旧任务用户暂停，继续操作只撤销暂停，随后重新核对并单独确认 restart |

现存差异如实记录，未声称逐像素一致或产品负责人已确认：

- 实现嵌入项目导航；原型含合成状态切换条，所以卡片位置、可用宽度及换行不同。
- 移动端原型按钮在说明上方，实现按钮在说明下方；此次未改变任一既有 DOM 布局。
- 实现重试条件为灰色辅助文字，原型使用普通正文；状态徽标图形也保留原有差别。
- 原型固定显示 3 份合成材料和演示时间，实现 fixture 显示 2 份合成材料及 fixture 时间。材料数、时间不作为真实执行证据。
- 原型旧任务确认用演示 `window.confirm`，实现使用原有有标题的 dialog；浏览器测试验证正式 dialog 的取消、确认和重复点击行为。

确认人：未取得额外产品确认；上述差异已向根任务报告。最终原型登记、PR 版本及用户验收由根任务和既定集成/发布流程处理。

## 复现命令

仓库根目录：

```powershell
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.test.json
node --test apps/web/dist-test/authoring-progress.test.js apps/web/dist-test/authoring-status.test.js
node node_modules/typescript/bin/tsc -p apps/web/tsconfig.json --noEmit
```

在 `apps/web` 启动独立本地测试服务器：

```powershell
node ../../node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5176 --strictPort
```

另一终端位于 `apps/web`：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5176'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_OUTPUT_LIMIT_UX_DIR=Join-Path (Get-Location) 'test-evidence/output-limit-recovery-20261113'
node ../../node_modules/@playwright/test/cli.js test tests/project-execution.spec.ts --grep 'output limit|payload recovery explains|paused status offers|legacy paused retry|retry unavailable|lost retry receipt|delayed accepted retry|accepted retry with a lost' --reporter=list
```

停止：在该独立 Vite 终端按 Ctrl+C。无需安装依赖；本次使用已有依赖和 Edge。此入口仅用于 UI fixture 验证，不是整套本地后端集成验收环境。
