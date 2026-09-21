import { PROFILE_FIELDS } from './library-schema.js';
// Shared by the form and server: blank optional values mean unknown, never "no".
const yn=['是','否'];
const text=(key,label,placeholder='',extra={})=>({key,label,placeholder,...extra});
const select=(key,label,options=yn,extra={})=>({key,label,options,...extra});
const specialTypes=['短期公司债券','可续期公司债券','可交换公司债券','绿色债券','乡村振兴债券','低碳转型债券','科技创新债券','一带一路债券','纾困债券','中小微企业支持债券','其他'];
export const OPTIONAL_GROUPS=[
  {title:'蓝图匹配信息',description:'用于推荐相似企业募集书，均为选填；缺少时不推断企业属性。',fields:PROFILE_FIELDS},
  {title:'发行人补充资料',description:'简称和统一社会信用代码可留空，后续结合工商材料核对。',fields:[text('issuerShortName','发行人简称'),text('creditCode','统一社会信用代码')]},
  {title:'发行规模与债券品种',description:'区分本次申报总额与本期发行额；一个或两个品种均可，不确定的安排可以留空。',fields:[text('registrationAmount','本次申报总额','例如：不超过30亿元'),text('size','本期发行金额','例如：不超过10亿元'),text('term','品种一 · 债券期限','例如：3年或3+2年'),select('trancheOneOptions','品种一 · 是否含权'),text('trancheOneOptionTerms','品种一 · 含权安排','例如：回售、赎回、票面利率调整',{when:['trancheOneOptions','是']}),select('trancheOneSpecial','品种一 · 是否为专项品种'),select('trancheOneSpecialType','品种一 · 专项债券品种',specialTypes,{when:['trancheOneSpecial','是']}),text('secondTerm','品种二 · 债券期限','如无第二品种可留空'),select('trancheTwoOptions','品种二 · 是否含权'),text('trancheTwoOptionTerms','品种二 · 含权安排','例如：回售、赎回',{when:['trancheTwoOptions','是']}),select('trancheTwoSpecial','品种二 · 是否为专项品种'),select('trancheTwoSpecialType','品种二 · 专项债券品种',specialTypes,{when:['trancheTwoSpecial','是']})]},
  {title:'参与机构',description:'仅一家主承销商时填写主承销商即可，联席主承销商留空。',fields:[text('leadUnderwriter','主承销商 / 牵头主承销商'),text('coUnderwriters','联席主承销商'),text('bookrunner','簿记管理人'),text('trustee','受托管理人')]},
  {title:'评级与增信',description:'未选择表示尚未提供，不会默认认定为不评级或不增信。',fields:[select('hasRating','是否评级'),text('issuerRating','主体评级','例如：AA+',{when:['hasRating','是']}),text('bondRating','债项评级','例如：AAA',{when:['hasRating','是']}),text('ratingAgency','评级机构','',{when:['hasRating','是']}),select('hasEnhancement','是否增信'),text('guarantor','担保人','',{when:['hasEnhancement','是']}),text('collateral','抵质押物','',{when:['hasEnhancement','是']}),text('enhancementMethod','增信方式','例如：连带责任保证、资产抵押',{when:['hasEnhancement','是']})]},
  {title:'募集资金用途',description:'可组合填写借新还旧、偿还有息债务、项目建设、股权投资或补充流动资金。用于项目建设时，可上传可研报告。',fields:[text('purpose','募集资金用途与安排','请说明用途、金额及对应项目',{multiline:true}),text('useProject','建设项目 / 股权投资标的','如涉及多个项目，可在材料中提供明细')]},
  {title:'特殊事项与编制要求',description:'不确定的事项留空，系统将结合材料列出待核实内容。',fields:[select('isLGFV','是否城投企业'),select('majorRestructuring','是否涉及重大资产重组'),select('investorProtection','是否设置投资者保护条款'),text('protectionTerms','投资者保护安排','',{when:['investorProtection','是'],multiline:true}),text('reviewNotes','编制要求或其他特殊事项','例如：重点更新业务板块、债务结构与偿债分析',{multiline:true})]}
];
export const OPTIONAL_FIELDS=OPTIONAL_GROUPS.flatMap(g=>g.fields);
export function optionalDefaults(){return Object.fromEntries(OPTIONAL_FIELDS.map(f=>[f.key,'']));}
export function normaliseOptional(fields){
  const values={};
  for(const f of OPTIONAL_FIELDS){const value=String(fields[f.key]??'').trim();if(value.length>3000)throw new Error(`${f.label}不能超过3000字。`);if(f.options&&value&&!f.options.includes(value))throw new Error(`请重新选择${f.label}。`);values[f.key]=value;}
  for(const f of OPTIONAL_FIELDS)if(f.when&&values[f.when[0]]!==f.when[1])values[f.key]='';
  return values;
}
export const MATERIAL_GROUPS=[
  {label:'募集说明书',items:[['updated','待复核募集书'],['historical','本企业历史募集书'],['reference','相似企业参考募集书']]},
  {label:'财务与审计',items:[['audit','审计报告（可含报表及附注）'],['financial','年度财务报表'],['interimFinancial','最近一期财务报表'],['notes','财务报表附注'],['accountDetails','财务科目明细与辅助账']]},
  {label:'发行安排与资金用途',items:[['issuancePlan','本期发行方案'],['fundUse','募集资金使用计划 / 项目方案'],['feasibility','项目可行性研究报告'],['priorFundUse','前次募集资金使用说明'],['trusteeReport','受托管理事务报告'],['resolutions','董事会 / 股东会决议']]},
  {label:'工商、信用与评级',items:[['corporate','工商及公司资料'],['registry','工商登记 / 企业信息公示材料'],['credit','征信报告'],['creditCompliance','诉讼、失信、处罚及信用核查'],['issuerStatement','发行人自查 / 专项说明'],['rating','评级报告（主体 / 债项 / 跟踪）'],['legal','法律意见书及其他法律文件']]},
  {label:'债务、授信与担保',items:[['debt','债务明细与融资材料'],['bankFacilities','银行授信情况表'],['facilityEvidence','银行授信证明材料'],['outstandingBonds','存续及历史债券资料'],['guarantee','本期增信 / 担保合同'],['guarantorMaterials','担保人财务、评级及资质材料'],['collateralMaterials','抵质押资产资料']]},
  {label:'经营、治理与行业',items:[['business','业务经营资料'],['governance','章程、治理制度与组织架构'],['personnel','董监高及其他人员资料'],['industry','行业研究 / 行业统计资料'],['other','其他材料']]}
];
export const ROLE_NAMES=Object.fromEntries(MATERIAL_GROUPS.flatMap(g=>g.items));
export const SUPPORT_ROLES=Object.keys(ROLE_NAMES).filter(r=>!['updated','historical','reference'].includes(r));
export const modeName=mode=>mode==='reference'?'参考相似企业起草':'更新本企业历史稿';
export const primaryRole=(kind,mode)=>kind==='review'?'updated':mode==='reference'?'reference':'historical';
export function updateFilesForMode(files,mode,blueprint){const primary=primaryRole('update',mode),selected=files.filter(f=>f.role===primary||SUPPORT_ROLES.includes(f.role));if(mode==='reference'&&blueprint?.id)selected.push({role:'reference',libraryId:blueprint.id,file:{name:blueprint.file?.name||'',size:blueprint.file?.size||0}});return selected;}
export function validateUpdateFiles(files,mode){
  if(!['historical','reference'].includes(mode))return '请选择本企业历史稿或相似企业参考稿。';
  const main=files.filter(f=>f.role===primaryRole('update',mode));
  const format=mode==='reference'?/\.(docx|pdf)$/i:/\.docx$/i;
  if(main.length!==1||!format.test(main[0]?.file?.name||main[0]?.filename||''))return `请提供一份${mode==='reference'?'相似企业参考募集书 DOCX / PDF，或从募集书库选择蓝图':'本企业历史募集书 DOCX'}。`;
  if(files.some(f=>!SUPPORT_ROLES.includes(f.role)&&f.role!==primaryRole('update',mode)))return '当前编制方式与募集书用途不一致，请重新指定。';
  if(mode==='reference'&&!files.some(f=>SUPPORT_ROLES.includes(f.role)))return '请添加至少一份本项目资料，参考募集书只能提供结构与写法。';
  return '';
}
