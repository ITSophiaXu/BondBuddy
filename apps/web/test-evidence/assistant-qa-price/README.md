# 项目助手固定问答积分（#612 / #361）

用户2026-10-09明确批准「按60积分／问题上线」。原型与实现源码 commit：`7722ead4485ed92130e8ba10a668c4927074dcfb`。

- 原型：`product-prototype/public/project-assistant-refined.html`；实现：`apps/web/src/project-assistant.ts`。
- `prototype-panel.png` 与 `implementation-panel.png` 均在1440×960视口截取480×736面板，使用同一句合成问题。两边展示准确60积分、成功扣费／失败免费及再次发送确认，无布局或文案偏离；仅输入焦点描边状态不同。用户为价格和交互方向确认人。
- Edge：`QA_PRICE_EVIDENCE=1 playwright test tests/project-assistant.spec.ts tests/dashboard-status.spec.ts`，9 passed / 1旧视觉截图用例未重复运行。API为synthetic fixtures，不作为真实模型或原账号验收。
- 本地PostgreSQL：固定QA（含无成本率、价格版本变化、钱包不足、成功精确一次扣60、失败与取消释放）、M4工作区及固定文书计费共6 passed；无客户数据。
- worker stages使用已安装Python：20 passed / 1 Windows软链接用例跳过。完整Linux管线与Blob集成由PR CI执行，本机未运行Azurite管线。首次Python路径缺失与Vite服务未运行导致的环境失败已修正并重跑，未修改断言。
- 完整build与contracts通过；migration0101已在全新隔离库应用成功。生产真实模型问答、线上价格登记和扣费证据在#612另行登记。
