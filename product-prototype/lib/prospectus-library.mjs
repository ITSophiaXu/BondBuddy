import { businessProfile, sameTopBusinesses } from './business-profile.mjs';
import { mkdir, readFile, writeFile, readdir, rename, rm } from 'node:fs/promises';
import { join, extname, basename } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readJson, atomicJson, python } from './platform.mjs';
import { LIBRARY_SOURCES, INSTRUMENTS, INDUSTRIES, OWNERSHIPS, ASSET_BANDS, PROJECT_STATUSES, OFFERINGS, matchProspectus, blueprintEligibility } from '../public/library-schema.js';

const sha=data=>createHash('sha256').update(data).digest('hex');
const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
const text=(v,max=500)=>String(v??'').trim().slice(0,max);
function choice(value,values,label,optional=false){if(optional&&!value)return '';if(!values.includes(value))fail(`请重新选择${label}。`);return value;}
export function officialUrl(value,market,required=false){
  if(!value&&!required)return '';
  let url;try{url=new URL(value);}catch{fail('请提供完整的官方来源网址。');}
  const source=LIBRARY_SOURCES.find(s=>s.id===market);
  if(!source||!['http:','https:'].includes(url.protocol)||url.username||url.password||url.port||!source.hosts.includes(url.hostname))fail('来源链接须位于所选官方平台的受支持域名下。');
  return url.href;
}
export function normaliseEntry(input){
  const market=choice(input.market,LIBRARY_SOURCES.map(s=>s.id),'来源平台');
  const title=text(input.title,300),issuer=text(input.issuer,200);
  if(!title||!issuer)fail('请填写募集书名称和发行人全称。');
  const publishedAt=text(input.publishedAt,10);
  if(publishedAt&&(!/^20\d{2}-\d{2}-\d{2}$/.test(publishedAt)||isNaN(Date.parse(publishedAt))||new Date(publishedAt).toISOString().slice(0,10)!==publishedAt||publishedAt>new Date().toISOString().slice(0,10)))fail('请填写有效且不晚于今天的披露日期。');
  return {title,issuer,market,instrument:choice(input.instrument,INSTRUMENTS,'债券类型'),offering:choice(input.offering||'unknown',Object.keys(OFFERINGS),'发行方式'),projectStatus:choice(input.projectStatus||PROJECT_STATUSES[0],PROJECT_STATUSES,'官方项目状态'),sourceUrl:officialUrl(input.sourceUrl,market,true),documentUrl:officialUrl(input.documentUrl,market),publishedAt,version:text(input.version,100),sourceProjectId:text(input.sourceProjectId,100),industry:choice(input.industry,INDUSTRIES,'行业',true),ownership:choice(input.ownership,OWNERSHIPS,'企业性质',true),assetBand:choice(input.assetBand,ASSET_BANDS,'资产规模',true),region:text(input.region,100),notes:text(input.notes,1500)};
}
export class ProspectusLibrary {
  constructor(root){this.root=root;this.entries=join(root,'entries');}
  path(id){if(!/^[a-f0-9]{64}$/.test(id))fail('募集书编号无效。',404);return join(this.entries,id);}
  visible(item,owner){return item.visibility==='public'||item.owner===owner;}
  expose(item){const {owner,file,...rest}=item;return {...rest,file:file?{name:file.name,size:file.size,sha256:file.sha256}:null};}
  async all(owner){await mkdir(this.entries,{recursive:true});const entries=(await Promise.all((await readdir(this.entries)).filter(id=>/^[a-f0-9]{64}$/.test(id)).map(id=>readJson(join(this.path(id),'entry.json')).catch(()=>null)))).filter(e=>e&&this.visible(e,owner));const replacements=new Map(entries.filter(e=>e.supersedes).sort((a,b)=>a.createdAt.localeCompare(b.createdAt)).map(e=>[e.supersedes,e.id]));return entries.map(e=>({...e,supersededBy:replacements.get(e.id)||null}));}
  async get(id,owner){this.path(id);const entry=(await this.all(owner)).find(e=>e.id===id);if(!entry)fail('未找到可访问的募集书。',404);return entry;}
  async detail(id,owner){const item=await this.get(id,owner);return this.expose(item);}
  async add(input,{owner,visibility='personal',file,confirmed=false,operator=false}={}){
    if(!owner||visibility==='public'&&!operator)fail('只有资料库维护人员可以发布公共条目。',403);
    const metadata=normaliseEntry(input);
    if(input.supersedes){const previous=await this.get(input.supersedes,owner);if(previous.visibility!==visibility||visibility==='personal'&&previous.owner!==owner||previous.issuer!==metadata.issuer||previous.market!==metadata.market)fail('新版本必须属于相同收录范围、发行人及市场。');metadata.supersedes=previous.id;}
    if(file&&(!/\.(pdf|docx)$/i.test(file.filename)||!file.content?.length||file.content.length>40*1024*1024))fail('募集书正文支持非空 PDF 或 DOCX，单份最多40 MB。');
    if(confirmed&&(!metadata.documentUrl||!metadata.publishedAt||!metadata.version))fail('核对来源前，请补充官方文件链接、披露日期和文件版本。');
    const fileHash=file?sha(file.content):'';
    const id=sha(JSON.stringify({owner:visibility==='public'?'public':owner,visibility,metadata,fileHash,confirmed:!!confirmed}));
    const existing=await readJson(join(this.path(id),'entry.json')).catch(()=>null);if(existing)return {...this.expose(existing),duplicate:true};
    await mkdir(this.entries,{recursive:true});
    const stage=join(this.root,'.staging-'+randomUUID());await mkdir(stage,{recursive:true});
    try{
      let storedFile=null,document=null;
      if(file){
        const name=basename(file.filename).replace(/[^\w.()\-\u4e00-\u9fff]/g,'_').slice(-150),diskName='prospectus'+extname(name).toLowerCase();
        await writeFile(join(stage,diskName),file.content);
        await atomicJson(join(stage,'manifest.json'),{files:[{filename:name,path:join(stage,diskName),role:'reference'}]});
        await python('extract_materials.py',['manifest.json','text.json'],stage);
        document=(await readJson(join(stage,'text.json'))).documents[0];
        storedFile={name,diskName,size:file.content.length,sha256:fileHash};
      }
      const records=document?.records||[],textReady=records.some(r=>r.text.trim().length>0),now=new Date().toISOString();
      const entry={id,...metadata,visibility,owner,createdAt:now,confirmedAt:confirmed?now:null,verification:confirmed?(visibility==='public'?'维护人员已核对官方来源':'个人已核对官方来源'):'来源待核对',file:storedFile,textReady,parseStatus:document?.parseStatus||'index_only',warnings:document?.warnings||[],recordCount:records.length,chapters:records.filter(r=>/第[一二三四五六七八九十百\d]+[章节]|目录/.test(r.text)).slice(0,40).map(r=>({locator:r.locator,text:r.text.slice(0,180)}))};
      await atomicJson(join(stage,'entry.json'),entry);
      try{await rename(stage,this.path(id));}catch(e){const winner=await readJson(join(this.path(id),'entry.json')).catch(()=>null);if(winner)return {...this.expose(winner),duplicate:true};throw e;}
      return this.expose(entry);
    }finally{await rm(stage,{recursive:true,force:true}).catch(()=>{});}
  }
  async search(owner,query={}){
    const all=await this.all(owner),target=Object.fromEntries(['exchange','offering','industry','region','ownership','assetBand'].map(k=>[k,text(query['target_'+k],100)]));
    const terms=text(query.q,150).toLowerCase().split(/\s+/).filter(Boolean),scoped=all.filter(e=>['market','instrument','industry','region','ownership','issuer','projectStatus','visibility'].every(k=>!query[k]||e[k]===query[k])&&(!query.offering||e.offering===query.offering));
    const found=[];
    for(const item of scoped){
      const match=matchProspectus(item,target);
      if(query.ready==='true'&&!match.eligible)continue;
      if(query.sort==='recommended'&&!match.eligible)continue;
      const metadata=[item.title,item.issuer,item.market,item.instrument,item.industry,item.region,item.notes].join(' ').toLowerCase();let hit=null;
      if(terms.length&&!terms.every(t=>metadata.includes(t))){
        if(!item.textReady)continue;
        const documents=(await readJson(join(this.path(item.id),'text.json'))).documents;
        const records=documents[0].records;const full=metadata+' '+records.map(r=>r.text).join('\n').toLowerCase();if(!terms.every(t=>full.includes(t)))continue;
        hit=records.find(r=>terms.some(t=>r.text.toLowerCase().includes(t)));
      }
      found.push({...this.expose(item),match,hit:hit?{locator:hit.locator,text:hit.text.slice(Math.max(0,hit.text.toLowerCase().indexOf(terms.find(t=>hit.text.toLowerCase().includes(t))))).slice(0,220)}:null});
    }
    found.sort((a,b)=>(query.sort==='recommended'?b.match.score-a.match.score:0)||(b.publishedAt||'').localeCompare(a.publishedAt||'')||b.createdAt.localeCompare(a.createdAt)||a.id.localeCompare(b.id));
    const page=Math.max(1,Math.min(100000,parseInt(query.page)||1)),size=12;
    const facets={};for(const key of ['issuer','industry','region','ownership'])facets[key]=[...new Set(all.map(e=>e[key]).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    return {items:found.slice((page-1)*size,page*size),total:found.length,page,pages:Math.ceil(found.length/size),facets,sources:LIBRARY_SOURCES.map(({hosts,...s})=>({...s,count:all.filter(e=>e.market===s.id).length})),stats:{total:all.length,public:all.filter(e=>e.visibility==='public').length,ready:all.filter(e=>blueprintEligibility(e).eligible).length,issuers:new Set(all.map(e=>e.issuer)).size},target};
  }
  async blueprint(id,owner,target){
    const item=await this.get(id,owner),eligibility=blueprintEligibility(item,target);
    if(!eligibility.eligible)fail('此募集书暂不能用作本项目蓝图：'+eligibility.reasons.join('；'));
    const content=await readFile(join(this.path(id),item.file.diskName));if(sha(content)!==item.file.sha256)fail('收录文件校验失败，请联系资料库维护人员。');
    return {file:{role:'reference',filename:item.file.name,content},snapshot:{id:item.id,title:item.title,issuer:item.issuer,market:item.market,instrument:item.instrument,offering:item.offering,sourceUrl:item.sourceUrl,documentUrl:item.documentUrl,publishedAt:item.publishedAt,version:item.version,sha256:item.file.sha256,confirmedAt:item.confirmedAt,verification:item.verification,selectedAt:new Date().toISOString()}};
  }
  async automaticBlueprint(owner,profile,{scope,folder,settings}){
    const [market,offering]=scope.split('-');
    const candidates=(await this.all(owner)).filter(item=>item.confirmedAt&&item.file&&item.textReady&&!item.supersededBy&&['审核通过','注册生效','已发行'].includes(item.projectStatus));
    candidates.sort((a,b)=>Number(b.market===market)-Number(a.market===market)||Number(b.offering===offering)-Number(a.offering===offering)||(b.publishedAt||'').localeCompare(a.publishedAt||''));
    for(const item of candidates){
      const documents=(await readJson(join(this.path(item.id),'text.json'))).documents;
      const years=documents.flatMap(d=>d.records.flatMap(r=>[...r.text.matchAll(/(20\d{2})年/g)].map(m=>Number(m[1])))).filter(y=>y<=Number(profile.year));
      const year=Math.max(...years);if(!Number.isFinite(year))continue;
      const reference=await businessProfile(documents,{year,issuer:item.issuer,folder,settings});
      if(!sameTopBusinesses(profile,reference))continue;
      const content=await readFile(join(this.path(item.id),item.file.diskName));if(sha(content)!==item.file.sha256)continue;
      return {file:{role:'reference',filename:item.file.name,content},snapshot:{id:item.id,title:item.title,issuer:item.issuer,sourceUrl:item.sourceUrl,documentUrl:item.documentUrl,version:item.version,publishedAt:item.publishedAt,sha256:item.file.sha256,confirmedAt:item.confirmedAt,verification:item.verification,selectedAt:new Date().toISOString(),businessProfile:reference,targetProfile:profile}};
    }
    return null;
  }
  async document(id,owner){const item=await this.get(id,owner);if(!item.file)fail('此条目暂未收录正文。',404);return join(this.path(id),item.file.diskName);}
}
