import { materialStudio } from './material-studio.js';
import { uploadMultipart } from './upload.js';
import { projectWorkspace } from './project-workspace.js';
import { SCOPE_NAMES } from './markets.js';
import { accountUI } from './account.js';
import { phoneAuthUI } from './phone-auth.js';
import { reportingPeriods } from './reporting-periods.js';
import { querySourcesUI } from './query-sources.js';
import { pointCapacity } from './usage-copy.js';
import { authoringUI } from './authoring.js';
import { ROLE_NAMES, SUPPORT_ROLES, OPTIONAL_FIELDS, optionalDefaults, normaliseOptional, modeName, primaryRole, updateFilesForMode, validateUpdateFiles } from './project-fields.js';
const $=s=>document.querySelector(s);
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const paths={grid:'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',update:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9 M14 2v7h7 M8 15h8 M12 11v8',review:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9 M14 2v7h7 M8 15l3 3 6-6',chat:'M21 11a8 8 0 0 1-8 8H7l-5 3V11a8 8 0 0 1 8-8h3a8 8 0 0 1 8 8Z M7 10h10 M7 14h6',folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',book:'M12 5v16 M3 3c4-1 7 0 9 2 2-2 5-3 9-2v16c-4-1-7 0-9 2-2-2-5-3-9-2V3Z',settings:'M9 3h6l1 4 4 1v7l-4 1-1 5H9l-1-5-4-1V8l4-1 1-4Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',arrow:'M4 12h16 M14 6l6 6-6 6',chevron:'M9 5l7 7-7 7',down:'M6 9l6 6 6-6',plus:'M12 5v14 M5 12h14',check:'M5 12l4 4L19 6',shield:'M12 3l8 3v6c0 5-8 10-8 10S4 17 4 12V6l8-3Z M8 12l3 3 5-6',spark:'M12 2l3 7 7 3-7 3-3 7-3-7-7-3 7-3 3-7Z',upload:'M12 16V3 M7 8l5-5 5 5 M4 15v5h16v-5',download:'M12 3v13 M7 11l5 5 5-5 M4 17v4h16v-4',close:'M6 6l12 12 M18 6L6 18',file:'M14 2H5a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9 M14 2v7h7 M7 13h10 M7 17h7',clock:'M12 7v5l3 2 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',search:'M21 21l-6-6 M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',help:'M9 8a3 3 0 1 1 5 3l-2 2 M12 17h.01 M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0',link:'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-2 2 M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l2-2',globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0 M3 12h18 M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',building:'M4 21V7l8-4v18 M12 9l8 3v9 M2 21h20 M7 10v1 M7 15v1 M16 14v1 M16 18v1',send:'M22 2L9 15 M22 2l-7 20-6-7-7-6 20-7Z',clip:'M8 12l7-7a4 4 0 1 1 6 6L10 22a6 6 0 0 1-8-8L13 3 M6 16l9-9a1.5 1.5 0 1 1 2 2l-9 9',menu:'M4 6h16 M4 12h16 M4 18h16',stop:'M6 6h12v12H6z',refresh:'M20 7V2 M20 7h-5 M4 17v5 M4 17h5 M4 8a8 8 0 0 1 13-4l3 3 M20 16a8 8 0 0 1-13 4l-3-3',lock:'M6 10V7a6 6 0 0 1 12 0v3 M4 10h16v12H4z M12 15v3'};
const icon=(name,cls='')=>`<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]||paths.file}"/></svg>`;
const names={dashboard:'工作台',update:'更新募集书',review:'复核募集书',generate:'材料生成',qa:'项目问答',tasks:'全部项目',login:'手机号注册 / 登录',billing:'积分与充值',checkout:'积分充值',payment:'订单与支付',task:'任务详情'};
const kindNames={update:'募集书更新',review:'募集书复核',generate:'材料与问答'};
const isChatRoute=route=>route==='generate'||route==='qa';
const scopeNames=SCOPE_NAMES;
const roleNames=ROLE_NAMES;
const statusNames={draft:'待提供材料',awaiting_confirmation:'待开始',needs_materials:'待补充材料',queued:'排队中',extracting:'解析材料',reviewing:'正在复核',updating:'正在更新',generating:'正在生成',exporting:'生成文档',complete:'已完成',failed:'处理失败',cancelled:'已停止',needs_setup:'服务暂不可用',interrupted:'可继续'};
const activeStatuses=['queued','extracting','reviewing','updating','generating','exporting'];
const retryStatuses=['failed','cancelled','needs_setup','interrupted'];
const state={route:'dashboard',jobs:[],health:{},packs:[],filter:'all',search:'',taskFilter:'all',step:1,files:{update:[],review:[],generate:[]},drafts:{},details:{},conversationId:'',projectId:'',chatDraft:'',web:false,registry:false,uploadRole:'',chatSending:false,connectors:[],connectorIds:[],queryIssuer:'',billing:null,user:null,accountEpoch:0,returnTo:'dashboard',orderCreating:false};
let toastTimer;
function toast(message,error=false){const el=$('#toast');el.textContent=message;el.className=`toast visible${error?' error':''}`;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),5000);}
async function api(path,options={}){if(options.method==='POST'&&['/api/tasks','/api/generation/tasks'].includes(path)&&!state.health.oneClickExecution)throw new Error('请先重启 BondBuddy 服务并刷新页面，再使用新版积分任务。');const epoch=state.accountEpoch;const r=await fetch(path,{...options,credentials:'same-origin'});const value=await r.json();if(epoch!==state.accountEpoch&&!path.startsWith('/api/auth/'))throw new Error('账号已切换，请重新打开页面。');if(!r.ok){if(r.status===401&&state.user){resetAccount();state.route='login';void render();}if(r.status===402)showModal('积分不足',`<p>${esc(value.error)}</p><a href="#billing" class="btn primary" data-action="close-modal">充值积分</a>`);throw Object.assign(new Error(value.error||'请求失败，请重试。'),{status:r.status,code:value.code});}return value;}
async function upload(path,body,options={}){const epoch=state.accountEpoch;try{const value=await uploadMultipart(path,body,options);if(epoch!==state.accountEpoch)throw new Error('账号已切换，请重新打开页面。');return value;}catch(error){if(epoch===state.accountEpoch&&error.status===401){resetAccount();state.route='login';void render();}if(epoch===state.accountEpoch&&error.status===402)showModal('积分不足','<p>'+esc(error.message)+'</p><a href="#billing" class="btn primary" data-action="close-modal">充值积分</a>');throw error;}}
const post=(path,data)=>api(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data||{})});
const date=v=>v?new Date(v).toLocaleDateString('zh-CN',{month:'2-digit',day:'2-digit'}):'—';
const bytes=n=>n>=1048576?(n/1048576).toFixed(1)+' MB':Math.ceil(n/1024)+' KB';
const badge=job=>`<span class="badge ${job.status==='failed'?'error':retryStatuses.includes(job.status)?'warn':activeStatuses.includes(job.status)?'info':''}">${activeStatuses.includes(job.status)?'<span class="dot"></span>':''}${statusNames[job.status]||esc(job.status)}</span>`;
const link=(route,label,style='primary',ico='')=>`<a class="btn ${style}" href="#${route}">${ico?icon(ico):''}${label}</a>`;
function head(title,subtitle,eyebrow='YOUR BOND WORKSPACE',action=''){return `<div class="page-head"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1>${subtitle?`<p>${subtitle}</p>`:''}</div>${action}</div>`;}
function showModal(title,body){$('#modal-content').innerHTML=`<div class="modal-head"><h2>${esc(title)}</h2><button type="button" class="icon-btn" data-action="close-modal" aria-label="关闭">${icon('close')}</button></div><div class="modal-body">${body}</div>`;$('#modal').showModal();}
function sidebar(){
  const nav=(route,ico,label)=>`<a href="#${route}" ${route==='library'?'data-action="library-open"':''} class="nav-item ${state.route===route?'active':''}" ${state.route===route?'aria-current="page"':''}>${icon(ico)}<span>${label}</span>${state.route===route?'<i class="tiny-dot"></i>':''}</a>`;
  $('#sidebar').innerHTML=`<a class="brand" href="#dashboard"><img src="/favicon.svg" alt="">bondbuddy<small>BETA</small></a><div class="workspace"><div class="workspace-icon">${icon('building')}</div><div><strong>我的工作空间</strong><small>PERSONAL WORKSPACE</small></div></div><nav aria-label="主导航">${nav('dashboard','grid','工作台')}<div class="nav-label">开始工作</div>${nav('update','update','更新募集书')}${nav('review','review','复核募集书')}${nav('generate','spark','材料生成')}${nav('qa','chat','项目问答')}<div class="nav-label">工作空间</div>${nav('tasks','folder','全部项目')}${nav('billing','shield','积分与充值')}</nav><div class="sidebar-bottom"><div class="user"><div class="avatar">我</div><div><strong>我的工作空间</strong><small>${esc(state.user?.phoneMasked||'我的账号')}</small></div><button type="button" class="icon-btn logout-btn" data-action="logout" title="退出登录" aria-label="退出登录">${icon('arrow')}</button></div></div>`;
  $('#topbar').innerHTML=`<div class="breadcrumb"><button class="mobile-menu icon-btn" data-action="menu" aria-label="打开菜单">${icon('menu')}</button><span>工作空间</span>${icon('chevron')}<span>${names[state.route]||'任务详情'}</span></div><div class="top-actions">${features.topbarBilling()}<button type="button" data-action="help">${icon('help')}使用指南</button></div>`;
}
function taskTable(jobs,compact=false){return jobs.length?`<div class="table-wrap"><table><thead><tr><th>项目名称</th>${compact?'':'<th>任务类型</th>'}<th>状态</th><th>最近更新</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><a class="task-title" href="#${j.kind==='generate'&&j.conversationId?'generate/'+j.conversationId:'task/'+j.id}">${esc(j.title)}</a><span class="sub">${esc(j.context?.issuer||kindNames[j.kind])}${j.context?.periods?' · '+esc(j.context.periods):''}</span></td>${compact?'':`<td>${esc(j.kind==='update'?modeName(j.context?.authoringMode):kindNames[j.kind])}</td>`}<td>${badge(j)}</td><td class="muted">${date(j.updatedAt)}</td><td><a href="#${j.kind==='generate'&&j.conversationId?'generate/'+j.conversationId:'task/'+j.id}" aria-label="查看${esc(j.title)}">${icon('chevron')}</a></td></tr>`).join('')}</tbody></table></div>`:`<div class="empty"><div class="empty-icon">${icon('folder')}</div><h3>${compact?'还没有项目成果':'你的下一份成果，从这里开始'}</h3><p>完成更新或复核后，文档和处理结果会汇集在这里。</p>${compact?'':link('update','新建募集书项目','secondary small','plus')}</div>`;}
function dashboard(){
  const completed=kind=>state.jobs.filter(j=>j.kind===kind&&j.status==='complete').length;
  const recent=state.jobs.filter(j=>j.kind!=='generate'&&(state.filter==='all'||j.kind===state.filter)).slice(0,4);
  return head('工作台','查看项目成果与处理进度，选择下一项任务。','INTELLIGENCE DASHBOARD')+`
  <div class="stats">${[['update','已更新募集书','份'],['review','已复核募集书','份'],['generate','已完成对话','次']].map(([kind,title,unit])=>`<a href="#tasks" class="stat" data-filter-link="${kind}"><div class="stat-icon">${icon(kind==='generate'?'chat':kind)}</div><div><div class="stat-label">${title}</div><div class="stat-number">${completed(kind)}<small>${unit}</small></div></div><span class="stat-tail">查看成果 ↗</span></a>`).join('')}</div>
  <section><div class="section-head"><h2>今天，从哪一步开始？</h2><span class="muted">专为债券项目工作而设计</span></div><div class="workflow-cards">${[
  ['update','01','更新募集书','结合项目资料与发行安排，<br>完成整份募集书的更新。','材料评估 · Word 导出'],
  ['review','02','复核募集书','财务数据、合规与格式、<br>公开信息，三类依据交叉复核。','复核报告 · 原文批注'],
  ['generate','03','材料生成','关联募集书，按模板生成<br>立项报告、核查意见等材料。','按需起草 · Word 导出'],
  ['qa','04','项目问答','解读项目与财务材料，<br>查询工商、股权和债券信息。','材料解读 · 信息查询']].map(([route,n,title,desc,tail])=>`<a class="workflow-card" href="#${route}"><span class="card-number">${n} /</span><div class="feature-icon">${icon(route==='generate'?'spark':route==='qa'?'chat':route)}</div><h3>${title}</h3><p>${desc}</p><div class="card-bottom"><span>${tail}</span>${icon('arrow')}</div></a>`).join('')}</div></section>
  <div class="dashboard-lower projects-only"><section class="panel"><div class="panel-head"><h2>最近项目</h2><a class="text-btn" href="#tasks">全部项目 ${icon('arrow')}</a></div><div class="tabs" role="tablist" aria-label="项目类别">${[['all','全部'],['update','已更新募集书'],['review','已复核募集书']].map(([v,t])=>`<button type="button" role="tab" aria-selected="${state.filter===v}" data-action="dashboard-filter" data-value="${v}" class="tab ${state.filter===v?'active':''}">${t}</button>`).join('')}</div>${taskTable(recent,true)}</section></div><div class="dashboard-foot">${icon('lock')} 材料保存在当前工作空间 · 原始文件始终保留</div>`;
}
function defaultDraft(kind){const now=new Date(),m=now.getMonth(),quarter=m<3?'12-31':m<6?'03-31':m<9?'06-30':'09-30';return {...optionalDefaults(),authoringMode:'',referenceFocus:'',title:'',issuer:'',exchange:'sse',offering:'private',year:String(now.getFullYear()-(m<3?1:0)),quarter,size:'',term:'',purpose:'',reviewNotes:'',connectorIds:[]};}
function draft(kind){if(!state.drafts[kind]){let saved={};try{saved=JSON.parse(localStorage.getItem('bondbuddy-'+(state.user?.id||'guest')+'-'+kind)||(state.user?.id==='primary'?localStorage.getItem('bondbuddy-'+kind):null)||'{}');}catch{}delete saved.investor;delete saved.connectorIds;state.drafts[kind]={...defaultDraft(kind),...saved};}return state.drafts[kind];}
function saveDraft(kind){try{localStorage.setItem('bondbuddy-'+(state.user?.id||'guest')+'-'+kind,JSON.stringify(state.drafts[kind]));}catch{}}
const scope=d=>`${d.exchange}-${d.offering}`;
const input=(name,label,value,placeholder='',required=false)=>`<div class="field"><label for="${name}">${label}${required?'<span class="required">*</span>':''}</label><input id="${name}" name="${name}" value="${esc(value)}" placeholder="${placeholder}" ${required?'required':''} maxlength="${name==='title'?150:500}"></div>`;
function reportingPreview(d,compact=false){
  const window=reportingPeriods(`${d.year}-${d.quarter}`,d.offering);
  if(compact==='simple')return `<p class="field-hint">报告期：${window.periods.map(p=>p.type==='annual'?`${p.end.slice(0,4)}年`:`${p.end.slice(0,4)}年1—${Number(p.end.slice(5,7))}月`).join('、')}</p>`;
  return `<div class="reporting-window ${compact?'compact':''}" aria-live="polite"><div class="reporting-window-title"><strong>本次覆盖报告期</strong><span>${window.basis}</span></div><ol>${window.periods.map((p,i)=>`<li class="${i===window.periods.length-1?'latest':''}"><strong>${p.label}</strong>${compact?'':`<small>截至 ${p.end.replaceAll('-','.')}</small>`}</li>`).join('')}</ol>${compact?'':`<p>${window.note}</p>`}</div>`;
}
function reportingLabel(context){try{return reportingPeriods(context.periods,context.scope.split('-')[1]).label;}catch{return context.periods||'';}}
function roleOptions(kind,value){return authoring.roleOptions(value,kind);}
function filesHtml(kind){return state.files[kind].map((f,i)=>`<div class="file-item"><div class="file-icon">${icon('file')}</div><div class="file-name"><strong title="${esc(f.file.name)}">${esc(f.file.name)}</strong><small>${bytes(f.file.size)} · 已选择，开始任务时上传</small></div><select aria-label="${esc(f.file.name)}的材料类型" data-file-index="${i}">${roleOptions(kind,f.role)}</select><button type="button" class="icon-btn" data-action="remove-file" data-value="${i}" aria-label="移除${esc(f.file.name)}">${icon('close')}</button></div>`).join('');}
function updateAction(){return '开始更新';}
function workflow(kind){return workspace.page(kind);}
function downloads(job){return(job.downloads||[]).map(name=>`<a class="download" href="/api/tasks/${job.id}/download/${encodeURIComponent(name)}" download>${icon(name.endsWith('.docx')?'file':'book')}<span>${esc(name)}<small>${name.endsWith('.docx')?'WORD DOCUMENT':'SUPPORTING FILE'}</small></span>${icon('download')}</a>`).join('');}
function taskDetail(job){
  if(['draft','awaiting_confirmation','needs_materials'].includes(job.status))return head(esc(job.title),esc(job.progress),'PROJECT','<a class="btn secondary" href="#tasks">返回项目</a>')+'<div class="panel form-card">'+workspace.quoteContent(job)+'<p>项目与已上传材料已保存，点击开始即可执行。</p><button class="btn primary" type="button" data-action="project-resume" data-value="'+job.id+'">'+'继续提供材料'+'</button></div>';

  const running=activeStatuses.includes(job.status),retry=retryStatuses.includes(job.status),result=job.result;
  const progress=job.totalSteps?Math.round((job.completedSteps||0)/job.totalSteps*100):0;
  return head(esc(job.title),`${esc(scopeNames[job.context.scope]||'')} · ${esc(reportingLabel(job.context))}`,job.kind==='update'?modeName(job.context.authoringMode):kindNames[job.kind]||'PROJECT',link('tasks','返回项目','secondary','folder'))+`<div class="panel progress-card" role="status"><div class="progress-symbol">${icon(job.status==='complete'?'check':running?'refresh':'clock',running?'spinner':'')}</div><div><h2>${statusNames[job.status]}</h2><p>${esc(job.progress)}</p>${running?`<div class="progressbar"><progress value="${progress}" max="100" aria-label="任务完成进度">${progress}%</progress></div><p>${job.completedSteps||0} / ${job.totalSteps||'—'} 个处理片段</p>`:''}</div><div class="actions">${retry?`<button type="button" class="btn secondary" data-action="retry" data-value="${job.id}">${icon('refresh')}继续任务</button>`:''}${running?`<button type="button" class="btn secondary" data-action="cancel" data-value="${job.id}">${icon('stop')}停止</button>`:''}</div></div>${creditReceipt(job)}<div class="result-grid"><div class="panel result-main"><h2>${result?'处理结果':'材料已妥善保存'}</h2>${result?.summary?`<div class="notice">${icon('check')}<span>${esc(result.summary)}</span></div>`:''}${result?.reviewCoverage?`<div class="review-dimensions">${result.reviewCoverage.map(d=>`<article><h3>${esc(d.title)}</h3><strong>${esc(d.status)}</strong><p>${esc(d.detail)}</p></article>`).join('')}</div>`:''}${result?.findings?.length?result.findings.map(f=>`<details class="finding"><summary><span class="badge ${f.priority==='P1'?'error':'warn'}">${esc(f.priority)}</span><strong>${esc(f.title)}</strong><span class="badge neutral">${esc(f.status)}</span></summary><div class="finding-body"><div class="key">${esc(f.id)} · ${esc(f.locator||'待人工定位')} · ${esc(f.annotationStatus)}</div><blockquote>${esc(f.quote||'原文无可用定位')}</blockquote><p>${esc(f.issue)}</p><div class="key">建议</div><p>${esc(f.suggestion)}</p><div class="key">证据</div>${f.evidence.map(e=>`<p>${esc(e.source)} / ${esc(e.locator)}：${esc(e.quote)}</p>`).join('')}<div class="key">规则与校验</div><p>${esc(f.ruleIds.join('、'))}<br>${esc(f.validationWarnings.join('；'))}</p></div></details>`).join(''):result?.findings?'<p class="muted">本次未报告可定位问题，请结合覆盖说明审阅。</p>':''}${result?.edits?.map(e=>`<details class="finding"><summary><span class="badge ${e.applied?'':'warn'}">${e.applied?'已修订':'未写入'}</span><strong>${esc(e.reason)}</strong></summary><div class="finding-body"><div class="key">原文 · ${esc(e.locator)}</div><blockquote>${esc(e.quote)}</blockquote><div class="key">更新后</div><p>${esc(e.replacement)}</p></div></details>`).join('')||''}${result?.sections?.map(s=>`<details class="finding"><summary><span class="badge ${s.gaps.length?'warn':''}">${s.gaps.length?'待补充':'已起草'}</span><strong>${esc(s.title)}</strong></summary><div class="finding-body"><p>${s.paragraphCount} 段正文 · ${s.tableCount} 张表</p>${s.gaps.map(g=>`<p>${esc(g)}</p>`).join('')}</div></details>`).join('')||''}${!result?`<p class="muted">${running?'任务正在后台处理，保持本机服务运行即可。你可以继续浏览其他项目。':'材料和已有处理进度均已保留，服务恢复后可继续。'}</p><div class="file-list">${job.files.map(f=>`<div class="file-item"><div class="file-icon">${icon('file')}</div><div class="file-name"><strong>${esc(f.filename)}</strong><small>${roleNames[f.role]} · ${bytes(f.size)}</small></div></div>`).join('')}</div>`:''}${result?.limitations?.length?`<h3>待补充与覆盖说明</h3><ul class="limits">${result.limitations.map(l=>`<li>${esc(l)}</li>`).join('')}</ul>`:''}</div><aside><div class="panel result-kv"><h3>成果文件</h3>${job.downloads?.length?downloads(job):'<p class="muted">处理完成后，可在这里下载文档。</p>'}</div><div class="panel result-kv"><h3>项目信息</h3><p class="muted">${esc(job.context.issuer)}</p><div class="detail-meta"><span>${job.files.length}份材料</span><span>${date(job.createdAt)} 创建</span></div></div></aside></div>`;
}
function tasks(){const filtered=state.jobs.filter(j=>(state.taskFilter==='all'||j.kind===state.taskFilter)&&`${j.title} ${j.context?.issuer||''}`.toLowerCase().includes(state.search.toLowerCase()));return head('所有工作，都有来处','从这里继续项目，或找到已经完成的成果。','PROJECT LIBRARY',link('update','新建项目','primary','plus'))+`<div class="toolbar"><div class="search-field">${icon('search')}<input class="control" id="project-search" aria-label="搜索项目" placeholder="搜索项目名称或发行人" value="${esc(state.search)}"></div><select class="control" id="task-filter" aria-label="筛选任务类型">${[['all','全部任务'],['update','募集书更新'],['review','募集书复核'],['generate','材料与问答']].map(([v,l])=>`<option value="${v}" ${state.taskFilter===v?'selected':''}>${l}</option>`).join('')}</select><span class="muted">${filtered.length} 个项目</span></div><div id="project-table" class="panel">${taskTable(filtered)}</div>`;}
function sourcesPanel(kind='generate'){return queries.panel(kind);}
const suggestionGroups=[
  {label:'材料起草',icon:'file',items:[
    ['起草项目说明书','帮我起草一份项目说明书，先确认项目背景和需要的资料；缺少的信息请列为待补充。'],
    ['整理补充材料清单','根据关联项目或上传的材料，整理还需补充的资料，逐项说明用途；没有项目资料时请先向我确认。'],
    ['起草募集资金用途','根据项目资料，起草募集资金用途说明，列明用途、金额和依据，不要编造缺失数据。'],
    ['整理项目要点','根据关联项目或上传的材料，整理一页项目要点，涵盖发行人、发行安排、财务情况和待确认事项。']
  ]},
  {label:'财务分析',icon:'review',items:[
    ['解读财务报表','帮我解读上传的财务报表，概括经营、偿债和现金流情况，并标明数据来源；请先确认需要的材料。'],
    ['分析财务指标变动','根据财务报表及附注，分析报告期内主要财务指标变动，区分有材料依据的原因和待核实的原因。'],
    ['梳理有息债务','根据项目材料，梳理有息债务构成、到期分布和担保情况，注明数据口径及缺失信息。'],
    ['提炼财务风险','根据上传的报表、附注及审计报告，提炼值得关注的财务风险，逐项列出依据和需进一步核实的事项。']
  ]},
  {label:'项目查询',icon:'search',items:[
    ['查全部公司债兑付','请查询该发行人发行过的全部公司债券，包括已到期与未到期，列示兑付、存续与违约情况，并给出来源及查询时间。'],
    ['查询工商与股权','查询发行人的工商信息和股权结构，列出股东、实际控制人及近期变更，注明来源和查询时间；请先确认公司全称。'],
    ['查近期公告与新闻','查询发行人的近期公告和新闻，按时间整理与本次债券项目相关的事项，注明来源；请先确认公司全称和查询时间范围。'],
    ['梳理项目进展','根据关联项目中的资料，概括当前进展、已经完成的工作和下一步待办，不确定的事项单独列出。']
  ]}
];
function suggestionButton([label,prompt]){return `<button type="button" class="starter-option" data-action="chat-suggestion" data-value="${esc(prompt)}"><span>${label}</span>${icon('arrow')}</button>`;}
function suggestions(){
  const groups=state.route==='qa'?[
    {label:'材料解读',icon:'file',items:[
      ['概括材料要点','请概括关联项目或上传材料的核心内容，列出关键事实、数据和需要关注的事项，并注明出处。'],
      ['解读债券条款','请解释材料中的债券期限、利率、回售、赎回及担保条款，并注明原文出处；没有材料时请先确认。'],
      ['说明项目进展','根据关联项目中的资料，说明目前已完成的工作、待办事项和仍需确认的信息。'],
      ['核对材料中的说法','请对照关联项目或上传的材料，核对我提出的问题或说法，给出依据；请先确认需要核对的内容。']
    ]},suggestionGroups[1],suggestionGroups[2]
  ]:suggestionGroups;
  return `<section class="task-starters" aria-label="建议任务"><div class="starters-heading"><h3>${state.route==='qa'?'可以从这些问题开始':'也可以从这些任务开始'}</h3><span>点击填入上方输入框，可修改后发送</span></div><div class="starter-grid">${groups.map(group=>`<section class="starter-category"><h4>${icon(group.icon)}${group.label}</h4><div class="starter-options">${group.items.map(suggestionButton).join('')}</div></section>`).join('')}</div></section>`;
}
function composer(busy=false){return `<form id="chat-form" class="chat-compose prompt-composer"><label class="prompt-label" for="chat-prompt">${conversationJobs().length?'继续对话':state.route==='qa'?'输入你的问题':'描述要生成的材料'}</label><div class="prompt-surface"><div id="chat-attachments">${state.files.generate.map((f,i)=>`<span class="attachment-pill">${esc(f.file.name)}<button type="button" data-action="remove-chat-file" data-value="${i}" aria-label="移除文件">×</button></span>`).join('')}</div><textarea id="chat-prompt" aria-label="${state.route==='qa'?'输入你的问题':'描述材料需求'}" placeholder="${state.route==='qa'?'例如：这家公司的偿债能力如何？请结合项目材料说明依据…':'例如：帮我起草一份项目说明书，并列出需要补充的资料…'}" maxlength="12000" required ${busy?'disabled':''}>${esc(state.chatDraft)}</textarea>${queries.issuer()}<div class="compose-bottom"><button type="button" class="attach-material" data-action="attach-chat-file">${icon('clip')}<span>添加材料</span></button><input id="chat-files" type="file" hidden multiple accept=".docx,.pdf,.xlsx,.csv,.txt"><a class="composer-quota" href="#billing">${Number(state.billing?.wallet?.available||0).toLocaleString('zh-CN')} 积分可用</a><button class="btn primary send" type="submit" ${busy||state.chatSending?'disabled':''}>${busy?'处理中':'发送'}${icon('send')}</button></div></div>${queries.status()}</form><p class="prompt-help">Enter 发送 · Shift + Enter 换行</p>${!conversationJobs().length?suggestions():''}`;}
function conversationJobs(){return state.jobs.filter(j=>j.conversationId===state.conversationId).reverse();}
function chatMessages(){const jobs=conversationJobs();if(!jobs.length)return '';
  return jobs.map(j=>{const full=state.details[j.id]||j;return `<div class="message user-message"><div class="message-content">${esc(j.prompt)}</div><div class="message-avatar">我</div></div><div class="message"><div class="message-avatar">${icon('spark')}</div><div class="message-content">${full.result?`${esc(full.result.answer)}${full.result.sources?.length?`<p class="message-source">来源：${full.result.sources.map(s=>esc(s)).join('；')}</p>`:''}${full.result.limitations?.length?`<p class="message-source">${full.result.limitations.map(l=>esc(l)).join('\n')}</p>`:''}${downloads(full)}${creditReceipt(full)}`:`${runningText(j)}${retryStatuses.includes(j.status)?`<p><button class="btn secondary small" type="button" data-action="retry" data-value="${j.id}">继续任务</button></p>`:''}${activeStatuses.includes(j.status)?`<p><button type="button" class="text-btn" data-action="cancel" data-value="${j.id}">停止生成</button></p>`:''}`}</div></div>`;}).join('');
}
function creditReceipt(job){const b=job.billing;if(!b)return '';return '<p class="task-credit-receipt">'+(b.legacy?'已按保留的旧套餐权益处理。':b.state==='pending_metering'?'用量核对中，暂未扣分。':b.state==='consumed'?'本次消耗 '+Number(b.charged||0).toLocaleString('zh-CN')+' 积分 · 当前可用 '+Number(state.billing?.wallet?.available||0).toLocaleString('zh-CN')+' 积分':'本次未扣分，冻结积分已释放。')+'</p>';}
function runningText(j){return `${activeStatuses.includes(j.status)?icon('refresh','spinner'):''} ${esc(j.progress)}`;}
function chat(){
  const conversations=[...new Set(state.jobs.filter(j=>j.kind==='generate'&&j.conversationId).map(j=>j.conversationId))].map(id=>state.jobs.find(j=>j.conversationId===id));
  const jobs=conversationJobs(),busy=jobs.some(j=>activeStatuses.includes(j.status));if(jobs.length)state.projectId=jobs[0].projectId||'';
  const newChat=jobs.length?`<button type="button" class="btn secondary" data-action="new-conversation">${icon('plus')}新对话</button>`:'';
  return head(names[state.route],state.route==='qa'?'解读材料、分析财务、查询项目信息，从一个问题开始。':'说出材料用途、内容与写作要求，起草项目说明书等工作文稿。',state.route==='qa'?'PROJECT Q&A':'MATERIAL STUDIO',newChat)+`
    <div class="chat-layout ${jobs.length?'has-conversation':'is-start'}">
      <aside class="chat-history"><details open><summary>最近对话 <span>${conversations.length}</span>${icon('down')}</summary><nav aria-label="最近对话">${conversations.map(j=>`<a class="conversation ${j.conversationId===state.conversationId?'active':''}" href="#${state.route}/${j.conversationId}" ${j.conversationId===state.conversationId?'aria-current="page"':''} title="${esc(j.title)}">${esc(j.title)}<small>${date(j.updatedAt||j.createdAt)} · ${statusNames[j.status]}</small></a>`).join('')||'<div class="history-empty">'+icon('chat')+'<p>还没有对话</p><small>发送第一条消息后，<br>就可以在这里继续聊。</small></div>'}</nav></details></aside>
      <section class="chat-main" aria-label="对话"><div class="chat-head"><h2>${icon('spark')} BondBuddy</h2><div class="chat-project-field"><label for="chat-project">关联项目 <span>· 选填</span></label><select id="chat-project" class="control" ${jobs.length?'disabled title="当前对话的关联项目已固定，可新建对话选择其他项目"':''}><option value="">自由对话</option>${state.jobs.filter(j=>j.kind!=='generate').map(j=>`<option value="${j.id}" ${j.id===state.projectId?'selected':''}>${esc(j.title)}</option>`).join('')}</select></div></div>
      <div class="chat-messages" id="chat-messages">${chatMessages()}</div>${composer(busy)}</section>
    </div>`;
}

async function render(){
  const active=document.activeElement;
  const focus=['INPUT','TEXTAREA'].includes(active?.tagName)&&active.id&&active.closest('#main')?{id:active.id,start:active.selectionStart,end:active.selectionEnd}:null;
  document.body.classList.toggle('signed-out',!state.user);if(!state.user){$('#sidebar').innerHTML='';$('#topbar').innerHTML='';$('#main').innerHTML=authUI.page();authUI.tick();return;}
  sidebar();let html;
  if(state.route==='dashboard')html=dashboard();
  else if(['update','review'].includes(state.route))html=workflow(state.route);
  else if(state.route==='tasks')html=tasks();
  else if(state.route==='billing'){await features.refresh();html=features.billingPage();}
  else if(state.route==='checkout')html=features.billingPage();
  else if(state.route==='payment')html=await features.paymentPage(state.orderId);
  else if(state.route==='generate'&&!state.conversationId)html=studio.page();
  else if(isChatRoute(state.route)){for(const j of conversationJobs())if(j.status==='complete'&&(!state.details[j.id]||state.details[j.id].billing?.state!==j.billing?.state))state.details[j.id]=(await api('/api/tasks/'+j.id)).job;html=chat();}
  else if(state.route==='task'){const {job}=await api('/api/tasks/'+state.taskId);state.details[job.id]=job;html=taskDetail(job);}
  else html=dashboard();
  $('#main').innerHTML=html;
  if(focus){const restored=document.getElementById(focus.id);if(restored&&!restored.disabled){restored.focus({preventScroll:true});if(typeof focus.start==='number')restored.setSelectionRange(focus.start,focus.end);}}
  if(isChatRoute(state.route)&&state.conversationId&&conversationJobs().length)$('#chat-messages').scrollTop=$('#chat-messages').scrollHeight;
}
async function navigate(){const [route,id]=(location.hash.slice(1)||'dashboard').split('/');if(!state.user){if(route!=='login')state.returnTo=names[route]?(route+(id?'/'+id:'')):'dashboard';state.route='login';await render();return;}state.route=names[route]&&route!=='login'?route:'dashboard';if(route==='library'){location.hash='update';return;}if(route==='task')state.taskId=id;if(route==='payment')state.orderId=id;if(isChatRoute(route))state.conversationId=id||'';if(route==='knowledge'){location.hash='qa';return;}if(['update','review'].includes(route)){state.step=state.resumeProjectStep||1;state.resumeProjectStep=0;state.uploadRole='';}$('#sidebar').classList.remove('open');try{await render();window.scrollTo(0,0);}catch(e){if(!state.user){await render();return;}toast(e.message,true);$('#main').innerHTML=head('暂时无法打开这个项目',esc(e.message),'PROJECT',link('tasks','返回项目','secondary'));}}
function addFiles(files,kind,explicitRole){
  if(['update','review'].includes(kind)){void workspace.addFiles(files,explicitRole||'audit').catch(error=>toast(error.message,true));return;}
  const role=explicitRole||(kind==='generate'?'other':$('#upload-role')?.value||(kind==='review'?'updated':'audit'));
  if(kind==='update'&&['historical','reference'].includes(role)){
    const selected=Array.from(files);
    if(selected.length!==1||!selected[0].size||!(role==='reference'?/\.(docx|pdf)$/i:/\.docx$/i).test(selected[0].name)){toast(role==='reference'?'请选择一份非空 DOCX 或文字版 PDF 募集书。':'请选择一份非空 DOCX 募集书。',true);return;}
    const remaining=state.files.update.filter(f=>f.role!==role);
    if(remaining.length>=60||remaining.reduce((n,f)=>n+f.file.size,0)+selected[0].size>80*1024*1024){toast('最多60份材料，合计不能超过80 MB。',true);return;}
    if(role==='reference'){delete draft('update').libraryBlueprint;saveDraft('update');}state.files.update=[...remaining,{file:selected[0],role}];void render();return;
  }
  const current=state.files[kind];
  for(const file of files){if(!/\.(docx|pdf|xlsx|csv|txt)$/i.test(file.name)||!file.size){toast('仅支持非空 DOCX、PDF、XLSX、CSV、TXT 文件。',true);continue;}if(current.some(f=>f.file.name===file.name&&f.file.size===file.size)){toast('该文件已经在材料列表中。');continue;}if(current.length>=60||current.reduce((n,f)=>n+f.file.size,0)+file.size>80*1024*1024){toast('最多60份材料，合计不能超过80 MB。',true);break;}current.push({file,role});}
  void render();
}
async function refreshJobs(withBilling=true){state.jobs=(await api('/api/tasks')).jobs;if(withBilling)await features.refresh();}
document.addEventListener('input',e=>{studio.input(e.target);workspace.input(e.target);authUI.input(e);if(e.target.closest('#workflow-form')&&e.target.name){draft(state.route)[e.target.name]=e.target.value;saveDraft(state.route);}features.change(e);if(e.target.id==='query-issuer')state.queryIssuer=e.target.value;if(e.target.id==='chat-prompt'){state.chatDraft=e.target.value;state.chatRequestId=null;queries.refresh();}if(e.target.id==='project-search'){state.search=e.target.value;const filtered=state.jobs.filter(j=>(state.taskFilter==='all'||j.kind===state.taskFilter)&&`${j.title} ${j.context?.issuer||''}`.toLowerCase().includes(state.search.toLowerCase()));$('#project-table').innerHTML=taskTable(filtered);}});
document.addEventListener('change',e=>{const el=e.target;if(el.dataset?.studioField||el.dataset?.studioUpload){void studio.change(el).catch(error=>toast(error.message,true));return;}if(workspace.change(el))return;if(el.id==='workspace-primary'){const kind=state.route,role=kind==='review'?'updated':'historical';if(el.files.length!==1||!el.files[0].name.toLowerCase().endsWith('.docx')){toast('请选择一份 DOCX 募集书。',true);return;}state.files[kind]=state.files[kind].filter(f=>f.role!==role);addFiles(el.files,kind,role);return;}features.change(e);if(el.id==='primary-material')addFiles(el.files,'update',primaryRole('update',draft('update').authoringMode));else if(el.id==='material-files')addFiles(el.files,state.route);else if(el.id==='chat-files')addFiles(el.files,'generate');else if(el.id==='upload-role')state.uploadRole=el.value;else if(el.dataset.fileIndex!==undefined){if(state.route==='update'&&!SUPPORT_ROLES.includes(el.value))return;state.files[state.route][Number(el.dataset.fileIndex)].role=el.value;void render();}else if(el.id==='task-filter'){state.taskFilter=el.value;void render();}else if(el.id==='chat-project'){state.projectId=el.value;state.queryIssuer='';queries.refresh();}else if(el.closest('#workflow-form')&&OPTIONAL_FIELDS.some(f=>f.key===el.name)){draft(state.route)[el.name]=el.value;saveDraft(state.route);document.querySelectorAll('[data-dependent]').forEach(field=>{field.hidden=draft(state.route)[field.dataset.dependent]!==field.dataset.dependentValue;});}else if(el.closest('#workflow-form')&&['exchange','offering','quarter','year','authoringMode'].includes(el.name)){draft(state.route)[el.name]=el.value;saveDraft(state.route);void render().then(()=>{if(el.name==='authoringMode')document.querySelector('input[name=authoringMode]:checked')?.focus();});}});
document.addEventListener('dragover',e=>{const zone=e.target.closest('.dropzone');if(zone){e.preventDefault();zone.classList.add('dragging');}});
document.addEventListener('dragleave',e=>e.target.closest('.dropzone')?.classList.remove('dragging'));
document.addEventListener('drop',e=>{const zone=e.target.closest('.dropzone');if(zone){e.preventDefault();zone.classList.remove('dragging');if(zone.dataset.studioUpload){try{studio.addFiles(e.dataTransfer.files,zone.dataset.studioUpload);}catch(error){toast(error.message,true);}}else addFiles(e.dataTransfer.files,state.route,zone.dataset.uploadRole);}});
document.addEventListener('keydown',e=>{if(e.target.id==='chat-prompt'&&e.key==='Enter'&&!e.shiftKey&&!e.isComposing){e.preventDefault();if(!state.chatSending&&!conversationJobs().some(j=>activeStatuses.includes(j.status)))$('#chat-form').requestSubmit();}});
document.addEventListener('click',async e=>{
  const filter=e.target.closest('[data-filter-link]');if(filter)state.taskFilter=filter.dataset.filterLink;
  const el=e.target.closest('[data-action]');if(!el)return;const {action,value}=el.dataset;
  try {
    if(await authUI.click(action,el))return;
    if(await features.click(action,value,el))return;
    if(await workspace.click(action,value,el))return;
    if(await studio.click(action,value,el))return;
    if(action==='menu')$('#sidebar').classList.toggle('open');
    else if(action==='close-modal')$('#modal').close();
    else if(action==='dashboard-filter'){state.filter=value;await render();}
    else if(action==='previous-step'){state.step=Math.max(1,state.step-1);await render();window.scrollTo(0,0);}
    else if(action==='remove-file'){state.files[state.route].splice(Number(value),1);await render();}
    else if(action==='remove-chat-file'){state.files.generate.splice(Number(value),1);await render();}
    else if(action==='attach-chat-file')$('#chat-files').click();
    else if(action==='cancel'||action==='retry'){el.disabled=true;await post(`/api/tasks/${value}/${action}`);await refreshJobs();delete state.details[value];await render();toast(action==='cancel'?'已请求停止，正在保存进度。':'任务已进入队列。');}
    else if(action==='new-conversation'){state.conversationId='';state.projectId='';state.queryIssuer='';state.chatDraft='';state.files.generate=[];if(location.hash==='#'+state.route)await render();else location.hash=state.route;}
    else if(action==='chat-suggestion'){state.chatDraft=value;$('#chat-prompt').value=value;queries.refresh();$('#chat-prompt').focus();}
    else if(action==='help')showModal('开始使用 BondBuddy','<h3>点击即执行</h3><p>创建项目、提供材料和要求后点击开始。余额足够即执行，余额不足时提示充值。</p><h3>积分</h3><p>更新、复核、材料生成和问答使用统一余额；按实际用量结算，多退不补。失败或取消释放本次积分。上传和创建项目免费。</p><h3>项目与材料</h3><p>项目保存在本机，关闭网页不影响后台任务。后台服务需保持开启。</p>');
  }catch(error){toast(error.message,true);el.disabled=false;}
});
document.addEventListener('submit',async e=>{
  e.preventDefault();const form=e.target;
  try {
    if(await authUI.submit(form))return;
    if(await features.submit(form))return;
    if(await workspace.submit(form))return;
    if(await studio.submit(form))return;
    if(form.id==='chat-form') {
      if(!isChatRoute(state.route)||state.chatSending||conversationJobs().some(j=>activeStatuses.includes(j.status)))return;
      if(!state.chatDraft.trim())return;state.chatSending=true;form.querySelector('button[type=submit]').disabled=true;
      const chatRoute=state.route,data=new FormData();data.set('kind','generate');const requestFingerprint=JSON.stringify([state.chatDraft,state.conversationId,state.projectId,state.queryIssuer,state.files.generate.map(f=>[f.role,f.file.name,f.file.size,f.file.lastModified])]);if(state.chatRequestFingerprint!==requestFingerprint){state.chatRequestId=crypto.randomUUID();state.chatRequestFingerprint=requestFingerprint;}state.chatRequestId??=crypto.randomUUID();data.set('requestId',state.chatRequestId);data.set('prompt',state.chatDraft);data.set('conversationId',state.conversationId);data.set('queryMode','auto');data.set('queryIssuer',state.queryIssuer||state.jobs.find(j=>j.id===state.projectId)?.context?.issuer||'');data.set('projectId',state.projectId);for(const f of state.files.generate)data.append(f.role,f.file);
      const {job}=await api('/api/tasks',{method:'POST',body:data});if(job.generation){state.chatRequestId=null;state.chatDraft='';state.files.generate=[];state.chatSending=false;await refreshJobs();location.hash='task/'+job.id;return;}state.conversationId=job.conversationId;state.chatRequestId=null;state.chatDraft='';state.files.generate=[];state.chatSending=false;await refreshJobs();if(location.hash==='#'+chatRoute+'/'+job.conversationId)await render();else location.hash=chatRoute+'/'+job.conversationId;
    }
  } catch(error){state.chatSending=false;toast(error.message,true);form.querySelectorAll('button').forEach(b=>b.disabled=false); }
});
window.addEventListener('hashchange',()=>void navigate());
async function poll(){try{if(!state.user)return;const previous=JSON.stringify(state.jobs.map(j=>[j.id,j.status,j.completedSteps,j.billing?.state]));await refreshJobs(false);const changed=previous!==JSON.stringify(state.jobs.map(j=>[j.id,j.status,j.completedSteps,j.billing?.state]));if(changed)await features.refresh();if(state.route==='task'){const current=state.jobs.find(j=>j.id===state.taskId);if(current&&changed){const {job}=await api('/api/tasks/'+state.taskId);state.details[job.id]=job;$('#main').innerHTML=taskDetail(job);}}else if(isChatRoute(state.route)&&state.conversationId&&changed){for(const j of conversationJobs())if(j.status==='complete'&&(!state.details[j.id]||state.details[j.id].billing?.state!==j.billing?.state))state.details[j.id]=(await api('/api/tasks/'+j.id)).job;const container=$('#chat-messages');if(container){container.innerHTML=chatMessages();container.scrollTop=container.scrollHeight;const busy=conversationJobs().some(j=>activeStatuses.includes(j.status));$('#chat-prompt').disabled=busy;const send=$('#chat-form button[type=submit]');send.disabled=busy;send.innerHTML=`${busy?'处理中':'发送'}${icon('send')}`;}}else if(state.route==='dashboard'&&changed)$('#main').innerHTML=dashboard();if(changed)sidebar();}catch{/* Retain visible work during transient connection failures. */}finally{setTimeout(poll,2500);}}
function resetAccount(){state.accountEpoch++;state.libraryId='';state.libraryReturn=false;state.resumeUpdateStep=0;Object.assign(state,{materialDraft:null,user:null,billing:null,jobs:[],details:{},drafts:{},files:{update:[],review:[],generate:[]},conversationId:'',projectId:'',chatDraft:'',queryIssuer:'',connectorIds:[],connectors:[],order:null,chatSending:false,chatRequestId:null});$('#modal')?.close();}
let pollStarted=false;
async function loadWorkspace(){const [jobs,connectors,health,billing]=await Promise.all([api('/api/tasks'),api('/api/connectors'),api('/api/health'),api('/api/billing')]);state.jobs=jobs.jobs;state.connectors=connectors.connectors;state.health=health;state.billing=billing;if(!pollStarted){pollStarted=true;void poll();}}
async function onLogin(user){resetAccount();state.user=user;await loadWorkspace();const route=state.returnTo&&state.returnTo!=='login'?state.returnTo:'dashboard';state.returnTo='dashboard';location.hash=route;await navigate();}
async function onLogout(){resetAccount();state.returnTo='dashboard';location.hash='login';await render();}
const authoring=authoringUI({state,esc,icon,bytes,reportingPreview});
const workspace=projectWorkspace({state,esc,icon,bytes,head,api,post,toast,render,draft,saveDraft,authoring,reportingPreview,refreshJobs,upload});
const studio=materialStudio({state,esc,icon,bytes,head,api,upload,render,toast,refreshJobs});
const queries=querySourcesUI({state,draft,saveDraft,esc,icon,showModal});
const features=accountUI({state,esc,icon,link,head,api,post,toast,showModal,render,refreshJobs});
const authUI=phoneAuthUI({state,esc,icon,post,toast,onLogin,onLogout,render});
async function init(){try{const session=await api('/api/auth/session');state.user=session.user;if(state.user)await loadWorkspace();await navigate();}catch(e){$('#main').innerHTML=head(e.status===404?'请重新启动 BondBuddy':'工作空间暂未连接',e.status===404?'手机号注册与简化付款已准备好，重启本机服务后刷新即可使用。':esc(e.message),'BONDBUDDY');toast(e.status===404?'需要重新启动服务以启用新功能。':e.message,true);}}
void init();
