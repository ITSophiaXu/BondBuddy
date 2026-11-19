# 重新启动与卡片轮询竞态（#1651）

在准备#1645上线候选时，真实业务页面在重新登录后的恢复操作停留于paused；GET期间状态卡片被轮询替换，原root.isConnected变为false，操作被当成页面离开。POST期间替换卡片还会丢失状态反馈。候选未部署。

新增两个确定性Chromium反例，原实现2失败；修复后全部21项浏览器专项通过，包括读取与提交期间替换卡片、真实路由变化、账号变化、卡片移除、核对类暂停、响应丢失及窄屏。专项使用真实前端模块和HTTP夹具，不冒充真实模型验收。

修复以同一账号、同一URL和同一run的当前卡片判断操作是否有效，允许轮询产生的新卡片承接操作及反馈；导航、账号切换和没有替代卡片时仍取消。仅前端变更，无API、worker、迁移或收费变化。

命令：在apps/web运行 BB_E2E_BASE_URL=http://127.0.0.1:5549 node ../../node_modules/@playwright/test/cli.js test tests/task-restart.spec.ts --workers 1。原实现两项polling card replacement失败，修复后21 passed。

代码尚未部署，待发布候选复验及现行发布门禁。
