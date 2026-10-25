# 北京诚信核查出口

仅把官网 HTTP/HTTPS 请求经加密 SSH 通道送至北京。Azure 上的 API、数据库、证据存储、Word 生成和 Codex CLI＋DeepSeek 保持原配置；北京节点不保存这些凭据。网站看到北京实例公网 IPv4。北京 IP 不能保证通过验证码或网站风控，首页 HTTP 200 也不等于查询完成。

这是一份待集成验收的发布配置，不是已上线声明。依照用户 2026-10-12 规范，由指定发布 chat 固定集成版本、确认用户验收、取得本批上线授权后执行。不要与 `compose.integrity-browser.yaml` 同时使用。

## 发布前提

- 两端部署同一固定 SHA 的镜像。北京仅运行 `deploy/m1/Dockerfile` 的 `integrity-egress` target；Azure 新增由本目录 `Dockerfile.tunnel` 构建的隧道镜像。4 GB 北京实例不运行完整业务栈。
- 合入的浏览器/底稿依赖包含迁移 `0116_integrity_browser_evidence.sql`，worker 镜像内需要真实 Linux 桌面、Chrome sandbox 和北京时间任务栏。迁移与服务变更由统一发布处理。本次不新增数据库迁移。
- 在腾讯云控制台确认目标实例、北京地域、公网 IP 和 SSH Ed25519 主机公钥；通过可信控制台比对 SHA256 指纹，再写入 Azure 的 `known_hosts`。不能用 `StrictHostKeyChecking=no` 或未经核验的 `ssh-keyscan` 替代。
- 使用仅供隧道的 `bb-egress` 账号和独立密钥。如无现有授权连接，新增账号/公钥权限须单独完成安全确认。账号禁用密码，不能取得交互 shell。密钥行限定为 `restrict,port-forwarding,permitopen="127.0.0.1:3129",command="/usr/bin/false" ssh-ed25519 ...`。在 sshd 的该用户 Match 块设置 `AllowTcpForwarding local`、`PermitOpen 127.0.0.1:3129`、`AllowAgentForwarding no`、`X11Forwarding no`、`PermitTTY no`。确认当前 OpenSSH 支持，并先 `sshd -t`；不要更改其他用户的登录策略。
- 腾讯云安全组仅允许经过核对的 Azure 出口地址访问 TCP 22。不要开放 3129。若源地址不稳定，先明确维护方案，不扩大到全网。
- Azure 密钥目录由 UID 10001 读取，目录 `0700`、私钥 `0600`、known_hosts `0644`，不纳入 Git、镜像、日志或浏览器页面。环境变量 `BB_INTEGRITY_SSH_DIR` 指向该目录。

## 统一上线顺序

1. 记录现有版本、Compose 展开配置、活动任务、数据库备份和回滚计划，取得同一生产部署锁。
2. 北京执行本目录 `compose.egress.yaml`，仅绑定 `127.0.0.1:3129`；在主机确认监听和容器健康。代理无业务凭据，仅允许注册表内官网域名及 DNS 解析后的公网 IPv4，拒绝私网和云元数据。
3. 设置 `BB_IMAGE_TAG`、`BB_INTEGRITY_SSH_DIR`、`BB_INTEGRITY_BEIJING_HOST`。先 `docker compose ... -f compose.integrity-beijing.yaml config` 审阅，再部署隧道和同批 worker；其他基础 overlay 按现有发布流程保留。
4. 在独立验收环境查询公开样例，验证 HTTPS 校验、证据哈希、完整桌面截图和 Word 下载。停止隧道后请求必须失败，不能回退 Azure 直连。健康检查只验证 SSH 本地监听，不代表官网可查询。
5. 上线后执行一轮正常查询，核对每项查询结果/阻碍、证据截图、待补证状态与可下载底稿。不要自动绕过验证码、登录限制、风控或循环重试。

## 回滚和边界

保留旧 worker 镜像及完整原 Compose 配置；出现故障先停止接收新核查任务，处理活动租约，按部署锁回滚 worker/出口配置。保留已保存的证据和底稿，不删除数据库记录、不自动降级成无风险结论。北京代理与隧道可独立停止；移除密钥/账号前确认不再使用。

三个官网的真实样例测试不能代表全部 54 个站点可用；模型仅解释已保存、可核对的查询正文，联网采集本身不交给模型自由搜索。本文不修改任何 Codex CLI、DeepSeek、账务或模型网关设置。
