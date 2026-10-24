# 诚信核查底稿模板与整屏时间

本次修复诚信核查截图缺少右下角系统时间、Word 底稿结构不符合用户参考文件的问题。按用户要求先通过 BondBuddy 核查清单前 10 项并生成样稿。开发和自测完成；用户尚未验收，尚未部署，待统一集成与发布。

## 最终行为

官网采集在每次任务独占的 Linux 桌面运行 Chromium。截图包含浏览器和右下角原生任务栏日期、时分秒，时区为 Asia/Shanghai；截取整个 1440 × 1000 屏幕。时钟来自操作系统，不向网页注入时间，不在取证后叠加或拼接时间，也不捕获用户个人桌面。截图仅覆盖屏幕可见区域，未展示的内容、附件与后续页仍需补证。

Xvfb 使用随机 display、Xauthority cookie 和禁用 TCP 监听；浏览器继续启用 Chromium sandbox、官网域名限制、公共 IPv4 固定解析与受控代理。浏览器、窗口管理器、时钟和 display 在查询结束后关闭，临时文件随采集目录清理。启动失败或无法截图时保留待人工补证，不伪造证据。

Word exporter 使用从用户参考版式脱敏提取的可复用模板：A4 页面、原页边距和页眉横线、宋体正文、黑色两列表格、中文编号的汇总清单与查询记录，以及独立空白签字页。模板只保留格式和占位符；客户正文、历史截图、签名、个人姓名和原日期未进入模板或仓库。

每项记录保留查询词、可点击的完整查询 URL、北京时间、查询范围和证据支持的说明。未提交查询显示“拟查询词”；无法确认结果对应完整查询词时保持待人工补证。原始截图字节与比例不变，不裁切右下角时间。人工补证继续注明用户提交、未经独立核验，人员身份标识继续使用已遮蔽值。

## 验证证据

- `npm run build` 通过；`npm run check:examples -w @bondbuddy/contracts` 通过（171 个 synthetic、12 个 internal、4 个生命周期、29 个 OCR、11 个身份绑定样例）。
- Linux 定向测试通过：21 passed、0 failed、0 skipped。包括真实 Chromium 的 synthetic 官网 fixture、原生桌面时钟 OCR 与退出清理、证据边界，以及实际 API / PostgreSQL / Azurite / worker / Word exporter E2E。E2E 中模型为 synthetic；不代表真实模型效果验收。
- Python 模板测试通过：2 passed。验证两列表、原始图片字节、无裁切、北京时间、待补证语义、空白签字页、源样式与页眉页脚结构，以及模板占位符白名单和无保留媒体。
- 用户授权的前 10 项实际官网核查已走产品 API、持久队列、官方浏览器采集、证据存储、Word 生成、归档和授权下载；文件下载 SHA-256 与产品元数据一致。随后通过同轮免费重新导出应用最终排版，不重新查询或改写证据。
- 真实结果：1 项本次完整查询词未检索到相关结果，9 项待人工补证，留存 9 张整屏截图。部分页面访问失败，部分页面虽返回结果但不能确认完整主体匹配，另有 1 项未取得截图。没有将这些情况写成“未见异常”。本轮没有需要模型解读的可确认记录，未发生真实模型调用。
- 最终样稿渲染为 11 页，全部页面和 9 张右下角时钟已检查；文档、原始证据、客户名称和运行收据仅保存在用户本地，不进入 Git。

Linux 测试入口（隔离的本地 PostgreSQL、Azurite，测试变量须显式设置）：

```sh
BB_TEST_INTEGRITY_BROWSER=1 BB_TEST_INTEGRITY_DESKTOP=1 \
  node --test --test-concurrency=1 \
  apps/worker/dist/integrity-desktop.test.js \
  apps/worker/dist/integrity-browser.test.js \
  apps/worker/dist/integrity-evidence.test.js \
  apps/worker/dist/integrity-e2e.pg.test.js
PYTHONPATH=python python -m unittest discover -s python/tests -p test_integrity_report.py -v
```

E2E 还需 `BB_TEST_DATABASE_URL`、`BB_TEST_AZURITE_CONNECTION_STRING`、`BONDBUDDY_TEST_PYTHON`；使用空白测试数据库模板，不以真实核查数据库运行回归。测试进程不挂载真实模型凭据。

## 集成边界

没有数据库迁移、API 契约或账务规则变更。worker 镜像新增系统依赖 `xvfb`、`xauth`、`x11-utils`、`openbox`、`tint2`、`wmctrl`、`scrot`，需由统一发布流程重建镜像。正式镜像已有字体、Chromium、Python Word 依赖。

本轮使用独立本地容器验证实际后端流程，没有新增或更新用户网页验收入口。Docker Desktop 环境保留 Chromium sandbox、非 root、受控代理、read-only、cap-drop、no-new-privileges 和 seccomp；本地 mount 规则比仓库 profile 更收紧，Docker Desktop 不提供生产宿主 AppArmor 组合，因此完整生产宿主策略仍由集成/发布负责人验证。最终 Word 效果等待用户查看；不可把本地验证称为已部署或用户已验收。
