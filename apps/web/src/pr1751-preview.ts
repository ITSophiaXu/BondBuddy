import './style.css';
import '../../../product-prototype/public/styles.css';
import '../../../product-prototype/public/workspace-typography.css';
import '../../../product-prototype/public/desktop-workspace-polish.css';
import {PROJECT_DOCUMENT_CATALOG,emptyFileGenerationPreparation} from '@bondbuddy/contracts';
import {FileGenerationPanel} from './file-generation-panel';
import type {ApiClient} from './api';
import type {ProjectFileWorkspace} from './billing-types';

const css=document.createElement('style');css.textContent=`
 body{margin:0;background:#f7f8f6;color:#203026;font-family:Arial,"Microsoft YaHei",sans-serif}
 .preview-wrap{max-width:1380px;margin:0 auto;padding:24px}
 .preview-header{display:flex;align-items:center;justify-content:space-between;gap:20px;margin:0 auto 16px;max-width:1260px}
 .preview-header small{color:#60735f}.preview-header h1{margin:6px 0;font-size:28px}
 .preview-header button{background:#234e39;color:#fff;border:0;border-radius:8px;padding:12px 18px;cursor:pointer}
 .preview-notice{max-width:1216px;margin:0 auto 22px;padding:14px 20px;background:#fff9e8;border:1px solid #e8d9a6;border-radius:10px;line-height:1.6}
 .fg-preparation .panel{background:#fff;border:1px solid #dfe6dc;border-radius:12px}
 @media(max-width:600px){.preview-wrap{padding:12px}.preview-header{align-items:flex-start;flex-direction:column}.preview-header button{width:100%}}
`;document.head.append(css);

const zero='0'.repeat(64),now=new Date().toISOString(),project='pr1751-preview',owner='pr1751-preview-user';
localStorage.removeItem(`bb-file-generation-v2:${owner}:${project}`);
const catalogue={catalogue_id:'preview-catalogue',sha256:zero,filename:'演示尽职调查目录.xlsx',created_at:now,warnings:[],entries:[
 {id:'item-1',code:'1.1',title:'发行人基本情况核查记录',folder:'1 尽职调查文件',sheet:'尽职调查文件',row:2,instructions:'依据项目资料编制',kind:'file',path:'1.1 发行人基本情况核查记录.docx'},
 {id:'item-2',code:'1.2',title:'关联方情况说明',folder:'1 尽职调查文件',sheet:'尽职调查文件',row:3,instructions:'依据项目资料编制',kind:'file',path:'1.2 关联方情况说明.docx'}
]};
const builtin={set_id:'preview-builtin',name:'内置文种模板',version:'preview',origin:'builtin',warnings:[],records:PROJECT_DOCUMENT_CATALOG.map(d=>({set_id:'preview-builtin',record_id:`record-${d.id}`,sha256:zero,name:`${d.name} · 演示模板`,code:d.code,role:d.name,document_type:d.id}))};
const source={project_id:project,version_id:'preview-source',selection_revision:1,filename:'演示募集说明书.docx',sequence:1,asset:{}};
const workspace={project_id:project,source,workspace:{drafts:Object.fromEntries(PROJECT_DOCUMENT_CATALOG.map(d=>[d.id,{template:null}])),templates:[]},files:[],batches:[]} as unknown as ProjectFileWorkspace;
const data={revision:0,preparation:emptyFileGenerationPreparation(),sets:[builtin],builtin:{name:'光大证券模板',version:'preview',available:true},pricing:{mode:'automatic',price_version:'preview-price',workpaper_points:100,document_points:200},batches:[]} as any;
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const fakeApi={
 async request(_method:string,path:string,body?:any){
  if(path.endsWith('/file-generation'))return structuredClone(data);
  if(path.endsWith('/preparation')){data.revision++;data.preparation=structuredClone(body.preparation);return {revision:data.revision,preparation:structuredClone(data.preparation)};}
  if(path.endsWith('/builtin'))return body.part==='catalogue'?{catalogue}:{set:builtin};
  if(path.includes('/workpapers/catalogues/'))return catalogue;
  if(path.includes('/matches?'))return {matches:[]};
  if(path.endsWith('/progress'))return {revision:zero,active:data.batches.length>0};
  if(path.endsWith('/system-templates'))return {templates:[]};
  if(path.endsWith('/template-preview'))return {title:'演示模板',redacted:true,view:'structure',pdf_available:false,blocks:[{kind:'paragraph',text:'项目名称：【本项信息】',bold:false,align:'left'}]};
  if(path.endsWith('/quote')){const count=(data.preparation.document_types.includes('workpaper')?data.preparation.item_ids.length:0)+data.preparation.document_types.filter((type:string)=>type!=='workpaper').length;return {count,points:body.expected_points,price_version:'preview-price',omitted:[],auto_charge:true,quote_status:'ready',documents:[]};}
  if(path.endsWith('/batches')){const types=data.preparation.document_types.filter((type:string)=>type!=='workpaper'),wp=data.preparation.document_types.includes('workpaper');const batch={batch_id:'preview-batch',created_at:new Date().toISOString(),points:body.expected_points,workpapers:wp?{batch_id:'preview-workpapers',state:'running',items:data.preparation.item_ids.map((id:string,index:number)=>({entry:catalogue.entries.find(e=>e.id===id),run_id:index?'preview-run':null,state:index?'running':'succeeded'}))}:null,documents:types.length?{batch_id:'preview-documents',state:'running',items:types.map((document_type:string,index:number)=>({document_type,run_id:index?'preview-run':null,state:index?'running':'succeeded',error:null}))}:null};data.batches=[batch];return batch;}
  throw Error(`预览尚未模拟此操作：${path}`);
 },
 async uploadRequest(path:string,file:File,progress:(loaded:number,total:number)=>void,_signal:AbortSignal,uploaded:()=>void){const type=new URLSearchParams(path.split('?')[1]).get('document_type')??'workpaper';progress(Math.round(file.size*.45),file.size);await pause(650);progress(file.size,file.size);uploaded();await pause(650);return {set_id:`preview-upload-${Date.now()}`,name:file.name,version:'preview',origin:'private',warnings:[],records:[{set_id:`preview-upload-${Date.now()}`,record_id:'uploaded-record',sha256:zero,name:file.name,code:'',role:type,document_type:type}]};}
} as unknown as ApiClient;

const host=document.querySelector<HTMLElement>('#preview-panel')!,button=document.querySelector<HTMLButtonElement>('#preview-progress')!;
let panel:FileGenerationPanel;
let view:'prepare'|'progress'='prepare';
async function show(){panel?.dispose();host.innerHTML='';button.textContent=view==='progress'?'返回准备页面':'查看生成进度演示';panel=new FileGenerationPanel(fakeApi,host,project,owner,workspace,()=>true,()=>{},view,()=>{view='progress';void show();});await panel.render();}
button.onclick=async()=>{if(view==='progress'){view='prepare';}else{data.batches=[{batch_id:'preview-batch',created_at:now,points:600,workpapers:{batch_id:'preview-workpapers',state:'running',items:[{run_id:null,state:'succeeded'},{run_id:'preview-run',state:'running'}]},documents:{batch_id:'preview-documents',state:'running',items:[{document_type:'underwriter',run_id:null,state:'succeeded',error:null},{document_type:'annual',run_id:'preview-run',state:'running',error:null}]}}];view='progress';}await show();};
void show();
