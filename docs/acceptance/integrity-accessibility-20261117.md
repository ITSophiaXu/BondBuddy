# 诚信核查网站访问与截图复测

2026-11-17，本地隔离 Chromium，经产品官网代理真实访问 129 个入口；不调用模型、不创建生产任务、不扣用户积分。新口径只要求正常官网页面和有效截图，不再要求自动搜索完成。零结果不导致停用，登录/验证码与未完成搜索仍在任务结果中如实记录。

目录完整显示 54 项（52 全国项、2 属地项）；全国 33/52 项可选；地方证监局 36/36 个、税务局 9/36 个入口通过。完整审计含5个历史入口，共启用79个入口、暂停50个。入口数不是独立网站数，地方入口只按企业注册地带入。

失败保留两次尝试；旧HTTP地址失败时复验同域HTTPS，成功才更新地址。截图逐项查看并保留SHA256。测试基于本地出口；生产官网代理通道仍须单独验证，不能据此称线上任务已成功。

## 全国查询项

| 网站/入口 | 地址 | 状态 | 本次访问结果 |
|---|---|---|---|
| 信用中国 | https://www.creditchina.gov.cn/ | 暂停 | HTTP访问失败（412） |
| 中国执行信息网-失信被执行人 | https://zxgk.court.gov.cn/shixin/ | 暂停 | HTTP访问失败（403） |
| 中国执行信息网-被执行人信息 | https://zxgk.court.gov.cn/zhixing/ | 暂停 | HTTP访问失败（403） |
| 中国执行信息网-限制消费信息 | https://zxgk.court.gov.cn/xgl/ | 暂停 | HTTP访问失败（403） |
| 全国企业破产重整案件信息网 | https://pccz.court.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家税务总局 | https://www.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 重大税收违法失信案件信息公布栏 | https://www.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 全国行业信用公共服务平台 | https://www.bcp12312.org.cn/ | 暂停 | 网络连接失败 |
| 中国人民银行 | https://www.pbc.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家金融监督管理总局 | https://www.nfra.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中国证监会 | https://www.csrc.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中国证券监督管理委员会-证券期货市场失信记录查询平台 | https://neris.csrc.gov.cn/shixinchaxun/ | 启用 | 官网页面与截图正常（200） |
| 上海证券交易所 | https://www.sse.com.cn/ | 启用 | 官网页面与截图正常（200） |
| 北京证券交易所 | https://www.bse.cn/ | 启用 | 官网页面与截图正常（200） |
| 深圳证券交易所-首页 | https://www.szse.cn/ | 启用 | 官网页面与截图正常（200） |
| 深圳证券交易所-债券纪律处分 | https://www.szse.cn/ | 启用 | 官网页面与截图正常（200） |
| 深圳证券交易所-监管措施 | https://www.szse.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家外汇管理局 | https://www.safe.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 全国中小企业股份转让系统 | https://www.neeq.com.cn/ | 启用 | 官网页面与截图正常（200） |
| 中国银行间市场交易商协会-自律处分概览 | https://www.nafmii.org.cn/ | 启用 | 官网页面与截图正常（200） |
| 中国证券业协会 | https://www.sac.net.cn/ | 暂停 | HTTP访问失败（567） |
| 中国证券投资基金业协会 | https://www.amac.org.cn/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国商务部 | https://www.mofcom.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 商务信用服务平台 | https://www.bcpcn.com/ | 启用 | 官网页面与截图正常（200） |
| 中国期货业协会-期货公司诚信记录信息 | https://www.cfachina.org/ | 启用 | 官网页面与截图正常（200） |
| 中国期货业协会-纪律惩戒 | https://www.cfachina.org/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国应急管理部 | https://www.mem.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家发展和改革委员会 | https://www.ndrc.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国生态环境部 | https://www.mee.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国财政部 | https://www.mof.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家统计局 | https://www.stats.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国海关总署 | http://www.customs.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中华人民共和国工业和信息化部 | https://www.miit.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家市场监督管理总局 | https://www.samr.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家市场监督管理总局-中国市场监管行政处罚文书网 | https://www.samr.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 农业农村部 | https://www.moa.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 中国海关企业进出口信用信息公示平台 | http://credit.customs.gov.cn/ | 暂停 | HTTP访问失败（412） |
| 国家能源局 | https://www.nea.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 国家住房和城乡建设部 | https://www.mohurd.gov.cn/ | 暂停 | 网络连接失败 |
| 中国电力企业联合会-信用电力-关联黑名单 | https://www.cec.org.cn/ | 暂停 | 未完成页面打开或截图 |
| 中国电力企业联合会-信用电力-监管、大数据预警 | https://www.cec.org.cn/ | 暂停 | 未完成页面打开或截图 |
| 自然资源部 | https://www.mnr.gov.cn/ | 暂停 | 网络连接失败 |
| 人力资源和社会保障部 | https://www.mohrss.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 交通运输部 | https://www.mot.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 信用交通-信用信息查询 | https://credit.mot.gov.cn/ | 暂停 | 错误或维护页面（200） |
| 信用交通-行政处罚 | https://credit.mot.gov.cn/ | 暂停 | 错误或维护页面（200） |
| 全国建筑市场监管公共服务平台 | https://jzsc.mohurd.gov.cn/ | 暂停 | 网络连接失败 |
| 信用盐业-盐行业信用管理与公共服务平台 | https://www.cnsalt.cn/ | 暂停 | 网络连接失败 |
| 中国政府采购网-代理机构不良行为记录名单 | https://www.ccgp.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 中国政府采购网-政府采购严重违法失信行为记录名单 | https://www.ccgp.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 中国盐业协会 | https://www.cnsalt.cn/ | 暂停 | 网络连接失败 |
| 国家药品监督管理局 | https://www.nmpa.gov.cn/ | 暂停 | HTTP访问失败（412） |

## 属地入口

| 网站/入口 | 地址 | 状态 | 本次访问结果 |
|---|---|---|---|
| 北京证监局 | https://www.csrc.gov.cn/beijing/index.shtml | 启用 | 官网页面与截图正常（200） |
| 北京税务局 | http://beijing.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 天津证监局 | https://www.csrc.gov.cn/tianjin/index.shtml | 启用 | 官网页面与截图正常（200） |
| 天津税务局 | http://tianjin.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 河北证监局 | https://www.csrc.gov.cn/hebei/index.shtml | 启用 | 官网页面与截图正常（200） |
| 河北税务局 | http://hebei.chinatax.gov.cn/ | 暂停 | 网络连接失败 |
| 山西证监局 | https://www.csrc.gov.cn/shanxi/index.shtml | 启用 | 官网页面与截图正常（200） |
| 山西税务局 | http://shanxi.chinatax.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 内蒙古证监局 | https://www.csrc.gov.cn/neimenggu/index.shtml | 启用 | 官网页面与截图正常（200） |
| 内蒙古税务局 | http://neimenggu.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 辽宁证监局 | https://www.csrc.gov.cn/liaoning/index.shtml | 启用 | 官网页面与截图正常（200） |
| 辽宁税务局 | http://liaoning.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 吉林证监局 | https://www.csrc.gov.cn/jilin/index.shtml | 启用 | 官网页面与截图正常（200） |
| 吉林税务局 | http://jilin.chinatax.gov.cn/ | 暂停 | HTTP访问失败（412） |
| 黑龙江证监局 | https://www.csrc.gov.cn/heilongjiang/index.shtml | 启用 | 官网页面与截图正常（200） |
| 黑龙江税务局 | http://heilongjiang.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 上海证监局 | https://www.csrc.gov.cn/shanghai/index.shtml | 启用 | 官网页面与截图正常（200） |
| 上海税务局 | http://shanghai.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 江苏证监局 | https://www.csrc.gov.cn/jiangsu/index.shtml | 启用 | 官网页面与截图正常（200） |
| 江苏税务局 | http://jiangsu.chinatax.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 浙江证监局 | https://www.csrc.gov.cn/zhejiang/index.shtml | 启用 | 官网页面与截图正常（200） |
| 浙江税务局 | http://zhejiang.chinatax.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 安徽证监局 | https://www.csrc.gov.cn/anhui/index.shtml | 启用 | 官网页面与截图正常（200） |
| 安徽税务局 | http://anhui.chinatax.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 福建证监局 | https://www.csrc.gov.cn/fujian/index.shtml | 启用 | 官网页面与截图正常（200） |
| 福建税务局 | http://fujian.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 江西证监局 | https://www.csrc.gov.cn/jiangxi/index.shtml | 启用 | 官网页面与截图正常（200） |
| 江西税务局 | http://jiangxi.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 山东证监局 | https://www.csrc.gov.cn/shandong/index.shtml | 启用 | 官网页面与截图正常（200） |
| 山东税务局 | http://shandong.chinatax.gov.cn/ | 暂停 | HTTP访问失败（400） |
| 河南证监局 | https://www.csrc.gov.cn/henan/index.shtml | 启用 | 官网页面与截图正常（200） |
| 河南税务局 | https://henan.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 湖北证监局 | https://www.csrc.gov.cn/hubei/index.shtml | 启用 | 官网页面与截图正常（200） |
| 湖北税务局 | http://hubei.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 湖南证监局 | https://www.csrc.gov.cn/hunan/index.shtml | 启用 | 官网页面与截图正常（200） |
| 湖南税务局 | http://hunan.chinatax.gov.cn/ | 暂停 | HTTP访问失败（412） |
| 广东证监局 | https://www.csrc.gov.cn/guangdong/index.shtml | 启用 | 官网页面与截图正常（200） |
| 广东税务局 | http://guangdong.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 广西证监局 | https://www.csrc.gov.cn/guangxi/index.shtml | 启用 | 官网页面与截图正常（200） |
| 广西税务局 | https://guangxi.chinatax.gov.cn/ | 暂停 | 网络连接失败 |
| 海南证监局 | https://www.csrc.gov.cn/hainan/index.shtml | 启用 | 官网页面与截图正常（200） |
| 海南税务局 | http://hainan.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 重庆证监局 | https://www.csrc.gov.cn/chongqing/index.shtml | 启用 | 官网页面与截图正常（200） |
| 重庆税务局 | http://chongqing.chinatax.gov.cn/ | 暂停 | HTTP访问失败（504） |
| 四川证监局 | https://www.csrc.gov.cn/sichuan/index.shtml | 启用 | 官网页面与截图正常（200） |
| 四川税务局 | http://sichuan.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 贵州证监局 | https://www.csrc.gov.cn/guizhou/index.shtml | 启用 | 官网页面与截图正常（200） |
| 贵州税务局 | http://guizhou.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 云南证监局 | https://www.csrc.gov.cn/yunnan/index.shtml | 启用 | 官网页面与截图正常（200） |
| 云南税务局 | http://yunnan.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 西藏证监局 | https://www.csrc.gov.cn/xizang/index.shtml | 启用 | 官网页面与截图正常（200） |
| 西藏税务局 | https://xizang.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 陕西证监局 | https://www.csrc.gov.cn/shaanxi/index.shtml | 启用 | 官网页面与截图正常（200） |
| 陕西税务局 | https://shaanxi.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 甘肃证监局 | https://www.csrc.gov.cn/gansu/index.shtml | 启用 | 官网页面与截图正常（200） |
| 甘肃税务局 | http://gansu.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 青海证监局 | https://www.csrc.gov.cn/qinghai/index.shtml | 启用 | 官网页面与截图正常（200） |
| 青海税务局 | http://qinghai.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 宁夏证监局 | https://www.csrc.gov.cn/ningxia/index.shtml | 启用 | 官网页面与截图正常（200） |
| 宁夏税务局 | http://ningxia.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 新疆证监局 | https://www.csrc.gov.cn/xinjiang/index.shtml | 启用 | 官网页面与截图正常（200） |
| 新疆税务局 | https://xinjiang.chinatax.gov.cn/ | 暂停 | HTTP访问失败（412） |
| 深圳证监局 | https://www.csrc.gov.cn/shenzhen/index.shtml | 启用 | 官网页面与截图正常（200） |
| 深圳税务局 | https://shenzhen.chinatax.gov.cn/ | 暂停 | 网络连接失败 |
| 大连证监局 | https://www.csrc.gov.cn/dalian/index.shtml | 启用 | 官网页面与截图正常（200） |
| 大连税务局 | http://dalian.chinatax.gov.cn/ | 暂停 | HTTP访问失败（510） |
| 宁波证监局 | https://www.csrc.gov.cn/ningbo/index.shtml | 启用 | 官网页面与截图正常（200） |
| 宁波税务局 | http://ningbo.chinatax.gov.cn/ | 暂停 | 未完成页面打开或截图 |
| 厦门证监局 | https://www.csrc.gov.cn/xiamen/index.shtml | 启用 | 官网页面与截图正常（200） |
| 厦门税务局 | http://xiamen.chinatax.gov.cn/ | 暂停 | HTTP访问失败（503） |
| 青岛证监局 | https://www.csrc.gov.cn/qingdao/index.shtml | 启用 | 官网页面与截图正常（200） |
| 青岛税务局 | http://qingdao.chinatax.gov.cn/ | 启用 | 官网页面与截图正常（200） |

## 历史入口

| 网站/入口 | 地址 | 状态 | 本次访问结果 |
|---|---|---|---|
| 国家企业信用信息公示系统 | https://www.gsxt.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 中国执行信息公开网 | https://zxgk.court.gov.cn/ | 暂停 | HTTP访问失败（403） |
| 中国裁判文书网 | https://wenshu.court.gov.cn/ | 启用 | 官网页面与截图正常（200） |
| 食品药品监管部门门户 | https://www.samr.gov.cn/ | 暂停 | 官网页面与截图正常（200） |
| 食品药品监管部门门户 | https://www.nmpa.gov.cn/ | 暂停 | HTTP访问失败（412） |

代码完成后仍需按发布规则上线。本报告是访问性测试，未将首页、验证码或未完成查询冒充“无记录”结论。
