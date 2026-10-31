# 底稿 ZIP 下载等待反馈

代码和原型版本：`73f3cb60`。基线：`6efbb5fc`（develop）。关联已迁移前端：#361 的文件生成／批量底稿结果页；前一轮下载与导航修复：#853。

## 问题与行为

用户反馈 248 份文件下载前“正在准备下载”持续超过两分钟，随后成功下载。页面的 248/248 是生成进度；ZIP 在点击下载后才读取已生成文件、校验并打包，最后传给浏览器。原来的 202 响应只有 `status: preparing`，客户端在准备阶段没有数量变化或等待时长。当前这次下载没有逐阶段耗时记录，不能把全部两分钟归因于某一个阶段。

本次在原下载按钮下补充独立反馈：

- 立即显示活动条、累计等待时间和“文件较多时可能需要几分钟”。
- 202 返回可选 `progress: { phase, completed_files, total_files }`。数量只在文件读取、长度和 SHA-256 校验通过后增加；重复轮询复用同一次准备工作。
- 读取阶段显示真实文件数；全部读取后显示“正在完成打包”和移动指示；不把文件数比例当成总下载百分比或预计剩余时间。
- ZIP 响应开始后切换为传输进度。已知长度显示真实字节比例；未知长度显示已接收大小和活动条。
- 等待 30 秒显示较慢提示。完成、失败和离开页面均停止计时；完成后保留原有“保存文件”链接。离开页面继续可用，并提示会停止本次下载。
- 兼容旧 API 的 `{status: preparing}`；没有数量时只显示活动和时长。异常数量不能显示成可信进度。

没有迁移、新依赖、worker 或积分变更。授权、文件固定版本、缓存容量、取消和超时边界保持原有行为。要显示文件数量需统一发布 web 与 API；仅更新 web 也可使用兼容等待提示。

## 验证

- contracts 构建及现有底稿契约测试：4/4。
- API、web TypeScript 检查和 Vite 构建通过；Vite 仍有原有大包体积提示。
- API 下载与 ZIP 测试：12/12。覆盖真实临时文件、ZIP 内容校验、248 份合成 DOCX、归属、缓存、失败重试、取消及准备计数。数据库与存储元数据使用测试夹具。
- 浏览器原相关套件 26/26；补充手机传输场景和等待动画后，受影响 7 项复验通过，合计 27 个不同用例。覆盖两分钟等待、旧响应、错误计数、未知总长度、减少动画偏好、保存链接及导航。
- PostgreSQL/Azurite 测试的 202 断言随契约更新，本次未重跑该环境；没有连接生产数据库或执行真实模型生成。
- 两个早期验证失败已排除：原超时测试只睡固定时间、未等文件清理完成，现改为等待实际失败；一次原型测试从仓库根启动导致路径错误，按 apps/web 工作目录复验通过。

## 原型与实现对照

原型：`product-prototype/public/workpaper-batch.html?download=preparing|packaging|transferring|initial|ready`。合成场景用于展示交互，不冒充真实后端进度。原型和实现均为上述代码版本。

同尺寸截图（1440×960、390×960）保存在 `apps/web/test-evidence/workpaper-download-progress-20261031/`：

| 场景 | 原型 | 实现 |
| --- | --- | --- |
| 文件准备，桌面 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-preparing-1440.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-preparing-1440.png) |
| 文件准备，手机 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-preparing-390.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-preparing-390.png) |
| 整理文件包，桌面 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-packaging-1440.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-packaging-1440.png) |
| 整理文件包，手机 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-packaging-390.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-packaging-390.png) |
| 文件传输，桌面 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-transferring-1440.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-transferring-1440-true.png) |
| 文件传输，手机 | [原型](../../apps/web/test-evidence/workpaper-download-progress-20261031/prototype-transferring-390.png) | [实现](../../apps/web/test-evidence/workpaper-download-progress-20261031/implementation-transferring-390-true.png) |

逐屏检查：反馈位置、文案、文件数与传输分离、移动指示、配色和移动端换行一致，无横向溢出、遮挡或裁切。实现保留已有应用导航和真实数据入口；原型的说明栏、示例日期／版本和手动场景链接是演示设施。新增反馈没有已知的原型偏离；用户尚未进行视觉或集成验收。

## 交付状态

开发和自测完成。代码完成，尚未部署，待统一发布。尚未形成统一的本地集成验收批次，用户未验收，本 chat 未执行部署或生产网络变更。
