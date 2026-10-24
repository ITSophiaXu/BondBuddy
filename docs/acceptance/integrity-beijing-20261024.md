# 北京诚信核查出口接入

开发代码和定向测试完成，尚未部署，待统一集成验收与发布。不能将本文件或一次官网访问成功理解为用户已经验收。

本批在 `ffd637fac6c1fdf1581112e728f21ec29a94c67c` 基础上保留现有整屏系统时钟与参考 Word 模板。新增北京节点 loopback 发布配置和 Azure 侧受限 SSH 隧道 overlay，保留 Codex CLI、DeepSeek、数据库、存储和底稿生成位置；修复法院专项名称框不应追加主题关键词的问题。通道不可用时请求失败，不自动回退境外直连。

## 本地验证

- Linux 后端工作区编译通过：contracts、domain、rule-pack-registry、rule-applicability-context、API、worker。
- 契约检查通过：171 个 synthetic、12 个 internal、4 个数据生命周期样例，29 个 OCR 测试和 11 个主体绑定测试。
- 独立 PostgreSQL 和 Azurite，真实 API、队列、worker、证据读写、Word 生成与授权下载 E2E：定向测试合计 24 passed，0 failed，0 skipped。该组官网和模型使用 synthetic fixture，不表示真实 DeepSeek 联调已经通过。
- Python Word 模板测试 2 passed。验证原始图片字节、签字页、模板内容边界及待补证措辞。
- 两个新增 Compose 文件展开检查通过；没有启动生产服务。SSH 隧道尚无两端实际连通证据，需建立受限认证后验收。
- 完整前端打包未通过：复用的 Linux QA 镜像缺少 rolldown 的平台原生可选包；npm ci 另出现 `Exit handler never called`。本批没有前端修改，后端编译和上述必要定向检查通过。不能把本次称为完整集成版验收通过。

## 北京真实采集

在用户授权的北京腾讯云节点执行新版产品采集器，通过同机独立官网出口代理和有 sandbox 的官方 Chrome 正常查询一次。使用公开企业样例，未提交私有标识，不绕过 CAPTCHA、登录或风控。保存三张带原生北京时间任务栏的完整截图及页面文字，原始文件与样本底稿仅留在本聊天本地输出，不进 Git。

国家税务总局的完整名称站内搜索返回 30 条相关结果；已保存页面主要是涉税服务及分公司新闻，不能当作不良记录，也不能当作专项数据库无记录结论。法院失信页面无法确认结果对应本次名称，信用中国访问失败，均待补证。本轮没有调用 DeepSeek；它验证真实北京采集，不代表跨云 worker 和模型完整联调。

## 发布交接

按 `deploy/beijing/README.md` 完成可信主机密钥核验、独立隧道账号/密钥、限定源 IP 的 SSH 访问和本地集成验收。当前既有 Azure SSH 连接尝试被远端重置，未改生产连接配置。专门发布 chat 需在用户确认本批后，持部署锁固定集成 SHA，处理合并依赖的 `0116_integrity_browser_evidence.sql` 与 worker 镜像，记录回滚配置并核验实际 Word 下载。

三站样例不代表全部 54 个站点均可用。生产宿主 AppArmor 与跨云路由需在目标环境核验；本地 Docker Desktop 验证保留非 root、read-only、cap-drop、no-new-privileges、seccomp 和 Chromium sandbox，但不能替代生产宿主验证。
