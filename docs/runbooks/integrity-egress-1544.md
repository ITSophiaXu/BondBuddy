# #1544：受控官网出口定位与发布前验证

## 当前证据（2026-11-17）

执行节点 `ins-p4i0pcub`（私网 `10.73.7.17`，安全组 `sg-43pbfq0p`）
多次连接主站 `10.2.0.5:15435` 超时；同期 15432（PG）、15434（模型代理）可用。
主站 15435 监听和 127.0.0.1:3129 官网代理存在，本机 SSE CONNECT 为 200。
主站 UFW 未启用、INPUT 为 ACCEPT，现有自定义链仅有 SSH 拒绝规则；
官网 mTLS unit 的 IPAddressAllow 包含 `10.73.7.0/24`。
这些证据将故障边界定位在节点到主站专用通道，尚未确定具体云端拦截规则。

只读 DescribeInstances 确认该节点当前为 STOPPED；未为诊断启动节点。
维护 API 身份读取安全组和 Lighthouse 防火墙均被 IAM 拒绝。用户已批准改用
已登录控制台只读查看，但浏览器自动化持续返回 Windows GetCursorPos 拒绝访问，
包括用户确认解锁后。不能由这些限制推定云安全组已经定位或修复。

## 缺失的验证与本次工具

既有浏览器 smoke 使用 `network=none`，只能证明页面创建、渲染、截图；
既有 PG preflight 只能证明数据库通道。两者都不覆盖新增的 15435。
`integrity-egress-probe.mjs` 补齐独立通道验证：分别探测三条 TCP 通道，
再经容器实际官网代理发出 SSE 的 CONNECT。每次连接有 4 秒绝对上限，
最多读取 8 KiB 响应头；无自动重试，不读取凭据、不创建业务任务、不输出响应正文。

由维护者在实际 authoring 容器身份/网络中执行，脚本可从 stdin 传入而无需
修改运行容器文件（先核实际 container ID，不用历史名称代替当前实例）：

```sh
docker exec -i <authoring-container-id> node --input-type=module - --run \
  < deploy/tencent-elasticity/integrity-egress-probe.mjs
```

输出 `transport_ready=false` 或退出码非零时，官网通道验证失败，不能签发诚信
功能已恢复的凭据；不因此停止其他已经在途的业务。TCP 不通仅标记
`node_to_main_transport`，TCP 通而代理未返回 200 标记 `mtls_or_official_proxy`。
始终保留 `specific_network_rule_verified=false` 和 `official_query_performed=false`。
CONNECT 200 不是实际官网查询成功。

## 完成修复仍需的步骤

1. 使用具备既有权限的运维控制台/API，读取实际安全组出入站规则、子网 ACL、
   私网互联路由与主站对应规则，记录顺序、作用方向和原始证据。先确认哪层
   拒绝 `10.73.7.0/24 → 10.2.0.5 TCP/15435`，不能直接全端口放行，
   也不能凭历史配置文件断定云端现状。
2. 为实际缺口准备准确单条规则差异与回滚前像，经统一发布执行。保留 mTLS、
   官网白名单、无公网节点及原 PG/模型通道。新规则应覆盖获审执行子网内的
   现存和未来节点，不绑定一次性的容器 IP。
3. 按正常启动/登记流程获取节点、epoch、运行版本和通道配置；用上述工具在
   实际 authoring 网络验证，不以主站本机或停止节点的历史结果代替。
4. 专用新轮次逐站真实打开、查询、保存截图，验证 Word/导出、归属与授权下载、
   失败释放和成功结算。未查询不能计为无记录；原用户失败任务与证据保持，
   未获授权不重投。CDP 修复状态与本单网络问题分别记录。

本次交付仅补齐有界诊断和发布验收缺口，**不是已恢复生产网络的修复**。
#1544 保持 Open；实际规则修复、同身份官网查询和成果/结算验收仍未完成。
