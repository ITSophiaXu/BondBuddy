import {M4_CASE_TEMPLATES,M4_DOCUMENT_LABELS,type M4DraftInput,type M4MaterialPin,type M4ArtifactPin,type M4Template,type M4Artifact} from '@bondbuddy/contracts';

export type MaterialDraftComparisonMetadata={
  materials:readonly {pin:M4MaterialPin;filename:string}[];
  templates:readonly M4Template[];
  artifacts:readonly M4Artifact[];
  projects:readonly {id:string;name:string}[];
};
export type MaterialDraftComparisonBlock={text:string;unverified?:boolean;reference?:readonly {label:string;value:string}[]};
export type MaterialDraftComparisonRow={key:string;label:string;change:'content'|'reference'|'same';local:MaterialDraftComparisonBlock[];server:MaterialDraftComparisonBlock[]};
export type MaterialDraftComparison={changed:MaterialDraftComparisonRow[];unchanged:MaterialDraftComparisonRow[]};

const canonical=(value:unknown):string|undefined=>JSON.stringify(value,(_key,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
export const sameMaterialDraftValue=(a:unknown,b:unknown)=>canonical(a)===canonical(b);
const emptyMetadata:MaterialDraftComparisonMetadata={materials:[],templates:[],artifacts:[],projects:[]};
const uniqueName=(values:string[])=>{const names=[...new Set(values)];return names.length===1&&names[0]?.trim()?names[0]:undefined;};
const sameMaterial=(a:M4MaterialPin,b:M4MaterialPin)=>a.source_project_id===b.source_project_id&&a.material_id===b.material_id&&a.material_version===b.material_version&&a.sha256===b.sha256;
const sameArtifact=(a:M4ArtifactPin,b:M4ArtifactPin)=>a.source_project_id===b.source_project_id&&a.artifact_id===b.artifact_id&&a.artifact_version===b.artifact_version&&a.sha256===b.sha256;
const projectName=(id:string,metadata:MaterialDraftComparisonMetadata)=>uniqueName(metadata.projects.filter(p=>p.id===id).map(p=>p.name));
const text=(value:string):MaterialDraftComparisonBlock[]=>[{text:value}];
const material=(pin:M4MaterialPin,metadata:MaterialDraftComparisonMetadata):MaterialDraftComparisonBlock=>{
  const names=metadata.materials.filter(m=>sameMaterial(m.pin,pin));
  const filename=names.length===1?names[0]!.filename:undefined,project=projectName(pin.source_project_id,metadata);
  return {text:(filename||'材料名称暂不可核实')+' · V'+pin.material_version+'\n来源项目：'+(project||'名称暂不可核实'),unverified:!filename||!project,
    reference:[{label:'来源项目',value:pin.source_project_id},{label:'材料',value:pin.material_id},{label:'材料版本',value:String(pin.material_version)},{label:'SHA-256',value:pin.sha256}]};
};
const artifact=(pin:M4ArtifactPin,type:M4DraftInput['document_type'],metadata:MaterialDraftComparisonMetadata):MaterialDraftComparisonBlock=>{
  const matches=metadata.artifacts.filter(a=>sameArtifact(a,pin)&&a.kind==='document'&&a.document_type===type),a=matches.length===1?matches[0]:undefined,project=projectName(pin.source_project_id,metadata);
  return {text:(a?.filename||'成果名称暂不可核实')+' · 文件版本 V'+pin.artifact_version+(a?.revision_number?' · 第'+a.revision_number+'稿':'')+'\n来源项目：'+(project||'名称暂不可核实'),unverified:!a||!project,
    reference:[{label:'来源项目',value:pin.source_project_id},{label:'成果',value:pin.artifact_id},{label:'文件版本',value:String(pin.artifact_version)},{label:'SHA-256',value:pin.sha256}]};
};
const template=(input:M4DraftInput,metadata:MaterialDraftComparisonMetadata):MaterialDraftComparisonBlock[]=>{
  const pin=input.template;if(!pin)return text('未选择私有模板');
  const matches=metadata.templates.filter(t=>t.template_id===pin.template_id&&t.template_version===pin.template_version&&t.sha256===pin.sha256&&t.document_type===input.document_type),t=matches.length===1?matches[0]:undefined;
  return [{text:(t?.name||'模板名称暂不可核实')+' · V'+pin.template_version+(t?'\n券商：'+t.broker:''),unverified:!t,
    reference:[{label:'模板',value:pin.template_id},{label:'模板版本',value:String(pin.template_version)},{label:'SHA-256',value:pin.sha256}]}];
};
const projectFile=(input:M4DraftInput,metadata:MaterialDraftComparisonMetadata):MaterialDraftComparisonBlock[]=>{
  const binding=input.project_file;if(!binding)return text('未绑定项目关联文件');
  const project=projectName(binding.project_id,metadata),hasExpected=Object.hasOwn(binding,'expected_file_version_id');
  return [{text:'绑定项目：'+(project||'项目名称暂不可核实')+'\n募集书依据：已固定版本（名称与序号暂不可核实）\n募集书选择修订：'+binding.source_selection_revision+'\n预期关联文件：'+(!hasExpected?'未提供版本条件':binding.expected_file_version_id===null?'无既有版本':'已固定版本（名称与序号暂不可核实）'),unverified:true,
    reference:[{label:'绑定项目',value:binding.project_id},{label:'募集书依据版本',value:binding.source_version_id},{label:'募集书选择修订',value:String(binding.source_selection_revision)},{label:'预期关联文件版本',value:!hasExpected?'未提供':binding.expected_file_version_id===null?'无既有版本':binding.expected_file_version_id!}]}];
};
const fieldLabels:Record<string,string>={market:'发行市场',offering:'债券品种',broker:'立项券商全称',source_mode:'募集书来源方式',case_template_id:'案例版式',issuer_name:'发行人名称',project_name:'项目名称',reporting_cutoff:'目标报告期',amount:'发行规模',term:'发行期限'};
const markets:Record<string,string>={sse:'上海证券交易所',szse:'深圳证券交易所',nafmii:'中国银行间市场交易商协会'};
const offerings:Record<string,string>={private:'普通私募',public_all:'大公募',public_qualified:'小公募',ppn:'PPN · 定向债务融资工具',mtn:'MTN · 中期票据',cp:'CP · 短期融资券',scp:'SCP · 超短期融资券',dfi:'DFI · 债务融资工具注册发行'};
const fieldValue=(key:string,value:string|undefined):MaterialDraftComparisonBlock[]=>{
  if(value===undefined)return text('未提供此项');if(value==='')return text('已提供空值');
  if(key==='market'&&Object.hasOwn(markets,value))return text(markets[value]!);
  if(key==='offering'&&Object.hasOwn(offerings,value))return text(offerings[value]!);
  if(key==='source_mode'&&['upload','project'].includes(value))return text(value==='upload'?'上传募集书':'关联已有项目');
  if(key==='case_template_id'){const matches=M4_CASE_TEMPLATES.filter(t=>t.id===value);return matches.length===1?text(matches[0]!.label):[{text:'案例版式名称暂不可核实\n原值：'+value,unverified:true}];}
  return text(value);
};
const requirements=(input:M4DraftInput):MaterialDraftComparisonBlock[]=>input.requirements.length?input.requirements.map((r,index)=>({text:'第'+(index+1)+'条\n'+r.text,reference:[{label:'要求记录',value:r.requirement_id},{label:'来源消息',value:r.message_id},{label:'来源消息版本',value:String(r.message_version)}]})):text('无历史要求');

/** Display only: no name, default, or equivalence here changes either complete input. */
export function compareMaterialDraftInputs(local:M4DraftInput,server:M4DraftInput,localMetadata:MaterialDraftComparisonMetadata=emptyMetadata,serverMetadata:MaterialDraftComparisonMetadata=emptyMetadata):MaterialDraftComparison{
  const rows:MaterialDraftComparisonRow[]=[];
  const add=(key:string,label:string,a:unknown,b:unknown,left:MaterialDraftComparisonBlock[],right:MaterialDraftComparisonBlock[],reference=false)=>rows.push({key,label,change:sameMaterialDraftValue(a,b)?'same':reference?'reference':'content',local:left,server:right});
  add('document_type','文件类型',local.document_type,server.document_type,text(M4_DOCUMENT_LABELS[local.document_type]),text(M4_DOCUMENT_LABELS[server.document_type]));
  add('project_file','项目关联文件绑定',local.project_file,server.project_file,projectFile(local,localMetadata),projectFile(server,serverMetadata),true);
  add('source_material','依据募集书',local.source_material,server.source_material,local.source_material?[material(local.source_material,localMetadata)]:text('未选择募集书'),server.source_material?[material(server.source_material,serverMetadata)]:text('未选择募集书'),true);
  add('materials','补充材料（按原顺序）',local.materials,server.materials,local.materials.length?local.materials.map(p=>material(p,localMetadata)):text('无补充材料'),server.materials.length?server.materials.map(p=>material(p,serverMetadata)):text('无补充材料'),true);
  add('template','私有模板',local.template,server.template,template(local,localMetadata),template(server,serverMetadata),true);
  add('edit_base','继续修改的成果底稿',local.edit_base,server.edit_base,local.edit_base?[artifact(local.edit_base,local.document_type,localMetadata)]:text('未选择成果底稿'),server.edit_base?[artifact(server.edit_base,server.document_type,serverMetadata)]:text('未选择成果底稿'),true);
  add('scope','编制范围',local.scope,server.scope,text(local.scope==='whole'?'整份文件':local.scope),text(server.scope==='whole'?'整份文件':server.scope));
  for(const key of [...new Set([...Object.keys(local.fields),...Object.keys(server.fields)])].sort()){
    const left=Object.hasOwn(local.fields,key)?local.fields[key]:undefined,right=Object.hasOwn(server.fields,key)?server.fields[key]:undefined;
    add('fields.'+key,Object.hasOwn(fieldLabels,key)?fieldLabels[key]!:'其他任务信息：'+key,left,right,fieldValue(key,left),fieldValue(key,right));
  }
  add('requirements','历史要求与来源',local.requirements,server.requirements,requirements(local),requirements(server),sameMaterialDraftValue(local.requirements.map(r=>r.text),server.requirements.map(r=>r.text)));
  add('supplemental_requirements','本轮补充要求',local.supplemental_requirements,server.supplemental_requirements,local.supplemental_requirements===undefined?text('未提供本轮补充要求'):local.supplemental_requirements===''?text('本轮补充要求为空'):text(local.supplemental_requirements),server.supplemental_requirements===undefined?text('未提供本轮补充要求'):server.supplemental_requirements===''?text('本轮补充要求为空'):text(server.supplemental_requirements));
  return {changed:rows.filter(r=>r.change!=='same'),unchanged:rows.filter(r=>r.change==='same')};
}
