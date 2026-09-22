// Plan relevant queries without calling any service.
export const hasExternalData=quota=>!!quota?.active&&(quota.externalData===true||quota.plan==='credits'||quota.plan==='professional');

export function planQueries({kind='generate',prompt='',connectors=[],webAvailable=false,registryAvailable=false,externalDataAllowed=true}) {
  const workflow=['update','review'].includes(kind);
  const materialsOnly=/(?:不要|无需|不需要|禁止)(?:进行)?(?:联网|外部查询)|(?:仅|只)(?:根据|依据|使用)(?:已上传的?|上传的?|现有的?|项目)?材料/.test(prompt);
  const bonds=workflow||/兑付|存续|到期债券|债券发行记录|发行过.{0,10}公司债|全部公司债|Wind|企业预警通|预警通/i.test(prompt);
  const registry=workflow||/工商|股东|实际控制人|实控人|法定代表人|企业登记|注册资本|关联企业|企查查|天眼查/.test(prompt);
  const web=kind==='review'||/联网|(?:搜索|检索).{0,12}(?:网页|新闻|公告|公开)|(?:最新|近期|近日).{0,12}(?:公告|新闻|政策|法规|消息)|公开公告/.test(prompt);
  const wanted={bonds,registry,search:web};
  const namedService=connectors.some(c=>c.name&&prompt.includes(c.name))||/Wind|企业预警通|预警通|企查查/i.test(prompt);
  if(!externalDataAllowed)return {mode:'auto',web:false,registry:false,connectorIds:[],bondQuery:false,requiresProfessional:!materialsOnly&&(bonds||registry||web||namedService),limitations:materialsOnly?['本次按要求仅使用现有材料，未执行外部查询。']:bonds||registry||web||namedService?['当前套餐仅依据项目与上传材料处理，未查询外部数据；工商、企业预警通、Wind 等查询为专业版权益。']:[]};
  const chosen=materialsOnly?[]:connectors.filter(c=>c.enabled&&(wanted[c.purpose]||(c.purpose==='other'&&c.name&&prompt.includes(c.name))));
  const useWeb=!materialsOnly&&web&&webAvailable,useRegistry=!materialsOnly&&registry&&registryAvailable,limitations=[];
  if(materialsOnly)limitations.push('本次按要求仅使用现有材料，未执行外部查询。');
  else {
    if(bonds&&!chosen.some(c=>c.purpose==='bonds'))limitations.push('本次未连接债券数据服务，全部公司债的兑付与存续情况尚未完成外部核验。');
    if(registry&&!useRegistry&&!chosen.some(c=>c.purpose==='registry'))limitations.push('本次未获得外部工商信息，相关事项仅依据现有材料判断。');
    if(web&&!useWeb&&!chosen.some(c=>c.purpose==='search'))limitations.push('本次未执行联网搜索，最新公开信息尚未核验。');
  }
  return {mode:'auto',web:useWeb,registry:useRegistry,connectorIds:chosen.map(c=>c.id),bondQuery:bonds&&!materialsOnly,limitations};
}
