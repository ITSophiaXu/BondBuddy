# 诚信核查网站清单与临时停用记录

> 本文件为前一阶段记录。当前启停范围已由 129 个入口全量实测清单替代，见 [完整启停清单](integrity-site-sweep-20261116.md)。下述历史数字仅保留当时状态。

更新：2026-11-16。代码基于 develop b47d34a1560dfabbf864c02facf26066f9b29b72。本清单用于逐站修复；“保留选项”不表示已通过完整查询验收。

## 本次处理

从新核查中再移除海关总署、海关企业信用平台、国家药监局 3 项。加上此前已移除的 5 项，共停用 8 个查询项，新核查可选项从 49 项变为 46 项（44 项全国查询、2 项属地查询）。同一网站的不同查询事项分别计数。

沿用现有目录过滤：全选、分组、服务端/本机保存范围恢复、采用历史名单时剔除停用项；API 保存、报价、新建拒绝包含停用项的范围，不暗中替用户改价。已有任务的锁定范围、原查询记录、证据和免费重导出保留。仅清除停用项的新草稿会变为空范围，不能启动。

代码完成后仍需统一发布；本次没有部署、重跑生产任务或修改生产缓存。

## 停用清单

|网站/查询项|历史访问失败 / 实际执行|已确认表现|本次处理|
|---|---:|---|---|
|[信用中国](https://www.creditchina.gov.cn/)|7/7|HTTP 响应错误 7 次|此前代码已移除，本次保留|
|[中国执行信息网-失信被执行人](https://zxgk.court.gov.cn/shixin/)|7/7|HTTP 响应错误 7 次|此前代码已移除，本次保留|
|[中国执行信息网-被执行人信息](https://zxgk.court.gov.cn/zhixing/)|7/7|HTTP 响应错误 7 次|此前代码已移除，本次保留|
|[中国执行信息网-限制消费信息](https://zxgk.court.gov.cn/xgl/)|7/7|HTTP 响应错误 7 次|此前代码已移除，本次保留|
|[全国行业信用公共服务平台](https://www.bcp12312.org.cn/)|7/7|证书错误 7 次|此前代码已移除，本次保留|
|[中华人民共和国海关总署](http://www.customs.gov.cn/)|4/4|HTTP 响应错误 4 次；11月16日本地复测 open / HTTP 400|本次新增停用|
|[中国海关企业进出口信用信息公示平台](http://credit.customs.gov.cn/)|4/4|HTTP 响应错误 4 次；11月16日本地复测 open / HTTP 400|本次新增停用|
|[国家药品监督管理局](https://www.nmpa.gov.cn/)|4/4|HTTP 响应错误 4 次；11月16日本地复测 open / HTTP 400|本次新增停用|

海关企业信用平台的本次截图明确显示“访问受到安全防护限制”。不据此认定源站宕机或确定具体封禁原因。所有停用项均未因此得到“无公开记录”结论。

## 查询适配问题清单（本次保留选项）

这些项目有失败记录，但并非已确认的官网打开失败；单独修查询入口、页面资源、验证码流程和结果识别。次数仅指 2026-10-30 实际执行项，不含未执行项。

|网站/查询项|失败或需人工 / 实际执行|待解决问题|
|---|---:|---|
|[国家金融监督管理总局](https://www.nfra.gov.cn/)|7/7|查询结果未确认 7 次|
|[中国证券监督管理委员会-证券期货市场失信记录查询平台](https://neris.csrc.gov.cn/shixinchaxun/)|5/5|验证码阻断 5 次|
|[中华人民共和国商务部](https://www.mofcom.gov.cn/)|5/5|验证码阻断 5 次|
|[中华人民共和国应急管理部](https://www.mem.gov.cn/)|5/5|查询结果未确认 5 次|
|[中华人民共和国生态环境部](https://www.mee.gov.cn/)|4/4|查询页面样式资源失败 4 次|
|[国家统计局](https://www.stats.gov.cn/)|4/4|查询页面样式资源失败 4 次|
|[中华人民共和国工业和信息化部](https://www.miit.gov.cn/)|1/4|查询结果未确认 1 次|
|[国家市场监督管理总局](https://www.samr.gov.cn/)|2/4|查询结果未确认 2 次|
|[国家能源局](https://www.nea.gov.cn/)|4/4|查询页面样式资源失败 4 次|
|[国家住房和城乡建设部](https://www.mohurd.gov.cn/)|4/4|查询结果未确认 4 次|
|[中国电力企业联合会-信用电力-关联黑名单](https://www.cec.org.cn/)|4/4|查询结果未确认 4 次|
|[中国电力企业联合会-信用电力-监管、大数据预警](https://www.cec.org.cn/)|4/4|查询结果未确认 4 次|
|[信用交通-信用信息查询](https://credit.mot.gov.cn/)|4/4|查询入口未适配 4 次|
|[信用交通-行政处罚](https://credit.mot.gov.cn/)|4/4|查询入口未适配 4 次|
|[全国建筑市场监管公共服务平台](https://jzsc.mohurd.gov.cn/)|4/4|查询操作失败 4 次|

国家税务总局 11月16日本地另测能打开并提交查询，但最终结果未确认；截图可见企业全称和“相关结果0个”。应修结果确认规则，不能据此判“官网打不开”或已完成有效核查。金监总局历史 7 张原图同样回显名称与“无搜索结果”，优先复核误拒绝。

## 证据质量清单（本次保留选项）

|网站/查询项|问题及历史次数|
|---|---|
|[上海证券交易所](https://www.sse.com.cn/)|疑似把空查询页接受为无结果 5/5|
|[深圳证券交易所-首页](https://www.szse.cn/)|截图未覆盖完整引用/结果条目 5/5|
|[深圳证券交易所-债券纪律处分](https://www.szse.cn/)|截图未覆盖完整引用/结果条目 5/5|
|[深圳证券交易所-监管措施](https://www.szse.cn/)|截图未覆盖完整引用/结果条目 5/5|
|[交通运输部](https://www.mot.gov.cn/)|截图未覆盖完整引用/结果条目 1/4|
|[中国政府采购网-代理机构不良行为记录名单](https://www.ccgp.gov.cn/)|实际搜索范围不等于专项名单 4/4|
|[中国政府采购网-政府采购严重违法失信行为记录名单](https://www.ccgp.gov.cn/)|实际搜索范围不等于专项名单 4/4|

## 属地网站（逐个 URL 修复）

|属地入口|历史实际执行|历史失败|处理说明|
|---|---:|---|---|
|[浙江证监局](https://www.csrc.gov.cn/zhejiang/index.shtml)|0|无失败记录|未执行，不能推断可用性|
|[浙江税务局](http://zhejiang.chinatax.gov.cn/)|0|无失败记录|未执行，不能推断可用性|
|[山东证监局](https://www.csrc.gov.cn/shandong/index.shtml)|2|无失败记录|当时产品返回查询结果；不代替当前验收|
|[山东税务局](http://shandong.chinatax.gov.cn/)|2|HTTP 响应错误 2 次|样本较少且未在本次复测；待逐地区核验|
|[河南证监局](https://www.csrc.gov.cn/henan/index.shtml)|1|无失败记录|当时产品返回查询结果；不代替当前验收|
|[河南税务局](https://henan.chinatax.gov.cn/)|1|网络错误/超时 1 次|样本较少且未在本次复测；待逐地区核验|
|[河北证监局](https://www.csrc.gov.cn/hebei/index.shtml)|1|无失败记录|当时产品返回查询结果；不代替当前验收|
|[河北税务局](http://hebei.chinatax.gov.cn/)|1|HTTP 响应错误 1 次|发生在结果阶段；需要单独复测|
|[北京证监局](https://www.csrc.gov.cn/beijing/index.shtml)|0|无失败记录|未执行，不能推断可用性|
|[北京税务局](http://beijing.chinatax.gov.cn/)|0|无失败记录|未执行，不能推断可用性|

本次未整项移除“当地税务局”：山东、河南、河北的故障证据不能代表全国各省市。此部分仍需逐地区处理。

## 其他保留的全国查询项

以下项目在该历史批次没有上述故障记录；仍需在恢复或发布验收时验证当前查询、范围和截图。

- [全国企业破产重整案件信息网](https://pccz.court.gov.cn/)（历史实际执行 7 次）
- [国家税务总局](https://www.chinatax.gov.cn/)（历史实际执行 7 次）
- [重大税收违法失信案件信息公布栏](https://www.chinatax.gov.cn/)（历史实际执行 7 次）
- [中国人民银行](https://www.pbc.gov.cn/)（历史实际执行 7 次）
- [中国证监会](https://www.csrc.gov.cn/)（历史实际执行 5 次）
- [北京证券交易所](https://www.bse.cn/)（历史实际执行 5 次）
- [国家外汇管理局](https://www.safe.gov.cn/)（历史实际执行 5 次）
- [全国中小企业股份转让系统](https://www.neeq.com.cn/)（历史实际执行 5 次）
- [中国银行间市场交易商协会-自律处分概览](https://www.nafmii.org.cn/)（历史实际执行 5 次）
- [中国证券业协会](https://www.sac.net.cn/)（历史实际执行 5 次）
- [中国证券投资基金业协会](https://www.amac.org.cn/)（历史实际执行 5 次）
- [商务信用服务平台](https://www.bcpcn.com/)（历史实际执行 5 次）
- [中国期货业协会-期货公司诚信记录信息](https://www.cfachina.org/)（历史实际执行 5 次）
- [中国期货业协会-纪律惩戒](https://www.cfachina.org/)（历史实际执行 5 次）
- [国家发展和改革委员会](https://www.ndrc.gov.cn/)（历史实际执行 4 次）
- [中华人民共和国财政部](https://www.mof.gov.cn/)（历史实际执行 4 次）
- [国家市场监督管理总局-中国市场监管行政处罚文书网](https://www.samr.gov.cn/)（历史实际执行 4 次）
- [农业农村部](https://www.moa.gov.cn/)（历史实际执行 4 次）
- [自然资源部](https://www.mnr.gov.cn/)（历史实际执行 4 次）
- [人力资源和社会保障部](https://www.mohrss.gov.cn/)（历史实际执行 4 次）
- [信用盐业-盐行业信用管理与公共服务平台](https://www.cnsalt.cn/)（历史实际执行 4 次）
- [中国盐业协会](https://www.cnsalt.cn/)（历史实际执行 4 次）

## 逐站恢复条件

1. 在最终执行节点的真实浏览器和公网出口复测，确认打开阶段成功；HTTP 请求成功本身不等于查询完成。
2. 用真实企业全称提交正确事项查询，核对结果页查询词、主体归属、专项范围和完整截图。验证码或登录阻断如实保留，不把阻断页当结果。
3. 验证该站失败时后续站点继续执行、费用按现有规则结算，并验证历史成果仍可读取和重导出。
4. 在独立修复 PR 记录样本、版本、日期与证据，通过后从停用集合移除该 ID；同步清单并交统一发布。本清单不自动安排定时任务。

## 证据与验证边界

- 历史依据：[Issue #819](https://github.com/ITSophiaXu/BondBuddy/issues/819)，2026-10-30 的 7 个发行人，263 项实际执行、115 项未执行。历史部署版本未知，不能把 4/4 写成 7/7。
- 新增 3 项于 2026-11-16 21:43—21:44（北京时间）使用真实 Chromium 和官方 collector 复测，均为 open / HTTP 400、search_performed=false。镜像代码来源 8209b347d765589fb97c19c990c63718d67ad227；本次改动只改目录选择，不改 collector。
- 本次实测为本机 Docker 公网出口，不是生产北京出口；没有模型调用、生产数据库、生产任务或扣费。首次测试容器遗漏仓库 seccomp 配置导致浏览器启动失败，已排除该无效样本；按现有安全配置重测后才取得上述 HTTP 证据。
- [Issue #1477](https://github.com/ITSophiaXu/BondBuddy/issues/1477) 的 21 项运行时失败不能作为 21 个网站各自不可访问的证据；本次停用不宣称修复该整批故障或失败缓存接续问题。

### 自动化验证结果

- 公共契约编译：`node node_modules/typescript/bin/tsc -p packages/contracts/tsconfig.json` 通过。API 与 web 分别使用各自 tsconfig 的 `--noEmit` 类型检查，通过。
- API 目录/业务校验：`node --test apps/api/dist/integrity.test.js`，4 passed / 0 failed / 0 skipped；覆盖停用项拒绝、46 项合法范围、空/未知范围及历史元数据。依赖构建产物复用相同源码的前轮本地副本，本次修改的 contracts 已重新编译，API 测试重新转译；不声称完成全仓库构建。
- 浏览器：真实 Microsoft Edge、本地 Vite 5349、合成 HTTP API 数据。`integrity-retired-sites.spec.ts` 共 8 个场景验证通过：首次通过本机恢复和全选 2 项；首次其余场景遇到 30 秒导航超时与既有人员校验提示文案过期，修正文案断言后，对 6 个受影响/未完成场景以 90 秒用例超时定向复验，6 passed / 0 failed / 0 skipped。人员范围无效仍阻止启动、无写入断言保留。
- 定向复验命令（apps/web）：`BB_E2E_BASE_URL=http://127.0.0.1:5349 BB_E2E_BROWSER_CHANNEL=msedge node ../../node_modules/@playwright/test/cli.js test tests/integrity-retired-sites.spec.ts --grep 'historical selection|server saved|retired-only' --timeout=90000`。这里只验证页面行为，不把合成 API 当真实 worker 或计费验收。
- 真实官网复测：3/3 重现 HTTP 400；这证明本次暂停依据，并非查询成功。安全诊断与截图哈希见 [JSON](integrity-site-availability-20261116.json)。
- 无数据库迁移、依赖或 API schema 变化。开发与自测完成；未提供完整本地集成验收版、用户未验收、未部署，待统一发布。
