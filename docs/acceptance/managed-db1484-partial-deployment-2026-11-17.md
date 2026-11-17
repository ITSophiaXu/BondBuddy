# 新节点数据库权限修复：分组件部署记录（2026-11-17）

范围：Refs #1484。用户明确授权本批服务器部署。稳定发布 PR #1496、#1497；最终稳定提交 `a0f1a4779d2b17b75973ad76d01536885f5f3cb4`。执行包和主站准备源来自其祖先 `6edb893266ef745b330e936edf242ad50697ab3c`，补充提交只修正缺失的0182前置及192项台账门禁。不得将本记录理解为完整执行节点验收通过。

## 已生效与待完成

| 组件 | 实际结果 |
| --- | --- |
| 腾讯唯一业务数据库 | 2026-11-17 08:58 北京时间，在同一事务应用既有0182、新增0190和四角色最小ACL，台账190→192；四角色真实SET LOCAL ROLE预检、两种锁调用及文件检查表读取均通过。无superuser、无审计表UPDATE/DELETE/TRUNCATE。 |
| 控制端与未来两槽模板 | 08:59切换。实际helper、bootstrap、pool及authority哈希全部匹配，原8/8槽、镜像和费用上限保留。 |
| 主站API/Web | 09:00–09:01切换。API只挂载三处LOCK SQL改用受限helper的编译模块；Web使用原镜像刷新API连接。数据库未重启。 |
| 现存执行节点 | 未安装新helper/业务包，未启动验收。节点仍stopped、revision50；不能以未来模板已更新代替现存节点生效。 |

09:02部署后只读核验：公网首页200、`/healthz`200、`/api/v1/me`401；API/Web/PostgreSQL健康，ops运行。活动执行租约0、模型持有者0、待处理云操作0；无pending-release，部署锁已释放。没有重投历史生产客户任务或修改历史账务。

## 准确工件与回执

- 执行包SHA256：`183e5240e6cefc09314943fc270b009fd547e497437af111a99fd77235e17dd0`，440177 bytes，74文件；68份原文件逐字节保留。
- API生效模块SHA256：`d1ca53c387b13cf048d9b1a55f4082f2981550b51a08888a5d54e8de2566f26f`。
- API容器：`5c550e473c40d15b3400eeca239bafcc5a17c6be29667c512fba55e8a0de605f`。
- Web容器：`0a451125ae6099bc49334d49b067195f0d67a48aee69f0135af5d70576db4230`。
- ops容器：`871903900a5a53491ad3ebf4d22ac110379f24b111e40e19175753203ae6f560`。
- 主站保护目录：`/var/lib/bondbuddy/db1484-20261117/private`。数据库初次失败及attempt2前像均保留；成功回执为`database-after.safe.json`、`activation.safe.json`、`api-activate.safe.json`。
- 共享组件台账：`/var/lib/bondbuddy/migration-908/state-main/current-components.json`。数据库、控制端、API/Web分别留证，不改整角色current以冒充整栈同版。
- 初次数据库事务因缺0182活动表完整回滚；随后仅补该新增空表/索引的前置，与0190及ACL一起提交，没有执行全量迁移。

## 执行节点剩余条件

正常Start的费用门禁仍拒绝过期计价：`cloud_quote_refresh.pricing_valid_until=2026-11-16T16:00:00.000Z`。已有维护子账号的官方询价请求也被腾讯IAM拒绝；不是本次数据库权限缺口。需要既有运维身份读取当前官方价格并更新受保护计价凭据，保留每小时4元、自然日48元、min_running=0/max_owned=2及原成本边界。没有延长旧凭据时间、直接调用云Start或扩大应用身份权限。

补齐计价后，先重新核对实时pool/authority，保留本次已生效包pin及并行配置；按正常持久化controller.start生成新epoch，再通过既有TAT维护身份执行本目录版本化install-request。派发前核请求SHA和目标节点，未知结果先查InvocationId，不重复派发。检查74文件hash、两服务真实数据库账号preflight、READY和空闲排空/STOP_CHARGING后，才可将#1484标为完整已部署。

回滚保留新增数据库结构与审计数据；受限账号下旧直接LOCK代码不是可工作的功能回滚。控制端/API前像和配置回滚入口在发布目录，恢复必须使用同一共享锁、pending和准确当前状态，不覆盖后来版本。

## 测试与边界

准确生产authoring/review OCI断网隔离各13项，共26/26通过；新旧包闭包和bootstrap已有定向证据。回带develop后新包/实际Python解码5/5、旧包/暖启动2/2通过。旧包测试增加BB_TEST_PYTHON环境路径支持；Windows未提供python3命令导致的首次环境失败保留，修正解释器路径后通过。

原真实重放：杞县成功交付双Word并通过质量检查；沧州因独立模型HTTP413失败。未把模拟或隔离镜像检查当成现存执行节点完整运行验收。GitHub hosted CI因账户计费限制未启动，不能称为CI通过。完整修复的发布标签仍为release:待发布；最终统一验收待办为上述现存节点安装、READY与正常停机核验。

回带分支集成检查：按仓库各包构建脚本依次执行六个包的TypeScript、Web类型检查与Vite构建，全部通过；契约72/72通过。执行器在打印Unicode测试摘要时中断，测试本身成功；随后单独完成样例和数据生命周期检查。未将本地npm启动器缺失或打印编码问题当成产品测试失败。
