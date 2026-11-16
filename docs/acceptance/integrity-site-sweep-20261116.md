# BondBuddy 诚信核查逐站实测与启停清单

实测时间（北京时间）：2026-11-16 22:21:01 至 2026-11-16 23:10:44。本机 Docker、真实 Chromium、产品官方采集器，通过本机公网出口访问；未使用生产北京出口。

## 结果

已完成 129 个实际入口测试：52 个全国查询项、4 个历史查询项（其中 1 项含 2 个入口）、36 个地区各 2 个属地入口。按“已提交查询、结果明确、保留真实结果截图”启用 47 个入口，暂停 82 个入口。主页能打开、验证码拦截、未确认结果和查询超时均不算完成查询。暂停原因分开记录，不统一称作网站宕机。

全国目录启用 9／52 项；历史目录保留 0／5 个入口；属地证监局启用 36／36 个地区、税务局启用 2／36 个地区。多个栏目可以来自同一网站，不能把入口数当成独立域名数。

## 使用规则

- 新核查仅选择实测通过的入口；属地选项须对应本轮所有企业均通过的地区，否则不带入该选项。注册地变化后重新核对并保存范围，不默默跳过部分企业后照原范围收费。
- 服务端保存、报价、新建执行同一范围校验，客户端旧版本不能绕过。原任务、待确认请求、历史查询记录、证据及免费重导出保留原范围。
- 测试查询词为“东营市城市建设发展集团有限公司”，专项栏目附加事项关键词。地区字段仅用于逐入口测试，不表示该公司在每个地区注册，也不形成对该发行人的诚信结论。
- 本次不调用模型、不生成生产任务、不连接生产数据库、不扣用户积分。返回搜索结果不等于发现违法，零结果也不等于企业不存在风险。
- 本机出口测试不替代最终生产执行节点验收；统一发布前须在最终节点复核启用范围。当前代码尚未部署。

## 全国查询项

|查询项 / 入口|决定|本次结果|截图数|
|---|---|---|---:|
|[信用中国](https://www.creditchina.gov.cn/)|暂停|HTTP 错误 / open / 400|0|
|[中国执行信息网-失信被执行人](https://zxgk.court.gov.cn/shixin/)|暂停|访问被拒绝 / open / 403 / 403 Forbidden|1|
|[中国执行信息网-被执行人信息](https://zxgk.court.gov.cn/zhixing/)|暂停|访问被拒绝 / open / 403 / 403 Forbidden|1|
|[中国执行信息网-限制消费信息](https://zxgk.court.gov.cn/xgl/)|暂停|访问被拒绝 / open / 403 / 403 Forbidden|1|
|[全国企业破产重整案件信息网](https://pccz.court.gov.cn/)|启用|明确返回零结果 / results|1|
|[国家税务总局](https://www.chinatax.gov.cn/)|暂停|页面空白超时 / results|0|
|[重大税收违法失信案件信息公布栏](https://www.chinatax.gov.cn/)|暂停|查询操作失败 / query|1|
|[全国行业信用公共服务平台](https://www.bcp12312.org.cn/)|暂停|网络或页面资源错误 / open / net::ERR_CERT_DATE_INVALID|0|
|[中国人民银行](https://www.pbc.gov.cn/)|启用|返回查询结果 / results / OPTIONAL_PBC_WIDGET_STYLESHEET_HTTP_404|1|
|[国家金融监督管理总局](https://www.nfra.gov.cn/)|暂停|页面空白超时 / query|0|
|[中国证监会](https://www.csrc.gov.cn/)|启用|返回查询结果 / results|1|
|[中国证券监督管理委员会-证券期货市场失信记录查询平台](https://neris.csrc.gov.cn/shixinchaxun/)|暂停|验证码阻断 / results|1|
|[上海证券交易所](https://www.sse.com.cn/)|启用|返回查询结果 / results|3|
|[北京证券交易所](https://www.bse.cn/)|启用|明确返回零结果 / results|1|
|[深圳证券交易所-首页](https://www.szse.cn/)|暂停|结果未确认 / results|1|
|[深圳证券交易所-债券纪律处分](https://www.szse.cn/)|暂停|结果未确认 / results|1|
|[深圳证券交易所-监管措施](https://www.szse.cn/)|暂停|结果未确认 / results|1|
|[国家外汇管理局](https://www.safe.gov.cn/)|暂停|结果未确认 / results|1|
|[全国中小企业股份转让系统](https://www.neeq.com.cn/)|启用|明确返回零结果 / results|1|
|[中国银行间市场交易商协会-自律处分概览](https://www.nafmii.org.cn/)|启用|返回查询结果 / results|3|
|[中国证券业协会](https://www.sac.net.cn/)|暂停|HTTP 错误 / open / 567|1|
|[中国证券投资基金业协会](https://www.amac.org.cn/)|暂停|结果未确认 / results|1|
|[中华人民共和国商务部](https://www.mofcom.gov.cn/)|暂停|验证码阻断 / results|1|
|[商务信用服务平台](https://www.bcpcn.com/)|暂停|结果未确认 / results|1|
|[中国期货业协会-期货公司诚信记录信息](https://www.cfachina.org/)|暂停|结果未确认 / results|1|
|[中国期货业协会-纪律惩戒](https://www.cfachina.org/)|暂停|结果未确认 / results|1|
|[中华人民共和国应急管理部](https://www.mem.gov.cn/)|暂停|结果未确认 / results|1|
|[国家发展和改革委员会](https://www.ndrc.gov.cn/)|暂停|结果未确认 / results|1|
|[中华人民共和国生态环境部](https://www.mee.gov.cn/)|暂停|网络或页面资源错误 / query / OFFICIAL_STYLESHEET_LOAD_FAILED http://static.gridsumdissector.com/zheng_fen_xiang/content/gwdsharestyle.css|1|
|[中华人民共和国财政部](https://www.mof.gov.cn/)|暂停|网络或页面资源错误 / results / 502 / OFFICIAL_STYLESHEET_LOAD_FAILED net::ERR_ABORTED https://search.mof.gov.cn/was5/web/mofimages/js/My97DatePicker/skin/WdatePicker.css|1|
|[国家统计局](https://www.stats.gov.cn/)|暂停|网络或页面资源错误 / results / OFFICIAL_STYLESHEET_LOAD_FAILED net::ERR_BLOCKED_BY_CLIENT https://p.so-gov.cn/web/pc/enterprise/css/swiper-bundle.min.css|1|
|[中华人民共和国海关总署](http://www.customs.gov.cn/)|暂停|HTTP 错误 / open / 400|0|
|[中华人民共和国工业和信息化部](https://www.miit.gov.cn/)|启用|返回查询结果 / results|1|
|[国家市场监督管理总局](https://www.samr.gov.cn/)|暂停|结果未确认 / results|1|
|[国家市场监督管理总局-中国市场监管行政处罚文书网](https://www.samr.gov.cn/)|暂停|结果未确认 / results|1|
|[农业农村部](https://www.moa.gov.cn/)|暂停|结果未确认 / results|1|
|[中国海关企业进出口信用信息公示平台](http://credit.customs.gov.cn/)|暂停|HTTP 错误 / open / 400|1|
|[国家能源局](https://www.nea.gov.cn/)|暂停|网络或页面资源错误 / query / OFFICIAL_STYLESHEET_LOAD_FAILED net::ERR_BLOCKED_BY_CLIENT https://www.news.cn/global/lib/swiper/swiper3.4.2/swiper.min.css|1|
|[国家住房和城乡建设部](https://www.mohurd.gov.cn/)|暂停|网络或页面资源错误 / open / net::ERR_TUNNEL_CONNECTION_FAILED|0|
|[中国电力企业联合会-信用电力-关联黑名单](https://www.cec.org.cn/)|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[中国电力企业联合会-信用电力-监管、大数据预警](https://www.cec.org.cn/)|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[自然资源部](https://www.mnr.gov.cn/)|暂停|网络或页面资源错误 / open / net::ERR_TUNNEL_CONNECTION_FAILED|0|
|[人力资源和社会保障部](https://www.mohrss.gov.cn/)|启用|返回查询结果 / results|3|
|[交通运输部](https://www.mot.gov.cn/)|暂停|结果未确认 / results|1|
|[信用交通-信用信息查询](https://credit.mot.gov.cn/)|暂停|页面报错 / open / 因信用交通网站进行系统维护，现调整网站运行时间：2026年11月13日18：00至2026年11月21日8：00期间暂停服务。给您带来的不便敬请谅解!|1|
|[信用交通-行政处罚](https://credit.mot.gov.cn/)|暂停|页面报错 / open / 因信用交通网站进行系统维护，现调整网站运行时间：2026年11月13日18：00至2026年11月21日8：00期间暂停服务。给您带来的不便敬请谅解!|1|
|[全国建筑市场监管公共服务平台](https://jzsc.mohurd.gov.cn/)|暂停|网络或页面资源错误 / open / net::ERR_TUNNEL_CONNECTION_FAILED|0|
|[信用盐业-盐行业信用管理与公共服务平台](https://www.cnsalt.cn/)|暂停|网络或页面资源错误 / open / net::ERR_EMPTY_RESPONSE|0|
|[中国政府采购网-代理机构不良行为记录名单](https://www.ccgp.gov.cn/)|暂停|访问被拒绝 / open / 403|1|
|[中国政府采购网-政府采购严重违法失信行为记录名单](https://www.ccgp.gov.cn/)|暂停|访问被拒绝 / open / 403|1|
|[中国盐业协会](https://www.cnsalt.cn/)|暂停|网络或页面资源错误 / open / net::ERR_EMPTY_RESPONSE|0|
|[国家药品监督管理局](https://www.nmpa.gov.cn/)|暂停|HTTP 错误 / open / 400|0|

## 属地入口

|查询项 / 入口|决定|本次结果|截图数|
|---|---|---|---:|
|[北京证监局](https://www.csrc.gov.cn/beijing/index.shtml)（北京）|启用|返回查询结果 / results|1|
|[北京税务局](http://beijing.chinatax.gov.cn/)（北京）|暂停|HTTP 错误 / open / 400|0|
|[天津证监局](https://www.csrc.gov.cn/tianjin/index.shtml)（天津）|启用|返回查询结果 / results|2|
|[天津税务局](http://tianjin.chinatax.gov.cn/)（天津）|暂停|查询入口未就绪 / open|1|
|[河北证监局](https://www.csrc.gov.cn/hebei/index.shtml)（河北）|启用|返回查询结果 / results|1|
|[河北税务局](http://hebei.chinatax.gov.cn/)（河北）|暂停|访问被拒绝 / open / 403 / Forbidden|1|
|[山西证监局](https://www.csrc.gov.cn/shanxi/index.shtml)（山西）|启用|返回查询结果 / results|2|
|[山西税务局](http://shanxi.chinatax.gov.cn/)（山西）|启用|返回查询结果 / results|3|
|[内蒙古证监局](https://www.csrc.gov.cn/neimenggu/index.shtml)（内蒙古）|启用|返回查询结果 / results|1|
|[内蒙古税务局](http://neimenggu.chinatax.gov.cn/)（内蒙古）|暂停|查询操作失败 / query|1|
|[辽宁证监局](https://www.csrc.gov.cn/liaoning/index.shtml)（辽宁）|启用|返回查询结果 / results|2|
|[辽宁税务局](http://liaoning.chinatax.gov.cn/)（辽宁）|暂停|查询入口未就绪 / open|1|
|[吉林证监局](https://www.csrc.gov.cn/jilin/index.shtml)（吉林）|启用|返回查询结果 / results|2|
|[吉林税务局](http://jilin.chinatax.gov.cn/)（吉林）|暂停|HTTP 错误 / open / 400|0|
|[黑龙江证监局](https://www.csrc.gov.cn/heilongjiang/index.shtml)（黑龙江）|启用|返回查询结果 / results|2|
|[黑龙江税务局](http://heilongjiang.chinatax.gov.cn/)（黑龙江）|暂停|查询入口未就绪 / open|1|
|[上海证监局](https://www.csrc.gov.cn/shanghai/index.shtml)（上海）|启用|返回查询结果 / results|2|
|[上海税务局](http://shanghai.chinatax.gov.cn/)（上海）|暂停|查询操作失败 / query|1|
|[江苏证监局](https://www.csrc.gov.cn/jiangsu/index.shtml)（江苏）|启用|返回查询结果 / results|1|
|[江苏税务局](http://jiangsu.chinatax.gov.cn/)（江苏）|暂停|查询入口未就绪 / open|1|
|[浙江证监局](https://www.csrc.gov.cn/zhejiang/index.shtml)（浙江）|启用|返回查询结果 / results|1|
|[浙江税务局](http://zhejiang.chinatax.gov.cn/)（浙江）|暂停|查询入口未就绪 / open|1|
|[安徽证监局](https://www.csrc.gov.cn/anhui/index.shtml)（安徽）|启用|返回查询结果 / results|1|
|[安徽税务局](http://anhui.chinatax.gov.cn/)（安徽）|暂停|访问被拒绝 / open / 403|1|
|[福建证监局](https://www.csrc.gov.cn/fujian/index.shtml)（福建）|启用|返回查询结果 / results|1|
|[福建税务局](http://fujian.chinatax.gov.cn/)（福建）|暂停|HTTP 错误 / open / 503|1|
|[江西证监局](https://www.csrc.gov.cn/jiangxi/index.shtml)（江西）|启用|返回查询结果 / results|2|
|[江西税务局](http://jiangxi.chinatax.gov.cn/)（江西）|暂停|网络或页面资源错误 / open / net::ERR_EMPTY_RESPONSE|0|
|[山东证监局](https://www.csrc.gov.cn/shandong/index.shtml)（山东）|启用|返回查询结果 / results|1|
|[山东税务局](http://shandong.chinatax.gov.cn/)（山东）|暂停|HTTP 错误 / open / 400|0|
|[河南证监局](https://www.csrc.gov.cn/henan/index.shtml)（河南）|启用|返回查询结果 / results|2|
|[河南税务局](https://henan.chinatax.gov.cn/)（河南）|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[湖北证监局](https://www.csrc.gov.cn/hubei/index.shtml)（湖北）|启用|返回查询结果 / results|2|
|[湖北税务局](http://hubei.chinatax.gov.cn/)（湖北）|暂停|HTTP 错误 / open / 400|0|
|[湖南证监局](https://www.csrc.gov.cn/hunan/index.shtml)（湖南）|启用|返回查询结果 / results|1|
|[湖南税务局](http://hunan.chinatax.gov.cn/)（湖南）|暂停|查询入口未就绪 / open|1|
|[广东证监局](https://www.csrc.gov.cn/guangdong/index.shtml)（广东）|启用|返回查询结果 / results|2|
|[广东税务局](http://guangdong.chinatax.gov.cn/)（广东）|启用|返回查询结果 / results|2|
|[广西证监局](https://www.csrc.gov.cn/guangxi/index.shtml)（广西）|启用|返回查询结果 / results|2|
|[广西税务局](https://guangxi.chinatax.gov.cn/)（广西）|暂停|结果未确认 / results|1|
|[海南证监局](https://www.csrc.gov.cn/hainan/index.shtml)（海南）|启用|返回查询结果 / results|1|
|[海南税务局](http://hainan.chinatax.gov.cn/)（海南）|暂停|查询入口未就绪 / open|1|
|[重庆证监局](https://www.csrc.gov.cn/chongqing/index.shtml)（重庆）|启用|返回查询结果 / results|1|
|[重庆税务局](http://chongqing.chinatax.gov.cn/)（重庆）|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[四川证监局](https://www.csrc.gov.cn/sichuan/index.shtml)（四川）|启用|返回查询结果 / results|1|
|[四川税务局](http://sichuan.chinatax.gov.cn/)（四川）|暂停|网络或页面资源错误 / open / net::ERR_EMPTY_RESPONSE|0|
|[贵州证监局](https://www.csrc.gov.cn/guizhou/index.shtml)（贵州）|启用|返回查询结果 / results|1|
|[贵州税务局](http://guizhou.chinatax.gov.cn/)（贵州）|暂停|HTTP 错误 / open / 503|1|
|[云南证监局](https://www.csrc.gov.cn/yunnan/index.shtml)（云南）|启用|返回查询结果 / results|2|
|[云南税务局](http://yunnan.chinatax.gov.cn/)（云南）|暂停|网络或页面资源错误 / open / net::ERR_EMPTY_RESPONSE|0|
|[西藏证监局](https://www.csrc.gov.cn/xizang/index.shtml)（西藏）|启用|返回查询结果 / results|1|
|[西藏税务局](https://xizang.chinatax.gov.cn/)（西藏）|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[陕西证监局](https://www.csrc.gov.cn/shaanxi/index.shtml)（陕西）|启用|返回查询结果 / results|1|
|[陕西税务局](https://shaanxi.chinatax.gov.cn/)（陕西）|暂停|网络或页面资源错误 / open / net::ERR_CONNECTION_CLOSED|0|
|[甘肃证监局](https://www.csrc.gov.cn/gansu/index.shtml)（甘肃）|启用|返回查询结果 / results|2|
|[甘肃税务局](http://gansu.chinatax.gov.cn/)（甘肃）|暂停|HTTP 错误 / open / 503|1|
|[青海证监局](https://www.csrc.gov.cn/qinghai/index.shtml)（青海）|启用|返回查询结果 / results|1|
|[青海税务局](http://qinghai.chinatax.gov.cn/)（青海）|暂停|HTTP 错误 / open / 504|0|
|[宁夏证监局](https://www.csrc.gov.cn/ningxia/index.shtml)（宁夏）|启用|返回查询结果 / results|1|
|[宁夏税务局](http://ningxia.chinatax.gov.cn/)（宁夏）|暂停|HTTP 错误 / open / 400|0|
|[新疆证监局](https://www.csrc.gov.cn/xinjiang/index.shtml)（新疆）|启用|返回查询结果 / results|2|
|[新疆税务局](https://xinjiang.chinatax.gov.cn/)（新疆）|暂停|HTTP 错误 / open / 400|0|
|[深圳证监局](https://www.csrc.gov.cn/shenzhen/index.shtml)（深圳）|启用|返回查询结果 / results|1|
|[深圳税务局](https://shenzhen.chinatax.gov.cn/)（深圳）|暂停|网络或页面资源错误 / open / net::ERR_TUNNEL_CONNECTION_FAILED|0|
|[大连证监局](https://www.csrc.gov.cn/dalian/index.shtml)（大连）|启用|返回查询结果 / results|1|
|[大连税务局](http://dalian.chinatax.gov.cn/)（大连）|暂停|查询入口未就绪 / open|1|
|[宁波证监局](https://www.csrc.gov.cn/ningbo/index.shtml)（宁波）|启用|返回查询结果 / results|1|
|[宁波税务局](http://ningbo.chinatax.gov.cn/)（宁波）|暂停|HTTP 错误 / open / 503|1|
|[厦门证监局](https://www.csrc.gov.cn/xiamen/index.shtml)（厦门）|启用|返回查询结果 / results|1|
|[厦门税务局](http://xiamen.chinatax.gov.cn/)（厦门）|暂停|HTTP 错误 / open / 503|1|
|[青岛证监局](https://www.csrc.gov.cn/qingdao/index.shtml)（青岛）|启用|返回查询结果 / results|1|
|[青岛税务局](http://qingdao.chinatax.gov.cn/)（青岛）|暂停|HTTP 错误 / results / 400|0|

## 历史查询项

旧任务仍可查看这些入口的原始元数据；仅实测通过的历史范围可用于准备新核查。同一历史项含多个入口时，须全部通过才保留该项。

|查询项 / 入口|决定|本次结果|截图数|
|---|---|---|---:|
|[国家企业信用信息公示系统](https://www.gsxt.gov.cn/)|暂停|访问被拒绝 / open / 403|1|
|[中国执行信息公开网](https://zxgk.court.gov.cn/)|暂停|访问被拒绝 / open / 403 / 403 Forbidden|1|
|[中国裁判文书网](https://wenshu.court.gov.cn/)|暂停|结果未确认 / results|1|
|[食品药品监管部门门户](https://www.samr.gov.cn/)|暂停|结果未确认 / results|1|
|[食品药品监管部门门户](https://www.nmpa.gov.cn/)|暂停|HTTP 错误 / open / 400|0|

## 后续恢复

逐站修复其表中具体原因，在目标执行环境真实提交查询，核对结果归属、查询事项和截图后，更新实测证据和可用入口表，再交统一发布。不把登录/验证码页、门户首页或未完成查询写成“无记录”。

采集器来源：8209b347d765589fb97c19c990c63718d67ad227。原目录来源：025e3d1d16b1769e0221795476ce958e98bea386。每条记录包含配置入口、查询词、开始/完成状态、诊断和截图哈希，见同目录测试汇总 JSON；本地保留全部截图和完整原始采集结果。所有启用入口均已逐项查看首张结果截图，核对查询词、官网归属和结果状态；其中模糊匹配的其他主体内容不作为测试企业的失信结论。首次测试触及 420 秒总时限的入口均单独复验，首轮异常保存在 first-attempts，摘要中保留 retry_of。

## 开发回归与交付

- 真实官网：129 个入口全部完成，47 个通过、82 个暂停；保留 122 张截图。6 个首轮测试总时限异常已独立复验并保留原始记录，最终无未处理测试异常。47 个通过入口均由 Codex 逐项核对首张结果截图；这不是用户验收。
- 服务端、契约与历史证据：覆盖 30 项。首次 29 项通过；旧订阅夹具仍选择已暂停税务入口，改用已验证的人民银行后，所属 4 项 PostgreSQL 场景全部复验通过。包含全部 72 个地区入口逐一对照、混合企业、未知地区、旧范围、保存/报价/新建、幂等请求和计价边界。
- worker 与计费：覆盖 12 项。首次 10 项通过；两项预期金额仍写死旧网站数量，改为按本次实际范围计算后分别复验通过。运行了真实 Fastify、隔离 PostgreSQL、worker、Python Word 生成、积分结算和免费重导出；网站响应与模型结果为合成夹具，无外部模型或真实支付调用。
- 网页：11 个场景完成验证，真实 Edge + 合成 API。首次 9 项通过；修正测试刷新时重复覆盖缓存、操作隐藏城市输入框的夹具问题后，2 项定向复验通过。涵盖全选、分组、旧草稿、历史采用、注册地变化、待确认原请求保持可见且锁定。
- 编译：contracts 编译、API/worker 在独立输出目录的完整 TypeScript 编译、web 类型检查通过。复用了同锁文件的本地依赖。未声明全仓库 npm build 或线上端到端验收通过；完整 Azurite 浏览器 E2E 夹具仅更新并完成类型检查，本轮未重跑该套件。
- 环境修正：旧 API 声明产物刷新后 worker 编译通过。临时空库初次迁移因 Windows CRLF 与 SQL 函数文本匹配不一致中断；仅在测试迁移读取时规范为 Linux LF 后，全部迁移通过。产品迁移文件、生产数据库均未修改。
- 无数据库迁移或依赖变更。本 PR 只控制新核查可选范围；原任务、证据、锁定费用和免费重导出保留。#1449 的 CDP 异常隔离验证另见 PR #1486；本次不据此关闭 #819 或 #1477，后者的整批运行时失败/缓存接续仍需单独处理。

交付：[PR #1487](https://github.com/ITSophiaXu/BondBuddy/pull/1487)，目标分支 develop。代码完成，尚未部署，待统一发布。用户集成验收尚未进行。完整列表包含暂停原因，可按入口逐项修复并复验后恢复。
