# 浏览器输入链测试资源与积分准备（#1123）

## 问题与修复范围

2026-11-12，原浏览器输入链在真实 Chromium/API/PostgreSQL/Azurite 中完成上传确认和输入锁定后，执行返回402：本次需要8,864积分，HTTP注册的合成账号余额为0。执行接口拒绝符合现行计费规则，测试缺少正常准入准备。原失败保留，不能记为门禁通过。

本修复只在父入口创建的专用克隆库，为HTTP注册返回的准确合成owner通过既有 `transaction` / `grantCredits` 发放10,000测试积分。使用明确synthetic幂等键及非现金grant来源，读回真实余额；执行后检查真实预留和积分守恒。没有修改余额字段、伪造API响应、启用历史计费开关或改动产品计费逻辑。

Docker Desktop的随机loopback端口映射另有环境缺陷。父入口增加可选 `BB_PROSPECTUS_BROWSER_STORAGE_HOST_PORT`，仅接受1至65535的十进制整数；绑定地址始终为 `127.0.0.1`。不设置时仍使用原随机端口。设置后必须与Docker实际inspect得到的唯一loopback绑定一致，否则拒绝；不接受地址、端口映射片段、额外公开端口或Docker参数。该设置只由父入口读取，子进程只接收核验后的实际端口。

示例：在已经准备好隔离测试库的Linux测试执行器中设置 `BB_PROSPECTUS_BROWSER_STORAGE_HOST_PORT=55588` 后运行 `node scripts/prospectus-input-browser.mjs`；该端口必须可用，不能复用别人的服务。未指定时仍由Docker选择。父入口自行创建和清理本轮数据库及存储容器，不需要调用者注入已有存储endpoint。

Azurite专用测试容器限制为512MiB内存（内存加swap总额同为512MiB）、0.5CPU，启动后读取实际资源限制确认。该限制只适用于此小型合成Blob夹具，不替代外层浏览器/API/数据库执行器的资源预算。清理先核对准确ID、名称、镜像和owner label，再按ID删除；启动部分失败时也只处理本轮准确随机名称及标签的容器。子测试超时仍240秒、用例仍210秒，正式门禁超时不变。

## 覆盖与验证边界

- 原浏览器操作及全部输入、原稿hash/版本、202→200上传确认、持久化outbox、遗漏/错版拒绝、幂等、重登录恢复和模型记录为零断言保留。仍走真实HTTP/PG/Blob及生产上传确认消费者，不启动worker runtime、解析或模型执行循环。
- 单元反例覆盖默认/明确端口、格式/范围/地址注入、非loopback/多重/额外绑定、实际端口不一致、ownership不符和超出资源限制；环境凭据剥离及数据库隔离反例保留。
- 本地静态及单元检查：`node --test scripts/prospectus-input-browser.test.mjs`，8/8，0 fail/skip；父子JS语法与 `git diff --check` 通过。

## 上传就绪与诊断

准确head `2d32b8f5` 的首次Linux原父子入口在首份原稿上传等待 `/complete` 时30秒超时（用例51.25秒），未走到执行/计费环节；保留原失败。加入只读观测的 `0d02378e` 在相同执行器、端口55588、原父子入口真实通过1/1，0 skip，69.153秒。两次真实上传均有201/204/202/200、confirmation completed及outbox delivered，无OOM、无pageerror；这次观测在上传前增加了读取时延，不能据此认定原超时根因已排除。

核对当前界面代码，初始版本/项目状态读取期间上传控件会禁用；`ProspectusPanel.onchange` 在readOnly时清空文件并返回、busy时返回。Playwright的`setInputFiles`不会自动等待控件enabled。最终夹具因此在设置文件前使用默认expect预算断言控件enabled，模拟用户可实际操作的状态，不增加sleep或放宽任何截止时间。上传前后不再await SQL/DOM诊断，避免依赖诊断延迟获得成功。

请求/响应/失败/pageerror及文件input/change、DOM文件节点增删的有界只读观测仍保留，但仅在上传失败后输出DOM及owner/project限定的uploads、confirmations、outbox状态；不记录请求body、认证header、cookie或URL查询。最终可操作性断言版本仍需按准确head另做一次真实父子复验，不能把前一个head的通过重贴到新head。

本次不修复 #1212 引入的review-editor错误断言依赖，也不把其他门禁问题归入#1123。没有迁移、依赖或用户界面变化。代码完成后仍待固定集成版完整门禁与最终统一验收；尚未部署。
