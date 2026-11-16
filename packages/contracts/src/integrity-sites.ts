import { REGION_PORTALS } from './integrity-regions.js';
import { INTEGRITY_VERIFIED_ENDPOINTS } from './integrity-site-availability.js';
export type IntegritySite = { id: string; name: string; group: string; topic: string; companyOnly?: boolean; legacy?: boolean; queryTerms?: string[]; links: { label: string; url: string }[] };
const site = (id: string, name: string, group: string, topic: string, url: string, companyOnly = false): IntegritySite => ({ id, name, group, topic, companyOnly, links: [{ label: '官网入口', url }] });
// Website inventory follows http://127.0.0.1:4318/ (2026-10-19).
// Links are portal entry points, not an assertion that automated search is available.
const PREVIOUS_SITES: IntegritySite[] = [
  site('gsxt', '国家企业信用信息公示系统', '信用与司法', '企业登记、经营异常与严重违法失信', 'https://www.gsxt.gov.cn/', true),
  site('execution', '中国执行信息公开网', '信用与司法', '被执行人与失信被执行人信息', 'https://zxgk.court.gov.cn/'),
  site('judgments', '中国裁判文书网', '信用与司法', '公开裁判文书及涉诉记录', 'https://wenshu.court.gov.cn/'),
  site('csrc', '证券期货市场失信记录查询平台', '信用与司法', '证券期货市场失信记录', 'https://neris.csrc.gov.cn/shixinchaxun/'),
  site('credit-china', '信用中国', '信用与司法', '公共信用、行政处罚及严重失信信息', 'https://www.creditchina.gov.cn/'),
  site('tax', '国家税务总局', '税务与综合监管', '重大税收违法失信与税务公告', 'https://www.chinatax.gov.cn/'),
  site('resources', '自然资源部', '行业监管', '自然资源领域行政处罚与公开通报', 'https://www.mnr.gov.cn/'),
  site('customs', '海关总署', '行业监管', '海关信用及行政处罚公开信息', 'http://www.customs.gov.cn/'),
  site('emergency', '应急管理部', '行业监管', '安全生产失信及行政处罚信息', 'https://www.mem.gov.cn/'),
  site('environment', '生态环境部', '行业监管', '生态环境领域处罚与通报', 'https://www.mee.gov.cn/'),
  site('industry', '工业和信息化部', '行业监管', '工业和信息化领域监管公告', 'https://www.miit.gov.cn/'),
  { ...site('food-drug', '食品药品监管部门门户', '行业监管', '按食品、药品业务选择对应监管门户', 'https://www.samr.gov.cn/'), links: [{ label: '食品 · 市场监管总局', url: 'https://www.samr.gov.cn/' }, { label: '药品 · 国家药监局', url: 'https://www.nmpa.gov.cn/' }] },
  site('statistics', '国家统计局', '税务与综合监管', '统计严重失信与处罚公示', 'https://www.stats.gov.cn/'),
  site('ndrc', '国家发改委', '税务与综合监管', '发展改革领域信用及处罚公示', 'https://www.ndrc.gov.cn/'),
  site('energy', '国家能源局', '行业监管', '能源领域行政处罚与监管通报', 'https://www.nea.gov.cn/'),
  site('agriculture', '国家农业农村部', '行业监管', '农业农村领域行政处罚与通报', 'https://www.moa.gov.cn/'),
  site('housing', '住房和城乡建设部', '行业监管', '住房城乡建设领域信用及处罚', 'https://www.mohurd.gov.cn/'),
  site('samr', '国家市场监督管理总局', '税务与综合监管', '市场监管行政处罚及失信信息', 'https://www.samr.gov.cn/'),
  site('local-csrc', '当地证监局', '属地监管', '按企业注册地选择证监局，核查行政处罚与监管措施', 'https://www.csrc.gov.cn/', true),
  site('local-tax', '当地税务局', '属地监管', '按企业注册地选择税务局，核查税收违法失信与处罚公告', 'https://www.chinatax.gov.cn/', true),
];

/** Ordered row by row from the user's 2026-10-22 screenshot. Portals are not a guarantee of automated access. */
const basic = '基础征信', finance = '金融监管', other = '其他领域';
const scoped = (id: string, name: string, group: string, topic: string, url: string, queryTerms: string[], companyOnly = false): IntegritySite =>
  ({ ...site(id, name, group, topic, url, companyOnly), queryTerms });
const CATALOG_SITES: IntegritySite[] = [
  site('credit-china', '信用中国', basic, '公共信用、行政处罚及严重失信信息', 'https://www.creditchina.gov.cn/'),
  scoped('execution-dishonest', '中国执行信息网-失信被执行人', basic, '失信被执行人名单', 'https://zxgk.court.gov.cn/shixin/', ['失信']),
  scoped('execution-debtor', '中国执行信息网-被执行人信息', basic, '被执行人案件信息', 'https://zxgk.court.gov.cn/zhixing/', ['被执行人信息']),
  scoped('execution-restriction', '中国执行信息网-限制消费信息', basic, '限制消费人员信息', 'https://zxgk.court.gov.cn/xgl/', ['限制消费', '限高']),
  site('bankruptcy', '全国企业破产重整案件信息网', basic, '企业破产与重整案件', 'https://pccz.court.gov.cn/', true),
  site('tax', '国家税务总局', basic, '税务监管公告', 'https://www.chinatax.gov.cn/'),
  scoped('tax-dishonest', '重大税收违法失信案件信息公布栏', basic, '从税务总局门户查询重大税收违法失信案件公布信息', 'https://www.chinatax.gov.cn/', ['重大税收违法', '税收违法失信']),
  site('industry-credit', '全国行业信用公共服务平台', basic, '行业信用评价与信用信息', 'https://www.bcp12312.org.cn/', true),

  site('pbc', '中国人民银行', finance, '人民银行行政处罚与监管公告', 'https://www.pbc.gov.cn/'),
  site('nfra', '国家金融监督管理总局', finance, '金融监管处罚与公开信息', 'https://www.nfra.gov.cn/'),
  site('csrc-portal', '中国证监会', finance, '证券期货监管公告与行政处罚', 'https://www.csrc.gov.cn/'),
  site('csrc', '中国证券监督管理委员会-证券期货市场失信记录查询平台', finance, '证券期货市场失信记录', 'https://neris.csrc.gov.cn/shixinchaxun/'),
  site('sse', '上海证券交易所', finance, '交易所监管信息与纪律处分', 'https://www.sse.com.cn/'),
  site('bse', '北京证券交易所', finance, '交易所监管信息与纪律处分', 'https://www.bse.cn/'),
  site('szse', '深圳证券交易所-首页', finance, '交易所公开监管信息', 'https://www.szse.cn/'),
  scoped('szse-bond-discipline', '深圳证券交易所-债券纪律处分', finance, '从深交所门户查询债券纪律处分', 'https://www.szse.cn/', ['债券纪律处分', '债券 纪律处分']),
  scoped('szse-supervision', '深圳证券交易所-监管措施', finance, '从深交所门户查询监管措施', 'https://www.szse.cn/', ['监管措施']),
  site('safe', '国家外汇管理局', finance, '外汇行政处罚与监管公告', 'https://www.safe.gov.cn/'),
  site('neeq', '全国中小企业股份转让系统', finance, '全国股转系统监管信息与纪律处分', 'https://www.neeq.com.cn/'),
  scoped('nafmii-discipline', '中国银行间市场交易商协会-自律处分概览', finance, '交易商协会自律处分信息', 'https://www.nafmii.org.cn/', ['自律处分']),
  site('sac', '中国证券业协会', finance, '证券行业自律与诚信信息', 'https://www.sac.net.cn/'),
  site('amac', '中国证券投资基金业协会', finance, '基金行业自律与诚信信息', 'https://www.amac.org.cn/'),
  site('mofcom', '中华人民共和国商务部', finance, '商务领域监管与信用公告', 'https://www.mofcom.gov.cn/'),
  site('commerce-credit', '商务信用服务平台', finance, '商务信用记录与企业信用信息', 'https://www.bcpcn.com/', true),
  scoped('cfa-credit', '中国期货业协会-期货公司诚信记录信息', finance, '从期货业协会门户查询期货公司诚信记录', 'https://www.cfachina.org/', ['诚信记录'], true),
  scoped('cfa-discipline', '中国期货业协会-纪律惩戒', finance, '从期货业协会门户查询纪律惩戒', 'https://www.cfachina.org/', ['纪律惩戒', '纪律处分']),

  site('emergency', '中华人民共和国应急管理部', other, '安全生产失信及行政处罚信息', 'https://www.mem.gov.cn/'),
  site('ndrc', '国家发展和改革委员会', other, '发展改革领域信用及处罚公示', 'https://www.ndrc.gov.cn/'),
  site('environment', '中华人民共和国生态环境部', other, '生态环境领域处罚与通报', 'https://www.mee.gov.cn/'),
  site('mof', '中华人民共和国财政部', other, '财政领域行政处罚与公开通报', 'https://www.mof.gov.cn/'),
  site('statistics', '国家统计局', other, '统计严重失信与处罚公示', 'https://www.stats.gov.cn/'),
  site('customs', '中华人民共和国海关总署', other, '海关信用及行政处罚公开信息', 'http://www.customs.gov.cn/'),
  site('industry', '中华人民共和国工业和信息化部', other, '工业和信息化领域监管公告', 'https://www.miit.gov.cn/'),
  site('samr', '国家市场监督管理总局', other, '市场监管行政处罚及失信信息', 'https://www.samr.gov.cn/'),
  scoped('samr-penalties', '国家市场监督管理总局-中国市场监管行政处罚文书网', other, '从市场监管总局门户查询行政处罚文书', 'https://www.samr.gov.cn/', ['行政处罚文书']),
  site('agriculture', '农业农村部', other, '农业农村领域行政处罚与通报', 'https://www.moa.gov.cn/'),
  site('customs-credit', '中国海关企业进出口信用信息公示平台', other, '进出口企业信用信息', 'http://credit.customs.gov.cn/', true),
  site('energy', '国家能源局', other, '能源领域行政处罚与监管通报', 'https://www.nea.gov.cn/'),
  site('housing', '国家住房和城乡建设部', other, '住房城乡建设领域信用及处罚', 'https://www.mohurd.gov.cn/'),
  scoped('cec-blacklist', '中国电力企业联合会-信用电力-关联黑名单', other, '从中电联门户查询信用电力关联黑名单', 'https://www.cec.org.cn/', ['关联黑名单', '黑名单'], true),
  scoped('cec-supervision', '中国电力企业联合会-信用电力-监管、大数据预警', other, '从中电联门户查询信用电力监管与大数据预警信息', 'https://www.cec.org.cn/', ['监管', '大数据预警'], true),
  site('resources', '自然资源部', other, '自然资源领域行政处罚与公开通报', 'https://www.mnr.gov.cn/'),
  site('mohrss', '人力资源和社会保障部', other, '劳动保障行政处罚与失信信息', 'https://www.mohrss.gov.cn/'),
  site('transport', '交通运输部', other, '交通运输监管与处罚公告', 'https://www.mot.gov.cn/'),
  scoped('transport-credit', '信用交通-信用信息查询', other, '信用交通信用信息查询', 'https://credit.mot.gov.cn/', ['信用信息']),
  scoped('transport-penalties', '信用交通-行政处罚', other, '信用交通行政处罚信息', 'https://credit.mot.gov.cn/', ['行政处罚']),
  site('construction-credit', '全国建筑市场监管公共服务平台', other, '建筑企业与从业人员信用记录', 'https://jzsc.mohurd.gov.cn/'),
  scoped('salt-credit', '信用盐业-盐行业信用管理与公共服务平台', other, '从中国盐业协会门户进入信用盐业查询', 'https://www.cnsalt.cn/', ['信用盐业', '信用'], true),
  scoped('procurement-agency', '中国政府采购网-代理机构不良行为记录名单', other, '政府采购代理机构不良行为记录', 'https://www.ccgp.gov.cn/', ['代理机构不良行为'], true),
  scoped('procurement-dishonest', '中国政府采购网-政府采购严重违法失信行为记录名单', other, '政府采购严重违法失信行为记录', 'https://www.ccgp.gov.cn/', ['严重违法失信'], true),
  site('salt-association', '中国盐业协会', other, '盐行业公开监管与信用信息', 'https://www.cnsalt.cn/'),
  site('nmpa', '国家药品监督管理局', other, '药品监管行政处罚与公开通报', 'https://www.nmpa.gov.cn/'),

  ...PREVIOUS_SITES.filter(s => s.group === '属地监管'),
];
// New checks only use endpoints verified by the live website sweep.
// Keep all metadata below for immutable historical runs, evidence and free exports.
export const isRetiredIntegritySite = (id: string): boolean => {
  const item = CATALOG_SITES.find(site => site.id === id) ?? PREVIOUS_SITES.find(site => site.id === id);
  if (!item) return false; // Unknown IDs still receive the API's explicit validation error.
  const verified = INTEGRITY_VERIFIED_ENDPOINTS[id] ?? [];
  return id === 'local-csrc' || id === 'local-tax' ? verified.length === 0 : !item.links.every(link => verified.includes(link.url));
};
export const removeRetiredIntegritySites = (ids: readonly string[]): string[] => ids.filter(id => !isRetiredIntegritySite(id));
export const INTEGRITY_SELECTABLE_SITES: IntegritySite[] = CATALOG_SITES.filter(s => !isRetiredIntegritySite(s.id));

// Other prior IDs can still be shown when a saved draft selects them.
export const INTEGRITY_SITES: IntegritySite[] = [
  ...CATALOG_SITES,
  ...PREVIOUS_SITES.filter(s => !CATALOG_SITES.some(current => current.id === s.id)).map(s => ({ ...s, legacy: true, group: '历史网站范围' })),
];
export const INTEGRITY_SITE_LIMIT = INTEGRITY_SITES.length;

const specialCities:Record<string,string>={深圳:'广东',厦门:'福建',宁波:'浙江',青岛:'山东',大连:'辽宁'};
export const INTEGRITY_PROVINCES=REGION_PORTALS.filter(r=>!(r.name in specialCities)).map(r=>r.name);
/** Reuse explicit registration first; infer only unambiguous locality prefixes, never a person's name. */
export function inferIntegrityRegion(subject:{name:string;kind:string;province:string;city:string}){
 const normalize=(s:string)=>s.trim().replace(/省$|市$|壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/g,'');
 if(subject.province.trim())return {province:normalize(subject.province),city:subject.city.trim()};
 if(subject.kind!=='company')return {province:'',city:subject.city.trim()};
 const prefix=subject.name.trim().replace(/^[（(]/,'');
 const province=INTEGRITY_PROVINCES.find(p=>prefix.startsWith(p)||normalize(subject.city)===p);
 return {province:province??specialCities[normalize(subject.city)]??'',city:subject.city.trim()};
}
export function integrityPortal(province:string,city:string){
  province=province.replace(/省$|市$|壮族自治区$|回族自治区$|维吾尔自治区$|自治区$/g,'');city=city.trim().replace(/市$/,'');
  if((!city&&Object.values(specialCities).includes(province))||(specialCities[city]&&specialCities[city]!==province))return undefined;
  return REGION_PORTALS.find(r=>r.name===(specialCities[city]===province?city:province));
}
export function resolveIntegritySite(site:IntegritySite,subject:{province:string;city:string}):IntegritySite{
  if(!site.id.startsWith('local-'))return structuredClone(site);
  const p=integrityPortal(subject.province,subject.city);
  return {...site,name:p?p.name+(site.id==='local-csrc'?'证监局':'税务局'):site.name,links:p?[{label:'官网入口',url:site.id==='local-csrc'?p.csrc:p.tax}]:[]};
}
export type IntegrityAvailabilitySubject = {name: string; kind: string; province: string; city: string};
/** A regional checkbox applies to every company in a draft. Do not silently drop one company's scope. */
export function isIntegritySiteAvailableForSubjects(id: string, subjects: readonly IntegrityAvailabilitySubject[]) {
  if (isRetiredIntegritySite(id)) return false;
  if (id !== 'local-csrc' && id !== 'local-tax') return true;
  const companies = subjects.filter(subject => subject.kind === 'company');
  const site = INTEGRITY_SITES.find(site => site.id === id)!;
  return companies.length > 0 && companies.every(subject => {
    const resolved = resolveIntegritySite(site, {...subject, ...inferIntegrityRegion(subject)});
    return resolved.links.length > 0 && resolved.links.every(link => INTEGRITY_VERIFIED_ENDPOINTS[id]?.includes(link.url));
  });
}
export const removeUnavailableIntegritySites = (ids: readonly string[], subjects: readonly IntegrityAvailabilitySubject[]): string[] =>
  ids.filter(id => isIntegritySiteAvailableForSubjects(id, subjects));
export const integritySelectableSitesForSubjects = (subjects: readonly IntegrityAvailabilitySubject[]): IntegritySite[] =>
  INTEGRITY_SELECTABLE_SITES.filter(site => isIntegritySiteAvailableForSubjects(site.id, subjects));

/** Regional CSRC evidence must belong to that bureau, not another bureau on the same host. */
export function integritySourceAllowed(site:IntegritySite,value:string){
  try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)return false;
    return site.links.some(l=>{const p=new URL(l.url);return u.hostname===p.hostname&&(!site.id.startsWith('local-csrc')||u.pathname.startsWith(p.pathname.replace(/index\.shtml$/,'')));});
  }catch{return false;}
}

/** A shared domain does not establish that every separately selected topic was searched. */
export function integrityQueryAllowed(site:IntegritySite,query:string,scope:string){
  try{
    const scoped=new URL('https://'+scope);
    if(!['https:','http:'].includes(scoped.protocol)||scoped.username||scoped.password||scoped.port)return false;
    const compact=query.replace(/\s+/g,'');
    return site.links.some(link=>{
      const portal=new URL(link.url);
      if(scoped.hostname!==portal.hostname)return false;
      if(site.id==='local-csrc')return scoped.pathname.startsWith(portal.pathname.replace(/index\.shtml$/,''));
      const section=portal.pathname!=='/'&&scoped.pathname.startsWith(portal.pathname);
      return !site.queryTerms?.length||section||site.queryTerms.some(term=>compact.includes(term.replace(/\s+/g,'')));
    });
  }catch{return false;}
}
