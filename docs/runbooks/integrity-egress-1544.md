# #1544：受控官网出口定位与发布前验证

## 当前证据（2026-11-17）

执行节点 `ins-p4i0pcub`（私网 `10.73.7.17`）只绑定安全组
`sg-43pbfq0p`。控制台出站列表原来只允许到 `10.2.0.5/32` 的
22、3128、15432、15434，缺少 15435。用户截图确认在北京时间
22:50:38 增加了到 `10.2.0.5/32 TCP:15435` 的允许规则。

规则添加后的真实只读验证仍未通过：

- 22:55:24 宿主机 TCP：15432/15434 分别 2/0 ms 连接，15435 4004 ms 超时。
- 22:59:56—22:59:59 节点 eth0 连续发出到 15435 的 SYN；主站同期抓包
  未收到这些包。15434 的同一组源端口/序列号在两端均可对应，正常收到 SYN-ACK。
- authoring 容器 `c4c10e20b572` 经 `172.28.61.1:15435` CONNECT 仍超时。
  容器直连主站三个端口的 ENETUNREACH 是既定 internal 网络隔离，不能当作
  三条宿主机通道均故障；v2 探针因此明确分开 host/container 两个作用域。
- 主站 15435 在 `10.2.0.5` 正常监听，mTLS service active/running，
  IPAddressAllow 包含 `10.73.7.0/24`。已读取主站 IPv4 filter/raw，
  INPUT ACCEPT，自定义拒绝仅匹配其他来源的 SSH；没有发现对该流量的拒绝。

节点本轮只读读回 RUNNING、TAT Online；没有为排查启停节点。现有证据定位
剩余阻断在节点 eth0 至主站 eth0 的云网络路径，尚未确定第二处具体规则。
不能仅凭用户添加规则或节点 READY 宣称官网恢复。云规则读取的 API 身份仍
权限不足，控制台读取间歇失败；按实际截图/读回继续核对，不扩大应用权限。

## 缺失的验证与本次工具

既有浏览器 smoke 使用 `network=none`，只能证明页面创建、渲染、截图；
既有 PG preflight 只能证明数据库通道。两者都不覆盖新增的 15435。
`integrity-egress-probe.mjs` v2 将网络作用域分开。每次连接有 4 秒绝对上限，
最多读取 8 KiB 响应头；无重试、不读取凭据、不创建业务任务、不输出响应正文。

在节点宿主机执行三条 TCP 通道对照（可从 stdin 传入，无需安装或修改运行文件）：

```sh
node --input-type=module - --run --scope=host < deploy/tencent-elasticity/integrity-egress-probe.mjs
```

在实际 authoring 容器内验证桥接代理 CONNECT（先核当前 container ID）：

```sh
docker exec -i <authoring-container-id> node --input-type=module - --run --scope=container \
  < deploy/tencent-elasticity/integrity-egress-probe.mjs
```

默认作用域为 `container`。容器故意没有主站私网直连路由，不能在容器内跑 host
模式后把 ENETUNREACH 当作云端端口拒绝，也不能为探针增加直连网络。
`network_scope` 明确输出来源；host 的 `transport_ready` 只判断 15435 TCP，
container 的该值只判断代理 CONNECT。两处分别通过后仍需官网业务验收。
host 失败标记 `node_to_main_transport`；container 失败只标记
`container_to_official_proxy`，不凭 CONNECT 失败猜测 mTLS/云规则根因。
始终保留 `specific_network_rule_verified=false` 和 `official_query_performed=false`。

## 完成修复仍需的步骤

1. 使用具备既有权限的运维控制台/API，读取实际安全组出入站规则、子网 ACL、
   私网互联路由与主站对应规则，记录顺序、作用方向和原始证据。用户已补出站规则；继续确认哪层
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
