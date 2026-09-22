// Shared by the form and server: blank optional values mean unknown, never "no".
const yn=['是','否'];
const text=(key,label,placeholder='',extra={})=>({key,label,placeholder,...extra});
const select=(key,label,options=yn,extra={})=>({key,label,options,...extra});
export const FUNDING_PURPOSES=['借新还旧','偿还有息负债','补充流动资金','项目建设','用于投资股权','用于基金出资'];
const specialTypes=['短期公司债券','可续期公司债券','可交换公司债券','绿色债券','乡村振兴债券','低碳转型债券','科技创新债券','一带一路债券','纾困债券','中小微企业支持债券','其他'];
export const OPTIONAL_GROUPS=[
  {title:'发行规模与债券安排',description:'不同品种的期限、含权条款和专项用途会影响发行概况、风险提示、募集资金用途及投资者保护等章节。按实际安排描述即可；如有第二个或更多品种，请分别说明。',fields:[text('registrationAmount','本次申报总额','例如：不超过30亿元'),text('size','本期发行金额','例如：不超过10亿元'),text('trancheTerms','债券安排','例如：本期10亿元，期限3年，无含权条款。若分两个品种：3年期6亿元、5年期4亿元，分别说明回售/赎回/调息安排、专项用途及品种间回拨安排；未确定的内容可注明待定。',{multiline:true})]},
  {title:'参与机构',description:'可以直接写机构名称及分工。有一家主承销商时填名称即可；有多家时，再注明牵头、联席或其他分工。未定的角色可留空。',fields:[text('underwritingArrangements','承销安排','例如：由XX证券担任主承销商。或：XX证券牵头、YY银行联席，XX证券兼任簿记管理人。',{multiline:true}),text('otherAgencies','其他参与机构与分工','如已确定，可填写受托管理人、会计师事务所、律师事务所等。',{multiline:true})]},
  {title:'评级与增信',description:'未选择表示尚未提供，不会默认认定为不评级或不增信。',fields:[select('hasRating','是否评级'),text('issuerRating','主体评级','例如：AA+',{when:['hasRating','是']}),text('bondRating','债项评级','例如：AAA',{when:['hasRating','是']}),text('ratingAgency','评级机构','',{when:['hasRating','是']}),select('hasEnhancement','是否增信'),text('guarantor','担保人','',{when:['hasEnhancement','是']}),text('collateral','抵质押物','',{when:['hasEnhancement','是']}),text('enhancementMethod','增信方式','例如：连带责任保证、资产抵押',{when:['hasEnhancement','是']})]},
  {title:'募集资金用途',description:'选择主要用途；如有多种用途，可在补充安排或右侧对话中说明各自的金额。',fields:[select('purposeCategory','资金用途',FUNDING_PURPOSES,{help:'用于项目建设时，建议提供项目可行性研究报告，以及土地证书、相关许可证等材料。',helpWhen:['purposeCategory','项目建设']}),text('purpose','金额与具体安排','例如：6亿元用于偿还有息负债，4亿元用于补充流动资金；相关债务明细另附。',{multiline:true}),text('useProject','涉及项目 / 投资标的 / 基金','可填写名称；多个项目也可以直接在右侧对话中说明')]},
  {title:'其他项目信息',description:'已确定的信息可以在这里填写，也可以随时在右侧对话中补充。',fields:[select('isLGFV','是否城投企业'),text('reviewNotes','其他信息与修改要求','例如：公司名称已变更，请使用最新名称；相关证明材料另附。',{multiline:true})]}
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
ROLE_NAMES.userReference='相似募集书（用户提供）';
ROLE_NAMES.prospectus='最新版募集说明书';
ROLE_NAMES.generationTemplate='券商立项模板 / 参考报告';
ROLE_NAMES.generationRules='立项规则';
export const SUPPORT_ROLES=Object.keys(ROLE_NAMES).filter(r=>!['updated','historical','reference','userReference','prospectus','generationTemplate','generationRules'].includes(r));
export const modeName=mode=>mode==='reference'?'无历史募集书':'有历史募集书';
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
