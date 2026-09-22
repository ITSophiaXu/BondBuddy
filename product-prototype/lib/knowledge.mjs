import { SCOPE_NAMES } from '../public/markets.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readJson } from './platform.mjs';
import { packDocument, retrieve } from './review.mjs';
export const SCOPES = Object.keys(SCOPE_NAMES);
export const manifest = () => readJson(join(ROOT,'knowledge','manifest.json'));
export async function loadKnowledge(scope,kind) {
  if (!SCOPES.includes(scope) || !['update','review'].includes(kind)) throw new Error('不支持的知识范围。');
  if(scope.startsWith('nafmii-'))return bankKnowledge(scope,kind);
  const originalScope=scope;scope=scope.replace('-public_all','-public');
  const id=`${scope}-${kind}`, base=join(ROOT,'knowledge',id);
  const data=await readJson(base+'.json');
  const handbook=await readFile(base+'.md','utf8');
  const sourceChunks=[];
  for (const source of data.sources) {
    const content=await readFile(join(ROOT,'knowledge','sources',source+'.md'),'utf8');
    sourceChunks.push(...packDocument({id:source,role:'knowledge',filename:source,records:content.split('\n').filter(Boolean).map((text,i)=>({locator:`L${i+1}`,text}))},5000));
  }
  return {...data,scope:originalScope,handbook:handbook+'\n本项目选择：'+SCOPE_NAMES[originalScope]+'。小公募面向专业投资者，大公募面向普通投资者；资格与适当性条件需逐项核实，不能因选项已选而认定已满足。',conflicts:'规则效力、适用条件、专家阈值与项目事实必须区分；未能解析的源文件不能作为已核验依据。',sourceChunks};
}
export const relatedKnowledge = (knowledge,query) => retrieve(query,knowledge.sourceChunks,2).map(c=>c.text).join('\n\n');

function bankKnowledge(scope,kind){
  const instrument=scope.split('-')[1];
  const checks=[['主体与口径','区分发行人、合并与母公司；核对期间、单位、币种与来源。'],['注册与发行安排','核对注册通知、实际工具品种、注册额度、有效期和发行方式；DFI是注册模式，不替代实际发行品种。'],['财务与业务披露','核对年度和最近一期数据、审计意见、分业务收入、变动原因和相关引用。'],['资金用途','核对资金用途、对应金额、偿债或项目资料及决策文件；未核实事项列待补证。'],['债务与偿付','区分报告期末债务、当前存续工具和历史兑付记录，不以应付债券余额替代完整清单。'],['投资者保护与信息披露','采用该工具适用的持有人会议、违约处置和信息披露安排；不能直接套用交易所公司债受托管理规则。'],['专项条款','结合具体工具核对期限、含权、增信和专项条款。ABN/ABCP须核对基础资产、现金流、参与主体、服务机构及风险隔离，PRN须核对项目现金流和偿债安排。'],['版本与规则时点','本规则为内部核对方法；现行细项需依发行时有效的交易商协会规则和项目文件核实。缺少正式依据时列未覆盖，不作合规通过结论。']];
  return {id:scope+'-'+kind,scope,kind,title:SCOPE_NAMES[scope],version:'2026.09-workspace.1',sources:[],sourceChunks:[],conflicts:'尚未完成实时官方规则核验；未提供的正式规则不可当作已核验依据。',rules:checks.map(([title,logic],i)=>({rule_id:'NAFMII-'+instrument+'-'+(i+1),title,locations:'相关章节',trigger:'按所选工具及材料适用性判断',check_logic:logic,basis_type:'内部核对方法，非官方规则原文',sources:''})),handbook:'# 银行间债务融资工具项目核对\n本项目：'+SCOPE_NAMES[scope]+'\n'+checks.map(([title,logic])=>'## '+title+'\n'+logic).join('\n')};
}
