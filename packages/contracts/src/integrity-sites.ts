import { REGION_PORTALS } from './integrity-regions.js';
export type IntegritySite = { id: string; name: string; group: string; topic: string; companyOnly?: boolean; links: { label: string; url: string }[] };
const site = (id: string, name: string, group: string, topic: string, url: string, companyOnly = false): IntegritySite => ({ id, name, group, topic, companyOnly, links: [{ label: '官网入口', url }] });
// Website inventory follows http://127.0.0.1:4318/ (2026-10-19).
// Links are portal entry points, not an assertion that automated search is available.
export const INTEGRITY_SITES: IntegritySite[] = [
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

const specialCities:Record<string,string>={深圳:'广东',厦门:'福建',宁波:'浙江',青岛:'山东',大连:'辽宁'};
export const INTEGRITY_PROVINCES=REGION_PORTALS.filter(r=>!(r.name in specialCities)).map(r=>r.name);
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
/** Regional CSRC evidence must belong to that bureau, not another bureau on the same host. */
export function integritySourceAllowed(site:IntegritySite,value:string){
  try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.port)return false;
    return site.links.some(l=>{const p=new URL(l.url);return u.hostname===p.hostname&&(!site.id.startsWith('local-csrc')||u.pathname.startsWith(p.pathname.replace(/index\.shtml$/,'')));});
  }catch{return false;}
}
