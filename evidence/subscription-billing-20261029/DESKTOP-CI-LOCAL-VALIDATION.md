# Desktop journey 本地补验

2026-10-29。基线提交 `172b6a4`；本次只修改 `apps/web/tests/consistency-confirmation.spec.ts` 的测试断言，没有修改生产 Web 代码，也未重新构建共享 dist。

## 最终结果

Windows 本地 Edge，独立 Vite `127.0.0.1:5193`，按 Desktop workflow 对应 8 个文件执行，**75/75 通过，0 失败、0 跳过，2.4 分钟**。最终日志：`completion/desktop-ci-eight-journeys-edge-final.log`。

- `prospectus-panel.spec.ts`
- `prospectus-selection.spec.ts`
- `prospectus-saved-reentry.spec.ts`
- `file-consistency.spec.ts`
- `consistency-confirmation.spec.ts`
- `review-editor.spec.ts`
- `review-editor-recovery.spec.ts`
- `review-flow-editor.spec.ts`

这些用例采用已有合成、封闭的 HTTP fixture，没有连接真实模型、支付渠道或生产用户数据。既有费用确认与免费检查文案属于旧目录／旧任务兼容场景，不代表新自动扣费界面。

## 首轮发现与修正

首轮 `completion/desktop-ci-eight-journeys-edge.log` 为 69 通过、5 失败、1 原有可选截图收集器跳过。5 个失败均来自 int64 协议迁移后的测试层次混用：浏览器缓存和 HTTP 中的 `expected_points` 为字符串 `"9000"`，合成服务为了复用旧领域断言将其解码成数字 `9000`，测试却直接比较两者。

修正后，测试将缓存与原始 HTTP 请求体比较；另明确断言第一份真实 HTTP 请求体符合公共编码器，并断言重开页面后的第二次真实请求体与第一份完全一致。原有领域请求幂等、仅一份回执、仅一个批次、只验证一次新请求等断言全部保留。没有放宽生产协议，也没有跳过失败用例。

最终轮显式启用了原可选截图收集器，输出在 `completion/desktop-ci-captures/`，从而全部 75 个用例实际执行。选中两份文件的截图已目视核对，原范围、文件版本、原费用和确认按钮可读。

## 复现

工作目录为 `apps/web`，使用现有稳定构建和另行启动的 Vite：

```powershell
$env:BB_E2E_BASE_URL='http://127.0.0.1:5193'
$env:BB_E2E_BROWSER_CHANNEL='msedge'
$env:BB_CONSISTENCY_CONFIRMATION_EVIDENCE_DIR='<工作区>/evidence/subscription-billing-20261029/completion/desktop-ci-captures'
npx playwright test prospectus-panel.spec.ts prospectus-selection.spec.ts prospectus-saved-reentry.spec.ts file-consistency.spec.ts consistency-confirmation.spec.ts review-editor.spec.ts review-editor-recovery.spec.ts review-flow-editor.spec.ts
```

本记录是本地 Edge 对应测试文件的补验，不将远端未启动的 GitHub CI 作业标记为通过。远端执行状态与恢复条件由主任务记录。
