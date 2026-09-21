import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT, readJson, atomicJson, processRun, PYTHON } from './lib/platform.mjs';
import { manifest, SCOPES } from './lib/knowledge.mjs';
import { launch, askCodex, object, string } from './lib/codex.mjs';
import { runTask } from './lib/worker.mjs';
import { Billing, taskCost } from './lib/billing.mjs';
import { endpoint, mcpSession } from './lib/mcp.mjs';
import { DemoAuth } from './lib/auth.mjs';
import { reportingPeriods } from './public/reporting-periods.js';
import { planQueries, hasExternalData } from './public/query-policy.js';
import { ROLE_NAMES, normaliseOptional, validateUpdateFiles } from './public/project-fields.js';
import { ProspectusLibrary } from './lib/prospectus-library.mjs';

for(const line of (await readFile(join(ROOT,'.env'),'utf8').catch(()=>'')).split(/\r?\n/)) {
  const m=line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
  if(m && process.env[m[1]]===undefined) process.env[m[1]]=m[2].replace(/^(['"])(.*)\1$/,'$2');
}
const PORT=Number(process.env.PORT||4320), PUBLIC=join(ROOT,'public');
const RUNTIME=resolve(process.env.BOND_BUDDY_RUNTIME||join(ROOT,'runtime')), JOBS=join(RUNTIME,'jobs');
const CONFIG=join(RUNTIME,'settings.json');
const library=new ProspectusLibrary(join(RUNTIME,'library'));
const billing=new Billing(join(RUNTIME,'billing.json'),{mode:process.env.BILLING_MODE||'sandbox'});
const auth=new DemoAuth(join(RUNTIME,'accounts.json')),cookieName=`bondbuddy_session_${PORT}`;
const sessionToken=req=>String(req.headers.cookie||'').split(';').map(v=>v.trim()).find(v=>v.startsWith(cookieName+'='))?.slice(cookieName.length+1)||'';
const sessionCookie=(token,maxAge)=>`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
const seatId=req=>req.user.id;
const owns=(req,job)=>{if((job.seatId||'primary')!==seatId(req))throw Object.assign(new Error('该项目不属于当前账号。'),{status:403});};
const MIME={'.pdf':'application/pdf','.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8','.svg':'image/svg+xml','.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document','.md':'text/markdown; charset=utf-8','.csv':'text/csv; charset=utf-8'};
const ROLES=Object.keys(ROLE_NAMES);
const ACTIVE=['queued','extracting','reviewing','updating','generating','exporting'];
const controllers=new Map(), queue=[];let busy=false;
const idCheck=id=>{if(!/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(id))throw new Error('项目编号无效。');return id;};
const folder=id=>join(JOBS,idCheck(id));
const load=id=>readJson(join(folder(id),'job.json'));
const save=async job=>{job.updatedAt=new Date().toISOString();await atomicJson(join(folder(job.id),'job.json'),job);};
const publicJob=(job,detail=false)=>{const {files,result,knowledgeId,knowledgeVersion,knowledgeHash,...rest}=job;return {...rest,downloads:(rest.downloads||[]).filter(n=>n!=='任务知识.md'),files:files.map(({path,...f})=>f),...(detail?{result}:{} )};};
const json=(res,status,payload)=>{res.writeHead(status,{'Content-Type':MIME['.json'],'Cache-Control':'no-store'});res.end(JSON.stringify(payload));};
async function settings() {
  const s=await readJson(CONFIG).catch(()=>({}));
  return {apiKey:s.apiKey??process.env.DEEPSEEK_API_KEY??'',model:s.model||process.env.DEEPSEEK_MODEL||'deepseek-chat',baseUrl:process.env.DEEPSEEK_BASE_URL||'https://api.deepseek.com',tavilyKey:s.tavilyKey??process.env.TAVILY_API_KEY??'',registryUrl:s.registryUrl??process.env.REGISTRY_URL??'',registryKey:s.registryKey??process.env.REGISTRY_API_KEY??'',connectors:s.connectors||[]};
}
async function configPublic() {const s=await settings();return {configured:Boolean(s.apiKey),model:s.model,webConfigured:Boolean(s.tavilyKey),registryConfigured:Boolean(s.registryUrl&&s.registryKey)};}
function operator(req){const token=process.env.BOND_BUDDY_ADMIN_TOKEN;return !!token&&req.headers['x-bondbuddy-admin']===token;}
function taskQueryPlan(job,s,quota){
  const route=planQueries({kind:job.kind,prompt:job.prompt||job.context?.reviewNotes||'',connectors:s.connectors,webAvailable:!!s.tavilyKey,registryAvailable:!!(s.registryKey&&s.registryUrl),externalDataAllowed:hasExternalData(quota)});
  if(quota.active&&job.kind==='generate'&&route.requiresProfessional)throw Object.assign(new Error('工商、企业预警通、Wind 等外部数据查询为专业版权益。升级后即可直接提问，也可以上传已有资料让我分析。'),{status:402,code:'PROFESSIONAL_REQUIRED'});
  return {web:route.web,registry:route.registry,connectorIds:route.connectorIds,bondQuery:route.bondQuery,queryMode:route.mode,queryLimitations:route.limitations};
}
async function listJobs() {return (await Promise.all((await readdir(JOBS)).filter(n=>/^[a-f\d-]{36}$/.test(n)).map(id=>load(id).catch(()=>null)))).filter(Boolean).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
async function readBody(req,max=10000) {let buffer=Buffer.alloc(0);for await(const chunk of req){buffer=Buffer.concat([buffer,chunk]);if(buffer.length>max)throw new Error('请求内容过大。');}return buffer;}
async function multipart(req) {
  const match=String(req.headers['content-type']||'').match(/^multipart\/form-data;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i);
  if(!match || (match[1]||match[2]).length>200)throw new Error('上传格式不正确。');
  const boundary=match[1]||match[2], buffer=await readBody(req,80*1024*1024), marker=Buffer.from(`\r\n--${boundary}`);
  if(!buffer.subarray(0,boundary.length+4).equals(Buffer.from(`--${boundary}\r\n`)))throw new Error('上传内容损坏。');
  const fields={},files=[];let start=Buffer.byteLength(`--${boundary}\r\n`),closed=false;
  while(start<buffer.length) {
    const end=buffer.indexOf(marker,start), divider=buffer.indexOf('\r\n\r\n',start);
    if(end<0 || divider<0 || divider>end || divider-start>10000)throw new Error('上传字段不完整。');
    const header=buffer.subarray(start,divider).toString('utf8'),body=buffer.subarray(divider+4,end);
    const name=header.match(/\bname="([^"]+)"/i)?.[1], filename=header.match(/\bfilename="([^"]*)"/i)?.[1];
    if(filename) files.push({role:name,filename:basename(filename).replace(/[^\w.()\-\u4e00-\u9fff]/g,'_').slice(-150),content:body});
    else if(name) fields[name]=body.toString('utf8').slice(0,12000);
    const suffix=buffer.subarray(end+marker.length,end+marker.length+2).toString();
    if(suffix==='--'){closed=true;break;}
    if(suffix!=='\r\n')throw new Error('上传分隔符无效。');
    start=end+marker.length+2;
  }
  if(!closed)throw new Error('材料上传未完成。');
  return {fields,files};
}
function enqueue(id) {if(controllers.has(id))return;controllers.set(id,new AbortController());queue.push(id);void pump();}
async function pump() {
  if(busy)return;busy=true;
  while(queue.length) {
    const id=queue.shift();
    try {
      const job=await load(id), all=job.kind==='generate'?await listJobs():[];
      const history=all.filter(j=>j.conversationId===job.conversationId&&j.status==='complete').reverse().map(j=>({user:j.prompt,assistant:j.result?.answer||''}));
      const projectDocuments=job.projectId?(await readJson(join(folder(job.projectId),'evidence.json')).catch(()=>({documents:[]}))).documents.map(d=>({...d,id:'P'+d.id})):[];
      if(job.projectId) {
        const project=await load(job.projectId);
        projectDocuments.push({id:'P-PROJECT',role:'project',filename:'关联项目的用户填写信息',parseStatus:'parsed',warnings:[],records:Object.entries(project.context).filter(([,v])=>v).map(([locator,text])=>({locator,text:String(text)}))});
      }
      for(const previous of all.filter(j=>j.conversationId===job.conversationId&&j.id!==job.id&&j.status==='complete').reverse()) {
        const previousDocs=(await readJson(join(folder(previous.id),'evidence.json')).catch(()=>({documents:[]}))).documents;
        projectDocuments.push(...previousDocs.map(d=>({...d,id:`C${previous.id.slice(0,8)}-${d.id}`})));
      }
      await runTask({job,folder:folder(id),save,settings:await settings(),signal:controllers.get(id).signal,history,projectDocuments});
    } catch {try {const j=await load(id);j.status='failed';j.progress='任务处理异常，已保存材料，请重试。';await save(j);}catch{}}
    finally{await billing.settle(id,(await load(id).catch(()=>({}))).status==='complete');controllers.delete(id);}
  }
  busy=false;
}
async function createTask(req,res) {
  const {fields:f,files}=await multipart(req),kind=f.kind;
  if(!['update','review','generate'].includes(kind))throw new Error('请选择任务类型。');
  let blueprintSnapshot;
  if(f.blueprintId){
    if(kind!=='update'||f.authoringMode!=='reference'||files.some(x=>['reference','historical'].includes(x.role)))throw new Error('资料库蓝图仅用于参考起草，请勿同时提交另一份底稿。');
    const [exchange,offering]=String(f.scope||'').split('-');
    const selected=await library.blueprint(f.blueprintId,seatId(req),{exchange,offering});
    files.unshift(selected.file);blueprintSnapshot=selected.snapshot;
  }
  if(files.reduce((n,f)=>n+f.content.length,0)>80*1024*1024)throw new Error('材料与蓝图合计不能超过80 MB。');
  if(files.length>60 || files.some(file=>!ROLES.includes(file.role)||!['.docx','.pdf','.xlsx','.csv','.txt'].includes(extname(file.filename).toLowerCase())||!file.content.length))throw new Error('最多60份材料，仅支持非空 DOCX、PDF、XLSX、CSV、TXT。');
  if(kind!=='generate') {
    if(!SCOPES.includes(f.scope))throw new Error('请选择上交所或深交所的公募/私募公司债。');
    if(!/^20\d{2}-(03-31|06-30|09-30|12-31)$/.test(f.periods||''))throw new Error('报告期仅支持3月末、6月末、9月末或年末。');
    if(!f.issuer?.trim() || !f.title?.trim())throw new Error('请填写项目名称和发行人。');
    if(kind==='update'){
      // Requests from the previous client remain historical updates; explicit blank/invalid modes fail.
      f.authoringMode=f.authoringMode===undefined?'historical':f.authoringMode;
      const error=validateUpdateFiles(files,f.authoringMode);if(error)throw new Error(error);
    } else {
      const required=files.filter(file=>file.role==='updated');
      if(required.length!==1 || extname(required[0].filename).toLowerCase()!=='.docx')throw new Error('请上传一份待复核募集书 DOCX，其他材料均可选。');
      if(files.some(file=>file.role==='reference'))throw new Error('相似企业参考稿用于参考起草，不能作为本企业历史复核依据。');
    }
  } else if(!f.prompt?.trim())throw new Error('请输入对话内容。');
  const optional=kind!=='generate'?normaliseOptional(f):{};
  let linkedProject;
  if(f.projectId) {const p=linkedProject=await load(f.projectId);owns(req,p);if(p.kind==='generate')throw new Error('请选择更新或复核项目作为上下文。');}
  let conversationId;
  if(kind==='generate') {
    conversationId=f.conversationId?idCheck(f.conversationId):randomUUID();
    const conversation=(await listJobs()).filter(j=>j.conversationId===conversationId);
    for(const j of conversation)owns(req,j);
    if(conversation.some(j=>ACTIVE.includes(j.status)))throw new Error('当前对话仍在生成，请等待完成或先停止。');
    if(conversation.length && (conversation[0].projectId||'')!==(f.projectId||''))throw new Error('切换项目请新建对话，以避免混用材料。');
  }
  const connectorIds=JSON.parse(f.connectorIds||'[]');if(!Array.isArray(connectorIds)||connectorIds.length>20||connectorIds.some(v=>typeof v!=='string'))throw new Error('数据连接选择无效。');
  const id=randomUUID(),dir=folder(id),owner=seatId(req),cost=taskCost(kind,files.length);
  const s=await settings(),quota=(await billing.view(owner)).seat.quota;
  if(quota.active&&!hasExternalData(quota)&&(connectorIds.length||f.web==='true'||f.registry==='true'))throw Object.assign(new Error('外部数据查询为专业版权益，请升级专业版后使用。'),{status:402,code:'PROFESSIONAL_REQUIRED'});
  const queryPlan=taskQueryPlan({kind,prompt:f.prompt,context:{reviewNotes:f.reviewNotes}},s,quota);
  await billing.reserve(id,owner,cost);
  try {
  await mkdir(join(dir,'uploads'),{recursive:true});
  const saved=[];
  for(const [i,file] of files.entries()){const path=join(dir,'uploads',`${i+1}_${file.filename}`);await writeFile(path,file.content);saved.push({role:file.role,filename:file.filename,size:file.content.length,path});}
  const context={...Object.fromEntries(['issuer','scope','periods'].map(k=>[k,String(f[k]||'').trim().slice(0,3000)])),...optional};
  if(kind==='update'){context.authoringMode=f.authoringMode;context.referenceFocus=String(f.referenceFocus||'').slice(0,3000);if(blueprintSnapshot)context.blueprint=blueprintSnapshot;}
  context.optionalInputBasis='选填项空白表示未提供，不表示否或不存在。用户填写的安排需与项目材料核对，不替代工商、评级、担保、财务等外部证据。';
  if(kind!=='generate')context.reportingWindow=reportingPeriods(context.periods,context.scope.split('-')[1]);
  if(kind!=='generate')context.investorBasis='投资者范围以募集书原文和适用规则为准；原文未明确时列待核实，不预设为普通或专业投资者。';
  const job={id,kind,title:String(f.title?.trim()||f.prompt?.trim().slice(0,32)||'新项目').slice(0,150),context,files:saved,status:'queued',progress:'材料已保存，任务等待开始',createdAt:new Date().toISOString(),downloads:[],modelName:s.model,modelLabel:'Codex · DeepSeek',...(kind==='generate'?{conversationId,prompt:f.prompt.slice(0,12000),projectId:f.projectId||'',web:f.web==='true',registry:f.registry==='true'}:{})};
  Object.assign(job,{seatId:owner,cost,connectorIds,queryIssuer:String(f.queryIssuer||context.issuer||linkedProject?.context?.issuer||'').trim().slice(0,200),bondQuery:kind!=='generate'||f.bondQuery==='true'||/兑付|存续|到期|发行过.*公司债/.test(f.prompt||'')});
  Object.assign(job,queryPlan);
  await atomicJson(join(dir,'manifest.json'),{files:saved});await save(job);enqueue(id);json(res,202,{job:publicJob(job,true)});
  }catch(e){await billing.settle(id,false);throw e;}
}
async function file(res,path,download=false) {
  const info=await stat(path).catch(()=>null);if(!info?.isFile())return json(res,404,{error:'文件不存在。'});
  res.writeHead(200,{'Content-Type':MIME[extname(path)]||'application/octet-stream','Cache-Control':'no-store',...(download?{'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(basename(path))}`}:{})});
  createReadStream(path).on('error',()=>res.destroy()).pipe(res);
}
async function handler(req,res) {
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  try {
    const hosts=[`localhost:${PORT}`,`127.0.0.1:${PORT}`];
    if(!hosts.includes(req.headers.host)||req.headers.origin&&!hosts.some(h=>req.headers.origin===`http://${h}`))return json(res,403,{error:'仅支持本机工作空间访问。'});
    const url=new URL(req.url,`http://127.0.0.1:${PORT}`),parts=url.pathname.split('/').filter(Boolean);
    if(url.pathname==='/api/auth/session'&&req.method==='GET')return json(res,200,{user:await auth.session(sessionToken(req)),mode:'demo'});
    if(url.pathname==='/api/auth/code'&&req.method==='POST'){const v=JSON.parse((await readBody(req)).toString());return json(res,200,await auth.requestCode(v.phone));}
    if(url.pathname==='/api/auth/verify'&&req.method==='POST'){
      const v=JSON.parse((await readBody(req)).toString()),result=await auth.verify(v.phone,v.code,v.challengeId);
      await billing.ensureAccount(result.user.id);res.setHeader('Set-Cookie',sessionCookie(result.token,result.maxAge));return json(res,200,{user:result.user,created:result.created,mode:'demo'});
    }
    if(url.pathname==='/api/auth/logout'&&req.method==='POST'){await auth.logout(sessionToken(req));res.setHeader('Set-Cookie',sessionCookie('',0));return json(res,200,{ok:true});}
    if(url.pathname.startsWith('/api/')&&url.pathname!=='/api/health'){
      req.user=await auth.session(sessionToken(req));if(!req.user)return json(res,401,{error:'请先使用手机号登录。',code:'LOGIN_REQUIRED'});
    }
    if(url.pathname==='/api/billing'&&req.method==='GET')return json(res,200,await billing.view(seatId(req)));
    if(url.pathname==='/api/library'&&req.method==='GET')return json(res,200,await library.search(seatId(req),Object.fromEntries(url.searchParams)));
    if(url.pathname==='/api/library'&&req.method==='POST'){
      const {fields,files}=await multipart(req);
      if(files.length>1||files.some(f=>f.role!=='document'))throw new Error('每次收录一份募集书正文。');
      const item=await library.add(fields,{owner:seatId(req),file:files[0],confirmed:fields.confirmed==='on',visibility:'personal'});
      return json(res,201,{item});
    }
    if(parts[0]==='api'&&parts[1]==='library'&&parts.length===3&&req.method==='GET')return json(res,200,{item:await library.detail(parts[2],seatId(req))});
    if(parts[0]==='api'&&parts[1]==='library'&&parts[3]==='document'&&parts.length===4&&req.method==='GET'){const path=await library.document(parts[2],seatId(req));return file(res,path,extname(path)==='.docx');}
    if(url.pathname==='/api/billing/orders'&&req.method==='POST')return json(res,201,{order:await billing.createOrder(seatId(req),JSON.parse((await readBody(req,20000)).toString()))});
    if(parts[0]==='api'&&parts[1]==='billing'&&parts[2]==='orders'&&parts[3]){
      if(req.method==='GET'&&parts.length===4)return json(res,200,{order:await billing.order(seatId(req),parts[3])});
      if(req.method==='POST'&&['cancel','sandbox-pay'].includes(parts[4]))return json(res,200,{order:await billing.order(seatId(req),parts[3],parts[4])});
    }
    if((url.pathname.startsWith('/api/settings')||url.pathname.startsWith('/api/connectors')&&!(url.pathname==='/api/connectors'&&req.method==='GET'))&&!operator(req))return json(res,403,{error:'服务配置由平台统一管理。',code:'PLATFORM_MANAGED'});
    if(url.pathname==='/api/connectors'&&req.method==='GET')return json(res,200,{connectors:hasExternalData((await billing.view(seatId(req))).seat.quota)?(await settings()).connectors.map(({id,name,vendor,purpose,enabled})=>({id,name,vendor,purpose,enabled})):[]});
    if(url.pathname==='/api/connectors'&&req.method==='POST'){
      const v=JSON.parse((await readBody(req,24000)).toString()),existing=await readJson(CONFIG).catch(()=>({}));existing.connectors||=[];
      const old=existing.connectors.find(c=>c.id===v.id),args=typeof v.args==='string'?JSON.parse(v.args):v.args;
      if(!v.name?.trim()||!v.tool?.trim()||!args||Array.isArray(args)||typeof args!=='object')throw new Error('请填写服务名称、工具名称和 JSON 参数模板。');
      if(!['wind','qyyjt','custom'].includes(v.vendor)||!['bonds','registry','search','other'].includes(v.purpose))throw new Error('连接类型无效。');
      const c={id:old?.id||randomUUID(),name:v.name.trim().slice(0,80),vendor:v.vendor,purpose:v.purpose,url:endpoint(v.url),token:v.token?.trim()||old?.token||'',tool:v.tool.trim().slice(0,200),args,readOnlyConfirmed:v.readOnlyConfirmed===true,enabled:v.enabled!==false};
      existing.connectors=existing.connectors.filter(c=>c.id!==v.id);if(existing.connectors.length>=20)throw new Error('最多配置 20 个数据连接。');existing.connectors.push(c);await atomicJson(CONFIG,existing);return json(res,200,{id:c.id});
    }
    if(url.pathname==='/api/connectors/discover'&&req.method==='POST'){
      const v=JSON.parse((await readBody(req,24000)).toString()),old=(await settings()).connectors.find(c=>c.id===v.id);let session;
      try{session=await mcpSession({url:v.url,token:v.token||old?.token||''});const tools=await session.tools();return json(res,200,{tools:tools.map(t=>({name:t.name,description:t.description,inputSchema:t.inputSchema,annotations:t.annotations}))});}finally{await session?.close();}
    }
    if(parts[0]==='api'&&parts[1]==='connectors'&&parts[2]&&req.method==='DELETE'){
      const existing=await readJson(CONFIG).catch(()=>({}));existing.connectors=(existing.connectors||[]).filter(c=>c.id!==parts[2]);await atomicJson(CONFIG,existing);return json(res,200,{ok:true});
    }
    if(url.pathname==='/api/settings'&&req.method==='GET')return json(res,200,await configPublic());
    if(url.pathname==='/api/settings'&&req.method==='POST') {
      const incoming=JSON.parse((await readBody(req)).toString()),existing=await readJson(CONFIG).catch(()=>({}));
      if(incoming.model&&!['deepseek-chat','deepseek-reasoner'].includes(incoming.model))throw new Error('不支持的 DeepSeek 模型。');
      for(const field of ['apiKey','tavilyKey','registryKey']) if(typeof incoming[field]==='string'&&incoming[field].trim())existing[field]=incoming[field].trim().slice(0,500);
      if(incoming.clearApiKey)existing.apiKey='';
      if(incoming.model)existing.model=incoming.model;
      if(typeof incoming.registryUrl==='string') {
        if(incoming.registryUrl) {const endpoint=new URL(incoming.registryUrl);if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password)throw new Error('工商连接需使用不含明文凭证的 HTTPS 地址。');}
        existing.registryUrl=incoming.registryUrl.trim();
      }
      await atomicJson(CONFIG,existing);return json(res,200,await configPublic());
    }
    if(url.pathname==='/api/health'&&req.method==='GET') {
      const [cli,python]=await Promise.all([launch(['--version'],{timeoutMs:10000}).then(r=>r.code===0).catch(()=>false),processRun(PYTHON,['-c','import docx,openpyxl,pypdf'],{timeout:10000}).then(()=>true).catch(()=>false)]);
      return json(res,200,{...await configPublic(),codex:cli,python,knowledgePacks:(await manifest()).length,version:'1.6.0',authoringVersion:1,libraryVersion:1,authMode:'phone-demo',automaticQueries:true,managedServices:true,professionalData:true});
    }
    if(url.pathname==='/api/settings/test'&&req.method==='POST') {
      const dir=join(RUNTIME,'connection-test',randomUUID());await mkdir(dir,{recursive:true});
      await askCodex({prompt:'请返回 JSON 对象，message 字段写“连接成功”。不要调用工具。',schema:object({message:string}),folder:dir,key:'test',signal:AbortSignal.timeout(90000),settings:await settings()});
      return json(res,200,{ok:true,message:'Codex → DeepSeek 实际调用成功'});
    }
    if(url.pathname==='/api/knowledge'&&req.method==='GET')return json(res,200,{packs:await manifest(),sources:(await readJson(join(ROOT,'knowledge','sources.json'))).sources});
    if(parts[0]==='api'&&parts[1]==='knowledge'&&parts[2]&&req.method==='GET') {
      const pack=(await manifest()).find(p=>p.id===parts[2]);if(!pack)return json(res,404,{error:'知识文件不存在。'});
      return parts[3]==='download'?file(res,join(ROOT,'knowledge',pack.filename),true):json(res,200,{...pack,content:await readFile(join(ROOT,'knowledge',pack.filename),'utf8')});
    }
    if(url.pathname==='/api/tasks'&&req.method==='GET')return json(res,200,{jobs:(await listJobs()).filter(j=>(j.seatId||'primary')===seatId(req)).map(j=>publicJob(j))});
    if(url.pathname==='/api/tasks'&&req.method==='POST')return await createTask(req,res);
    if(parts[0]==='api'&&parts[1]==='tasks'&&parts[2]) {
      const job=await load(parts[2]),action=parts[3];
      owns(req,job);
      if(req.method==='GET'&&!action)return json(res,200,{job:publicJob(job,true)});
      if(req.method==='GET'&&action==='download'&&parts.length===5) {const name=decodeURIComponent(parts[4]);if(name==='任务知识.md'||basename(name)!==name||!job.downloads.includes(name))return json(res,404,{error:'未找到此任务的下载文件。'});return file(res,join(folder(job.id),name),true);}
      if(req.method==='POST'&&action==='cancel'){controllers.get(job.id)?.abort();return json(res,200,{ok:true});}
      if(req.method==='POST'&&action==='retry') {
        if(!['failed','cancelled','interrupted','needs_setup'].includes(job.status)||controllers.has(job.id))throw new Error('该任务当前不能继续。');
        Object.assign(job,taskQueryPlan(job,await settings(),(await billing.view(seatId(req))).seat.quota));
        await billing.reserve(job.id,job.seatId||'primary',job.cost||taskCost(job.kind,job.files.length));
        job.status='queued';job.progress='将从已保存的片段继续';await save(job);enqueue(job.id);return json(res,202,{job:publicJob(job,true)});
      }
    }
    if(url.pathname.startsWith('/api/'))return json(res,404,{error:'未找到接口。'});
    if(req.method!=='GET')return json(res,405,{error:'不支持此请求。'});
    const path=resolve(PUBLIC,decodeURIComponent(url.pathname==='/'?'index.html':url.pathname.slice(1)));
    if(!path.startsWith(PUBLIC+sep))return json(res,404,{error:'未找到页面。'});return file(res,path);
  } catch(error){return json(res,error.status||(error.code==='ENOENT'?404:400),{error:error.code==='ENOENT'?'项目或文件不存在。':error.message,code:error.code});}
}
await mkdir(JOBS,{recursive:true});
for(const job of await listJobs())if(ACTIVE.includes(job.status)){job.status='interrupted';job.progress='服务已重启，可继续已保存的任务。';await save(job);}
await billing.reconcile(await listJobs());
const server=createServer((req,res)=>{void handler(req,res).catch(()=>{if(!res.headersSent)json(res,500,{error:'请求处理异常。'});else res.destroy();});});
server.requestTimeout=300000;
server.listen(PORT,'127.0.0.1',async()=>{await writeFile(join(RUNTIME,'server.pid'),String(process.pid));console.log(`BondBuddy ready at http://127.0.0.1:${PORT}`);});
process.on('SIGTERM',()=>{for(const c of controllers.values())c.abort();server.close(()=>process.exit(0));});
