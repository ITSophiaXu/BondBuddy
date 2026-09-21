// Shared taxonomy and explainable matching. Unknown values never count as matches.
export const LIBRARY_SOURCES=[
  {id:'sse',name:'上海证券交易所',short:'上交所',url:'http://bond.sse.com.cn/bridge/information/#',hosts:['bond.sse.com.cn','www.sse.com.cn','static.sse.com.cn']},
  {id:'szse',name:'深圳证券交易所',short:'深交所',url:'http://bond.szse.cn/disclosure/progressinfo/index.html',hosts:['bond.szse.cn','www.szse.cn','reportdocs.static.szse.cn','disc.static.szse.cn']},
  {id:'nafmii',name:'中国银行间市场交易商协会',short:'交易商协会',url:'http://zhuce.nafmii.org.cn/fans/publicQuery/manager',hosts:['zhuce.nafmii.org.cn','www.nafmii.org.cn']}
];
export const INSTRUMENTS=['公司债券','企业债券','中期票据（MTN）','短期融资券（CP）','超短期融资券（SCP）','定向债务融资工具（PPN）','资产支持证券 / 票据','其他'];
export const INDUSTRIES=['城市建设与基础设施','交通运输','公用事业','房地产','制造业','能源与采矿','商贸零售','金融','信息技术','综合','其他'];
export const OWNERSHIPS=['中央国有企业','地方国有企业','民营企业','外商投资企业','其他'];
export const ASSET_BANDS=['100亿元以下','100—500亿元','500—1000亿元','1000亿元以上'];
export const PROJECT_STATUSES=['未知 / 待核实','审核通过','注册生效','已发行','受理 / 审核中','终止 / 撤回'];
export const OFFERINGS={public:'公开发行',private:'非公开发行',unknown:'待核实'};
export const PROFILE_FIELDS=[
  {key:'industry',label:'所属行业',options:INDUSTRIES},
  {key:'region',label:'所在省市',placeholder:'例如：江苏省'},
  {key:'ownership',label:'企业性质',options:OWNERSHIPS},
  {key:'assetBand',label:'总资产规模',options:ASSET_BANDS}
];
export function blueprintEligibility(item,target={}){
  const reasons=[];
  if(item.supersededBy)reasons.push('已有更新的收录版本，请查看新版本');
  if(!item.confirmedAt)reasons.push('来源及文件尚未人工核对');
  if(!item.file)reasons.push('尚未收录正文文件');
  else if(!item.textReady)reasons.push('正文无法提取文字，需补充可解析文件');
  if(!['审核通过','注册生效','已发行'].includes(item.projectStatus))reasons.push('项目状态尚不满足通过、注册或发行条件');
  if(item.market==='nafmii'||item.instrument!=='公司债券')reasons.push('该品种暂仅供浏览，当前编制支持交易所公司债');
  if(!['public','private'].includes(item.offering))reasons.push('发行方式尚未核实');
  if(target.exchange&&target.exchange!==item.market)reasons.push('与本项目交易所不同');
  if(target.offering&&target.offering!==item.offering)reasons.push('与本项目发行方式不同');
  return {eligible:!reasons.length,reasons};
}
export function matchProspectus(item,target={},now=new Date()){
  let score=0,available=0;const reasons=[],differences=[],unknown=[];
  const dimensions=[['exchange','market','交易所',25],['offering','offering','发行方式',20],['industry','industry','行业',25],['ownership','ownership','企业性质',10],['region','region','地区',5],['assetBand','assetBand','资产规模',5]];
  for(const [key,field,label,weight] of dimensions){if(!target[key])continue;available+=weight;if(!item[field]||item[field]==='unknown'){unknown.push(label+'信息缺失');continue;}if(target[key]===item[field]){score+=weight;reasons.push(label+'相同');}else differences.push(label+'不同');}
  // Recency breaks ties; it is never described as an approval or a compliance score.
  if(item.publishedAt){available+=10;const age=(now-new Date(item.publishedAt))/86400000;const points=age>=0&&age<=730?10:age<=1460&&age>=0?5:0;score+=points;if(points===10)reasons.push('近两年披露');else if(!points)differences.push('版本较早，需核对现行披露要求');}
  else unknown.push('披露日期缺失');
  return {score,available,reasons,differences,unknown,...blueprintEligibility(item,target)};
}
