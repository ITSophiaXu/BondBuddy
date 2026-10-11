# 八项改动统一候选验证

运行源码为 develop `c70b91e9609f83fa489d40d8e159246e2df69470`；与 master `789d31cf` 合并后没有运行代码冲突或差异。发布清单、数据库迁移和回滚规则见 [统一发布说明](../../../../deploy/m1/releases/2026-10-11-unified.md)。

本次使用独立工作区与其生产构建，Node 22.14.0、Windows、Edge，地址 `http://127.0.0.1:54324`。全部业务 API、模型与文档为 synthetic；账务/暂停测试使用独立本地 PostgreSQL，未访问生产账号或真实模型。

助手原型与实现均来自同一运行源码版本。桌面 1440×960、手机 390×844。原型使用简化背景；实现保留真实导航和原生滚动条槽。侧栏位置、正文让位、关闭后按钮恢复、未发送文字保留均一致，未增加产品流程偏离。

| 场景 | 原型 | 实现 |
| --- | --- | --- |
| 桌面展开 | [原型](assistant/prototype-open-desktop.png) | [实现](assistant/implementation-open-desktop.png) |
| 桌面收起 | [原型](assistant/prototype-collapsed-desktop.png) | [实现](assistant/implementation-collapsed-desktop.png) |
| 手机展开 | [原型](assistant/prototype-open-mobile.png) | [实现](assistant/implementation-open-mobile.png) |
| 手机收起 | [原型](assistant/prototype-collapsed-mobile.png) | [实现](assistant/implementation-collapsed-mobile.png) |

另保存 1280px 的 [更新页](assistant/implementation-update-1280.png) 和 [复核页](assistant/implementation-review-1280.png)，验证侧栏与业务页并排。其他功能的已确认原型和原始截图保留在各自的 test-evidence 目录，整合未重新设计页面。

已通过全仓 build、公共契约、91 项页面单元测试、27 项批注测试，以及 42 项后台定向测试。原有依赖 Azurite 的完整队列测试跳过一次，未计为通过。

浏览器首次运行 147 项：138 通过、3 失败、6 项可选旧截图采集跳过。三个失败是旧测试假设与当前产品决定冲突，修正为桌面正文让位、手机全屏和已开放材料模块行为后，定向补跑 3/3 通过。最终验证覆盖 141 项通过、6 项跳过；没有重复全套或抹掉首轮失败。运行源码与首次验证完全相同，只有测试断言被更新。

前端构建资产：`index-DQ4QG5iN.js` / `index-CBZ2shcf.css`。打包已显式设置 Linux 目录 0755、文件 0644；产物 SHA-256 为 `f608a774c7328a538d480e6a23e92190f8ee1fe4c6b6eb57bb801b74f1a2e1b0`。这份静态包需要与同一版本的 API、worker 和账务迁移一起发布。
