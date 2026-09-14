/* Brokerage Cowork: personal overview, project collaboration, delivery inbox, ecosystem.
 * Existing projects and review APIs remain authoritative. Automation plans are local drafts.
 */
const CO = {
  page:['home','project','conversation','inbox','ecosystem'].includes(new URLSearchParams(location.search).get('screen'))?new URLSearchParams(location.search).get('screen'):'home',
  summaries:new Map(), loading:false, loaded:false, errors:[], refreshed:0,
  inboxTab:'deliveries', inboxFilter:'all', selectedMail:null, ecoTab:'plugins', projectSearch:'',
  focus:false, sideOpen:false, mobileNav:false, homeDraft:'', homeProject:'', homeSending:false, homeError:'', scrolls:new Map(), ready:false,
  read:coReadStorage('bond-cowork-read',{}), plans:coReadStorage('bond-cowork-plans',[]),
};
function coReadStorage(key,fallback){try{const value=JSON.parse(localStorage.getItem(key));return Array.isArray(fallback)?(Array.isArray(value)?value.filter(v=>v&&typeof v==='object'):fallback):(value&&typeof value==='object'&&!Array.isArray(value)?value:fallback);}catch{return fallback;}}
function coPersist(key,value){try{localStorage.setItem(key,JSON.stringify(value));return true;}catch{toast('浏览器暂时无法保存，请保留当前页面。',true);return false;}}
function coSymbol(name){
  const extra={home:'m3 10 9-7 9 7v10H3ZM9 20v-7h6v7',inbox:'M4 4h16l2 12v4H2v-4ZM2 16h6l2 3h4l2-3h6',grid:'M3 3h7v7H3ZM14 3h7v7h-7ZM3 14h7v7H3ZM14 14h7v7h-7Z',search:'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',bell:'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4',layers:'m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 16l10 5 10-5'};
  return extra[name]?`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${extra[name]}"/></svg>`:icon(name);
}
function coHash(text){let value=2166136261;for(const c of text){value=Math.imul(value^c.charCodeAt(0),16777619);}return (value>>>0).toString(36);}
function coSummarize(p){
  const changes=(p.changes||[]).filter(c=>c.origin==='agent'&&c.status!=='rejected'&&c.before!==c.after&&c.sources?.length);
  const pending=changes.filter(c=>c.status==='pending');
  return {id:p.id,title:p.title,mode:p.mode,period:p.period,demo:p.demo,updated_at:p.updated_at,stats:p.stats,
    hasDocument:!!p.document,job:{...p.job},files:p.files.map(f=>({id:f.id,name:f.name,category:f.category})),
    result:changes.length?{count:changes.length,pending:pending.length,target:(pending[0]||changes[0]).target_id,
      stamp:coHash(changes.map(c=>`${c.id}:${c.version}`).sort().join('|')),at:changes.map(c=>c.created_at).filter(Boolean).sort().at(-1)}:null};
}
async function coLoadWorkspace(force=false){
  if(CO.loading||(!force&&Date.now()-CO.refreshed<45000))return;
  CO.loading=true;CO.errors=[];render();
  try{
    await loadProjects();const ids=new Set(S.projects.map(p=>p.id));
    for(const id of CO.summaries.keys())if(!ids.has(id))CO.summaries.delete(id);
    const queue=S.projects.filter(p=>p.id!==S.p?.id).slice();
    const worker=async()=>{while(queue.length){const p=queue.shift();try{const data=await api(`/api/projects/${p.id}`);CO.summaries.set(p.id,coSummarize(data));}catch{CO.summaries.delete(p.id);CO.errors.push(p.title);}}};
    await Promise.allSettled([worker(),worker()]);
    if(S.p)CO.summaries.set(S.p.id,coSummarize(S.p));
    await csLoadList();
    CO.refreshed=Date.now();CO.loaded=true;
  }catch(error){CO.errors.push(error.message);}finally{CO.loading=false;render();}
}
function coProjects(){return [...CO.summaries.values()].filter(p=>!p.demo).sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}
function coMails(){
  return coProjects().flatMap(p=>{
    const list=[];
    if(p.result)list.push({id:`${p.id}:result:${p.result.stamp}`,project:p,type:'result',title:'募集书修订稿已准备',label:'成果交付',
      summary:`${p.result.count} 处有依据的 AI 修改，${p.result.pending} 处待审阅。`,at:p.result.at||p.updated_at,
      detail:'这一份交付来自项目中已经保存的 AI 修改。打开工作稿，可逐处查看修改前后、计算口径和来源原文。',filter:'verified',target:p.result.target,trigger:'现有项目更新结果'});
    if(['failed','interrupted','cancelled'].includes(p.job.status))list.push({id:`${p.id}:run:${coHash((p.job.started_at||'')+p.job.status+(p.job.error||''))}`,project:p,type:'attention',title:chatJob(p)?'这条请求需要继续处理':'这轮更新需要继续推进',label:'需要处理',
      summary:`${pwStatus(p)}。已完成的修改继续保留。`,at:p.job.finished_at||p.updated_at,detail:p.job.error||'任务已停止。可回到项目补充要求，或重新发起更新。',filter:'awaiting_agent',trigger:'项目执行状态'});
    return list;
  }).sort((a,b)=>b.at.localeCompare(a.at));
}
function coUnread(){return coMails().filter(m=>!CO.read[m.id]).length;}
function coRoute(page){
  closeModal();CO.page=page;CO.sideOpen=false;CO.mobileNav=false;
  const url=new URL(location.href);url.searchParams.set('screen',page);
  if(page==='conversation'){url.searchParams.delete('project');if(CCHAT.current)url.searchParams.set('conversation',CCHAT.current.id);else url.searchParams.delete('conversation');}
  else{url.searchParams.delete('conversation');if(S.p)url.searchParams.set('project',S.p.id);}
  history.replaceState(null,'',url);
  render();if(page!=='project')coLoadWorkspace();
}
async function coOpenProject(id,filter,target){
  if(PW.loadingProject)return false;
  PW.loadingProject=true;CO.page='project';CO.focus=false;CO.sideOpen=false;closeModal();
  try{if(S.p?.id!==id)await selectProject(id);if(target)selectTarget(target,true);else if(filter){S.queue=filter;S.tab='queue';}else S.tab='chat';coRoute('project');return true;}
  catch(error){toast(error.message,true);return false;}finally{PW.loadingProject=false;render();}
}
async function coSendHomeRequest(request,id){
  request=String(request||'').trim();
  id=String(id||'');
  if(!request||CO.homeSending||S.sending||PW.loadingProject||CCHAT.sending)return false;
  CO.homeDraft=request;CO.homeProject=id;CO.homeSending=true;CO.homeError='';render();
  try{
    if(!id){const sent=await csStartFromHome(request);if(sent)CO.homeDraft='';return sent;}
    if(!await coOpenProject(id)||S.p?.id!==id){CO.homeError='项目暂时无法打开，输入已保留，请重试。';coRoute('home');return false;}
    // A home request has project scope, never the previously selected paragraph or draft.
    S.selected=null;S.tab='chat';CO.sideOpen=true;render();
    const sent=await sendMessage(request,{targetId:null,preserveDraft:true});
    if(sent){CO.homeDraft='';CO.homeError='';}
    else CO.homeError='尚未发送，输入已保留。请处理项目提示后重试。';
    return sent;
  }catch(error){CO.homeError=error.message;toast(error.message,true);return false;}
  finally{CO.homeSending=false;render();}
}
function coHomeComposer(){
  const projects=S.projects.filter(p=>!p.demo);
  const id=projects.some(p=>p.id===CO.homeProject)?CO.homeProject:'';
  const locked=CO.homeSending||S.sending||PW.loadingProject||CCHAT.sending;
  return `<form class="co-home-compose" id="co-request-form" aria-busy="${!!locked}"><label for="co-home-request"><span class="co-compose-mark">${icon('spark')}</span>和 Cowork 一起，开始下一步</label><textarea id="co-home-request" name="request" rows="2" required maxlength="12000" ${locked?'disabled':''} placeholder="问一个问题，讨论一段内容，或直接说：根据新一期财报更新募集书">${esc(CO.homeDraft)}</textarea><div><label class="co-request-scope" for="co-request-project">关联项目<select id="co-request-project" name="project" ${locked?'disabled':''}><option value="" ${!id?'selected':''}>不关联项目 · 直接对话</option>${projects.map(p=>`<option value="${esc(p.id)}" ${p.id===id?'selected':''}>${esc(p.title)} · ${p.mode==='financial'?'财务':'全文'}</option>`).join('')}</select></label><button class="co-primary" type="submit" ${locked?'disabled':''}>${locked?'<i class="spinner"></i>正在发送':'发送 '+icon('send')}</button></div><small>${id?'在所选项目中继续对话，使用该项目的材料和历史消息。':'直接开始独立对话，不读取项目材料。'}Ctrl + Enter 发送</small>${CO.homeError?`<p class="co-compose-error" role="alert">${esc(CO.homeError)}</p>`:''}</form>`;
}
function coSidebar(){
  const nav=[['home','home','首页'],['project','folder','项目'],['inbox','inbox','收件箱'],['ecosystem','grid','生态']];
  return `<aside class="co-sidebar"><a class="co-brand" href="/cowork.html"><span>B</span><div>券商 Cowork<small>承销业务协作空间</small></div></a>
    <nav aria-label="主导航">${nav.map(([id,symbol,label])=>`<button data-co="nav" data-page="${id}" class="co-nav ${(CO.page===id||(id==='home'&&CO.page==='conversation'))?'active':''}" ${(CO.page===id||(id==='home'&&CO.page==='conversation'))?'aria-current="page"':''}>${coSymbol(symbol)}<span>${label}</span>${id==='inbox'&&coUnread()?`<b>${coUnread()}</b>`:''}</button>`).join('')}</nav>
    <div class="co-side-section"><div class="co-side-label">最近项目<button data-action="new-project" aria-label="新建项目">${icon('plus')}</button></div>${S.projects.filter(p=>!p.demo).slice(0,5).map(p=>`<button class="co-side-project ${CO.page==='project'&&p.id===S.p?.id?'active':''}" data-co="project" data-id="${esc(p.id)}"><i></i><span>${esc(p.title)}</span></button>`).join('')||'<p class="co-muted">从一份募集书开始</p>'}</div>
    <div class="co-side-section cs-recent"><div class="co-side-label">独立对话<button data-co="new-conversation" aria-label="开始独立对话">${icon('plus')}</button></div>${CCHAT.items.slice(0,3).map(c=>`<button class="co-side-project ${CO.page==='conversation'&&CCHAT.current?.id===c.id?'active':''}" data-co="conversation" data-id="${esc(c.id)}"><i></i><span>${esc(c.title)}</span></button>`).join('')}<button class="co-link" data-co="conversation-history">查看全部对话</button></div>
    <div class="co-side-bottom"><button data-co="ecosystem-connections">${coSymbol('globe')}能力与连接<span>${icon('chevron')}</span></button><button data-action="workspace-info"><span class="co-avatar">${S.storage.shared?'共':'我'}</span><div>${S.storage.shared?'共享工作空间':'我的工作空间'}<small>${S.storage.shared?'当前可访问的项目':'本机项目 · 未启用人员分派'}</small></div>${icon('settings')}</button></div></aside>`;
}
function coTopbar(){
  if(CO.page==='project'&&S.p?.document)return `<header class="co-work-topbar"><div><div class="co-work-breadcrumb"><button data-co="nav" data-page="home">工作空间</button><span>/</span>${S.p.mode==='financial'?'财务数据更新':'全文更新'}</div><h1>${esc(S.p.title)}<span class="co-chip ${S.p.job.status==='failed'?'amber':''}">${pwStatus(S.p)}</span></h1></div><div class="co-work-actions"><button class="secondary" data-action="materials">${icon('clip')}项目材料</button><button class="co-link" data-action="history">处理记录</button><button class="secondary" data-action="export" ${S.exporting?'disabled':''}>${icon('download')}${S.exporting?'正在导出':'导出'}</button><button class="co-primary" data-pw="prepare" ${busy()?'disabled':''}>${icon('spark')}${busy()?'正在处理':'开始更新'}</button>${busy()?'<button class="secondary" data-action="cancel">停止</button>':''}</div></header>`;
  const title={home:'我的工作',conversation:'Cowork 对话',project:S.p?.title||'项目',inbox:'AI 收件箱',ecosystem:'能力生态'}[CO.page];
  return `<header class="co-topbar"><div class="co-top-left"><button class="co-mobile-menu" data-co="mobile-menu" aria-label="打开导航">${icon('list')}</button><span class="co-top-crumb">工作空间</span><span class="co-slash">/</span><strong>${esc(title)}</strong></div><div class="co-top-actions"><button class="co-search-button" data-co="search">${coSymbol('search')}<span>查找项目</span><kbd>⌘ K</kbd></button><button class="co-bell" data-co="nav" data-page="inbox" aria-label="查看 AI 收件箱">${coSymbol('bell')}${coUnread()?'<i></i>':''}</button><span class="co-preview">UX 预览</span></div></header>`;
}
function coEmpty(title,text,action=''){return `<div class="co-empty">${coSymbol('layers')}<h3>${title}</h3><p>${text}</p>${action}</div>`;}
function coHome(){
  const projects=coProjects(),mails=coMails().filter(m=>m.type==='result'),pending=projects.filter(p=>p.stats.pending||p.stats.needs_review),
    attention=projects.filter(p=>['failed','interrupted','cancelled'].includes(p.job.status)),awaiting=projects.filter(p=>p.stats.awaiting_agent),
    tasks=projects.filter(p=>p.stats.pending||p.stats.needs_review||p.stats.awaiting_agent||['failed','interrupted','cancelled','idle'].includes(p.job.status));
  tasks.sort((a,b)=>(b.stats.pending>0)-(a.stats.pending>0)||(b.stats.needs_review>0)-(a.stats.needs_review>0));
  return `<div class="co-page co-home" data-co-scroll="home"><div class="co-greeting"><div><div class="co-eyebrow">${new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})} · PERSONAL WORKSPACE</div><h1>今天，先推进这些事。</h1><p>从需要你判断的地方开始，和 Cowork 一起把项目向前推进。</p></div><button class="co-primary" data-action="new-project">${icon('plus')}开始新的募集书更新</button></div>
    ${coHomeComposer()}<div class="co-overview-line"><button data-co="home-filter" data-kind="review"><b>${pending.length}</b><span>个项目待审阅</span>${icon('chevron')}</button><button data-co="home-filter" data-kind="attention"><b>${attention.length}</b><span>个项目执行受阻</span>${icon('chevron')}</button><button data-co="nav" data-page="inbox"><b>${coUnread()}</b><span>条交付与提醒未读</span>${icon('chevron')}</button><span>${CO.loading?'正在整理现有项目…':`来自 ${projects.length} 个现有项目`}</span></div>
    ${CO.errors.length?`<div class="co-load-notice">部分项目暂时无法读取，当前清单不完整。<button data-co="refresh">重新读取</button></div>`:''}
    <div class="co-home-grid"><section class="co-section co-tasks"><div class="co-section-title"><div><span class="co-kicker">YOUR NEXT MOVE</span><h2>需要你推进</h2></div><span class="co-muted">按当前处理状态排列</span></div>
      <div class="co-task-list">${tasks.slice(0,6).map(p=>{const kind=p.stats.pending?'review':p.stats.needs_review?'todo':['failed','interrupted','cancelled'].includes(p.job.status)?'attention':'continue';
        const text=kind==='review'?`审阅 ${p.stats.pending} 处修改`:kind==='todo'?`处理 ${p.stats.needs_review} 处【】待办`:kind==='attention'?(chatJob(p)?'继续处理这条请求':'继续这轮受阻的更新'):p.hasDocument?'继续核对募集书':'添加募集书和材料';
        const filter=kind==='review'?'verified':kind==='todo'?'needs_review':kind==='attention'?'awaiting_agent':'';
        return `<button class="co-task-row" data-co="project" data-id="${esc(p.id)}" data-filter="${filter}"><span class="co-task-icon ${kind}">${coSymbol(kind==='review'?'edit':kind==='todo'?'info':kind==='attention'?'clock':'file')}</span><span class="co-task-copy"><strong>${text}</strong><small>${esc(p.title)} · ${p.mode==='financial'?'财务数据更新':'全文更新'}</small></span><span class="co-task-end">${kind==='review'?'去审阅':kind==='todo'?'去确认':'继续工作'}${icon('chevron')}</span></button>`;}).join('')||coEmpty(CO.loading?'正在整理任务':'还没有需要推进的工作','从一份历史募集书和新的报告期材料开始。')}
      </div><div class="co-list-foot">每项工作仍属于具体项目；未设置的负责人和截止日期不会被自动推测。</div></section>
      <aside class="co-home-aside"><section class="co-ready"><div class="co-section-title"><div><span class="co-kicker">FROM YOUR COWORK</span><h2>成果已准备好</h2></div>${coSymbol('spark')}</div>${mails.length?mails.slice(0,2).map(m=>`<button class="co-ready-item" data-co="mail-open" data-id="${esc(m.id)}"><span class="co-chip green">${m.label}</span><h3>${esc(m.project.title)}</h3><p>${esc(m.summary)}</p><span class="co-text-action">打开交付 ${icon('arrow')}</span></button>`).join(''):'<p class="co-muted">AI 形成可审阅的结果后，会在这里提示你。</p>'}<button class="co-link" data-co="nav" data-page="inbox">查看全部交付 ${icon('chevron')}</button></section>
      <section class="co-proactive-teaser"><span class="co-chip">下一步能力</span><h3>让 Cowork 提前准备</h3><p>新材料到达后识别影响，按约定时间准备结果，再交给你判断。</p><button class="co-link" data-co="automations">设计一个主动任务 ${icon('arrow')}</button><small>当前可配置方案；后台自动执行待接入。</small></section></aside></div>
    <section class="co-recent"><div class="co-section-title"><h2>继续项目</h2><button class="co-link" data-co="nav" data-page="project">全部项目 ${icon('chevron')}</button></div><div class="co-project-cards">${projects.slice(0,3).map(p=>`<button data-co="project" data-id="${esc(p.id)}"><span>${coSymbol('folder')}<small>${p.mode==='financial'?'财务数据':'全文更新'}</small></span><h3>${esc(p.title)}</h3><p>报告期 ${dateLabel(p.period)}</p><footer><span>${pwStatus(p)}</span>${icon('arrow')}</footer></button>`).join('')}</div></section>
  </div>`;
}
function coDocumentStats(p){
  const sourced=p.changes.filter(c=>c.origin!=='scan'&&c.status!=='rejected'&&c.before!==c.after&&c.sources?.length).length;
  const human=p.changes.filter(c=>c.origin==='human'&&c.status!=='rejected'&&c.before!==c.after&&!c.sources?.length).length;
  const stats=[['sourced',sourced,'处有来源修改',''],['needs_review',p.stats.needs_review,'处人工待办','amber'],['missing_source',p.stats.missing_source,'处缺来源','amber'],['awaiting_agent',p.stats.awaiting_agent,'处待系统处理',''],['layout',p.stats.layout_tasks,'张表结构待处理',''],['accepted',p.stats.accepted,'处已确认','']];
  if(human)stats.splice(1,0,['human',human,'处人工修改','']);
  return `<div class="co-document-stats" aria-label="文档修改统计">${stats.map(([filter,value,label,color])=>`<button data-action="queue" data-filter="${filter}" class="${color}" title="${filter==='missing_source'?'人工待办中缺少可核实来源的部分；建议值未应用':'查看对应位置'}"><b>${value||0}</b><span>${label}</span></button>`).join('')}<button class="co-stat-sources" data-action="materials">${icon('file')}<span>${p.stats.sources||0} 份来源</span></button></div>`;
}
function coProjectPanel(){
  const p=S.p;if(!p)return `<div class="co-page">${coEmpty('选择一个项目开始协作','每个项目保留自己的材料、对话和更新结果。','<button class="co-primary" data-action="new-project">新建项目</button>')}</div>`;
  if(!p.document)return coProjectConversation();
  const outline=(p.document?.blocks||[]).filter(b=>b.type==='heading');
  return `<div class="co-project-layout ${CO.focus?'focused':''}"><aside class="co-project-context"><div class="co-context-head"><span class="co-kicker">当前项目</span><button data-co="search" aria-label="切换项目">${icon('down')}</button></div><h2>${esc(p.title)}</h2><span class="co-chip">${p.mode==='financial'?'只更新财务数据':'全文更新'}</span><div class="co-context-caption">目标报告期<br><strong>${dateLabel(p.period)}</strong></div>
    <div class="co-context-label">成果与材料</div><button class="co-context-item active" data-co="document">${icon('book')}募集说明书<span>工作稿</span></button><button class="co-context-item" data-action="materials">${icon('folder')}项目材料<span>${p.files.length}</span></button><button class="co-context-item" data-pw="knowledge">${icon('list')}采用的更新规则</button><button class="co-context-item" data-pw="memory">${icon('chat')}项目记忆<span>待开放</span></button>
    <div class="co-context-label">章节导航</div><nav class="co-outline" aria-label="募集书章节">${outline.map(h=>`<button data-action="jump" data-id="${esc(h.id)}" class="${h.level>1?'sub':''}">${esc(h.text)}</button>`).join('')||'<p>上传底稿后显示章节</p>'}</nav><button class="co-history" data-action="history">${icon('clock')}处理记录</button></aside>
    <section class="co-document editor"><header class="co-document-header"><div><h2>${icon('book')}募集说明书 <span class="co-chip">${p.mode==='financial'?'仅财务':'全文更新'}</span></h2><span>目标报告期末 · ${dateLabel(p.period)}${p.demo?' · 演示项目':''}</span></div><div class="segmented"><button data-action="view" data-view="revision" class="${S.view==='revision'?'active':''}" aria-pressed="${S.view==='revision'}">${icon('edit')}修订模式</button><button data-action="view" data-view="final" class="${S.view==='final'?'active':''}" aria-pressed="${S.view==='final'}">${icon('eye')}最终模式</button></div></header>
    ${coDocumentStats(p)}
    <div class="co-document-legend"><span class="co-legend-note">黄色【】是人工待办；灰色候选仍由系统处理</span><span><i class="red"></i>原文</span><span><i class="green"></i>已更新</span><span><i class="amber"></i>需确认</span></div><div class="co-document-tools"><button data-co="focus">${icon('eye')}${CO.focus?'展开导航':'专注阅读'}</button><button data-pw="outline">${icon('list')}章节目录</button><button data-pw="knowledge">${icon('book')}更新规则</button><button data-pw="task-details">更新范围与进度</button></div><div class="doc-scroll" data-co-scroll="doc">${renderDocument()}</div></section>
    <aside class="co-cowork ${CO.sideOpen?'mobile-open':''}"><div class="co-cowork-tabs">${[['chat','Cowork','spark'],['source','修改依据','link'],['queue','待办','list']].map(([id,label,symbol])=>`<button data-action="tab" data-tab="${id}" class="${S.tab===id?'active':''}">${icon(symbol)}${label}${id==='queue'&&p.stats.needs_review?`<span class="badge amber">${p.stats.needs_review}</span>`:''}</button>`).join('')}<button class="co-icon-button co-cowork-close" data-co="toggle-cowork" aria-label="关闭协作面板">${icon('close')}</button></div>
    <div class="co-cowork-scroll ${S.tab==='chat'?'co-transcript':''}" data-co-scroll="${S.tab}">${S.tab==='chat'?renderChat(true)+coHomeRequestFailure():S.tab==='source'?renderSource(true):renderQueue()}</div>${S.tab==='chat'?renderComposer():`<div class="co-discuss"><button class="secondary" data-action="tab" data-tab="chat">${icon('chat')}回到对话讨论此处</button></div>`}</aside><button class="co-floating-chat" data-co="toggle-cowork">${icon('chat')}Cowork${S.selected?' · 已选中文档':''}</button></div>`;
}
function coHomeRequestFailure(){
  if(!CO.homeError||CO.homeProject!==S.p?.id)return '';
  return `<div class="co-request-failure" role="alert"><strong>首页这条消息尚未确认发送成功</strong><p>${esc(CO.homeDraft)}</p><small>${esc(CO.homeError)}</small><div><button data-co="retry-home" ${busy()||S.sending||CO.homeSending?'disabled':''}>重试发送</button><button data-co="edit-home-request">返回首页修改</button></div></div>`;
}
function coProjectConversation(){
  const p=S.p;
  return `<section class="co-conversation-page" aria-label="项目 Cowork 对话"><header><div><span class="co-kicker">COWORK</span><h1>从对话开始，把项目向前推进。</h1><p>${esc(p.title)} · 对话和材料保存在当前项目</p></div><button class="secondary" data-action="materials">${icon('clip')}项目材料 · ${p.files.length}</button></header><div class="co-conversation-body co-cowork"><div class="co-cowork-scroll co-transcript" data-co-scroll="chat">${renderChat(true)}${coHomeRequestFailure()}${busy()?`<div class="co-chat-activity" role="status"><i class="spinner"></i>${esc(p.job.step||'Cowork 正在处理你的请求')}<button data-action="cancel">停止</button></div>`:''}</div><div class="co-add-document"><span>添加历史募集书后，即可在这里同时查看文档和对话。</span><button data-action="upload-original">${icon('file')}添加募集书</button></div>${renderComposer()}</div></section>`;
}
function coInbox(){
  const mails=coMails(),filtered=mails.filter(m=>CO.inboxFilter==='all'||(CO.inboxFilter==='unread'?!CO.read[m.id]:!!CO.read[m.id]));
  if(!filtered.some(m=>m.id===CO.selectedMail))CO.selectedMail=filtered[0]?.id||null;
  const selected=filtered.find(m=>m.id===CO.selectedMail);
  return `<div class="co-inbox-page"><div class="co-page-heading"><div><span class="co-kicker">DELIVERED BY COWORK</span><h1>AI 收件箱</h1><p>成果、需要你决定的事项，以及你交给 AI 持续准备的工作。</p></div><button class="secondary" data-co="refresh">${icon('clock')}${CO.loading?'正在刷新':'刷新结果'}</button></div><div class="co-page-tabs"><button data-co="inbox-tab" data-tab="deliveries" class="${CO.inboxTab==='deliveries'?'active':''}">交付与提醒 <span>${coUnread()}</span></button><button data-co="inbox-tab" data-tab="automations" class="${CO.inboxTab==='automations'?'active':''}">主动任务 <span>${CO.plans.length?`${CO.plans.length} 个方案`:'待启用'}</span></button></div>
    ${CO.inboxTab==='automations'?coAutomations():`<div class="co-mail-layout"><section class="co-mail-list"><div class="co-mail-filters">${[['all','全部'],['unread','未读'],['read','已读']].map(([id,label])=>`<button data-co="mail-filter" data-filter="${id}" class="${CO.inboxFilter===id?'active':''}">${label}</button>`).join('')}</div><div class="co-mail-items">${filtered.map(m=>`<button class="co-mail ${m.id===CO.selectedMail?'selected':''} ${CO.read[m.id]?'read':''}" data-co="mail-select" data-id="${esc(m.id)}"><div><span class="co-mail-dot"></span><span>${esc(m.project.title)}</span><time>${smallDate(m.at)}</time></div><h3>${m.title}</h3><p>${esc(m.summary)}</p><span class="co-chip ${m.type==='result'?'green':'amber'}">${m.label}</span></button>`).join('')||coEmpty(CO.loading?'正在读取项目结果':'这里暂时没有消息','有新的交付或需要处理的执行状态时，会汇总到这里。')}</div></section><section class="co-mail-detail" data-co-scroll="mail-detail">${selected?coMailDetail(selected):coEmpty('打开一份交付，继续下一步','先看结果和处理建议，再进入对应项目核对文档与来源。')}</section></div>`}
  </div>`;
}
function coMailDetail(m){
  return `<div class="co-mail-detail-top"><span class="co-chip ${m.type==='result'?'green':'amber'}">${m.label}</span><button class="co-link" data-co="mail-read" data-id="${esc(m.id)}">${CO.read[m.id]?'标为未读':'标为已读'}</button></div><h2>${m.title}</h2><div class="co-mail-sender"><span>${icon('spark')}</span><div><strong>Cowork · ${esc(m.project.title)}</strong><small>${smallDate(m.at)} · ${m.trigger}</small></div></div><p class="co-mail-intro">${esc(m.summary)}</p><p class="co-mail-description">${esc(m.detail)}</p>
    <div class="co-mail-delivery"><span>${icon('file')}</span><div><strong>募集说明书 · 当前工作稿</strong><p>${dateLabel(m.project.period)} · ${m.project.mode==='financial'?'财务数据更新':'全文更新'}</p></div></div><div class="co-mail-next"><h3>你可以接着做</h3><p>${m.type==='result'?'核对修改前后和引用依据，再接受、编辑或退回具体修改。':'回到原项目查看进展与材料，补充要求后继续更新。'}</p><button class="co-primary" data-co="mail-work" data-id="${esc(m.id)}">${m.type==='result'?'打开成果并审阅':'回到项目继续'}${icon('arrow')}</button></div><p class="co-mail-footnote">已读只改变提醒状态。文档审核决定仍在项目中逐处保存。</p>`;
}
const coRecipes=[
  {id:'financial',icon:'file',title:'新财报到了，先准备更新',text:'发现新一期财报后，识别受影响章节，准备有依据的修订和缺口清单。',trigger:'新材料加入后',result:'募集书修订草稿与待确认清单'},
  {id:'risk',icon:'shield',title:'发行人有变化，及时提醒',text:'跟进工商、存续债券与风险事项，保留原文证据和可能影响的披露位置。',trigger:'每天检查',result:'变化摘要与来源证据'},
  {id:'rules',icon:'book',title:'规则更新，找出项目影响',text:'比较适用规则的变化，列出需要项目组判断的章节与理由。',trigger:'每周检查',result:'规则变化及章节影响清单'},
];
function coAutomations(){
  return `<div class="co-automation-page" data-co-scroll="automations"><div class="co-automation-banner"><div><span class="co-kicker">PROACTIVE WORK</span><h2>先约定工作，再接收成果。</h2><p>明确项目、触发条件和交付内容。AI 准备好后进入收件箱，由你审阅。</p></div><span class="co-chip amber">自动执行待接入</span></div><div class="co-flow"><span>约定任务</span>${icon('chevron')}<span>AI 准备草稿</span>${icon('chevron')}<span>收件箱交付</span>${icon('chevron')}<span>项目内审阅</span></div><div class="co-recipe-grid">${coRecipes.map(r=>`<article><span class="co-recipe-icon">${coSymbol(r.icon)}</span><h3>${r.title}</h3><p>${r.text}</p><button class="secondary" data-co="recipe" data-id="${r.id}">配置工作方案 ${icon('arrow')}</button></article>`).join('')}</div>
    <section class="co-plan-section"><div class="co-section-title"><h2>我的主动任务方案</h2><span class="co-muted">方案保存在本浏览器，尚不执行</span></div>${CO.plans.map(p=>`<div class="co-plan-row"><span>${icon('clock')}</span><div><strong>${esc(p.title)}</strong><small>${esc(p.projectTitle)} · ${esc(p.trigger)} · 站内收件箱</small></div><span class="co-chip">方案草稿</span><button class="co-link" data-co="edit-plan" data-id="${esc(p.id)}">查看方案</button></div>`).join('')||'<p class="co-muted">还没有配置方案。可从上方选一个业务场景开始。</p>'}</section><div class="co-notice-preview"><div><h3>体验 AI 主动交付</h3><p>查看“新财报影响清单”的示例通知及后续处理流程。</p></div><button class="secondary" data-co="sample-delivery">预览交付体验 ${icon('arrow')}</button></div></div>`;
}
function coEcosystem(){
  return `<div class="co-page co-ecosystem" data-co-scroll="ecosystem"><div class="co-page-heading"><div><span class="co-kicker">BUILT FOR YOUR PRACTICE</span><h1>为你的工作配置能力</h1><p>业务插件组织工作，专业技能定义方法，数据连接提供依据。</p></div></div><div class="co-page-tabs">${[['plugins','业务插件'],['skills','专业技能 · Skills'],['connections','数据连接 · MCP']].map(([id,label])=>`<button data-co="eco-tab" data-tab="${id}" class="${CO.ecoTab===id?'active':''}">${label}</button>`).join('')}</div>
    ${CO.ecoTab==='plugins'?`<div class="co-featured-plugin"><div class="co-plugin-art">${icon('book')}<span>PROSPECTUS</span></div><div><span class="co-chip green">内置可用</span><h2>募集说明书更新</h2><p>以新报告期材料更新全文财务数字，或扩展到有依据的非财务事实。交付修订稿、净稿及审核记录。</p><div class="co-tags"><span>财务数据</span><span>全文更新</span><span>引用溯源</span><span>Word 原格式导出</span></div><button class="co-primary" data-co="start-project">进入当前项目 ${icon('arrow')}</button></div></div><div class="co-section-title"><h2>后续业务插件</h2><span class="co-muted">可查看规划范围</span></div><div class="co-eco-grid">${[['反馈回复','围绕交易所问题组织回复、依据与审核。'],['债券融资方案','按项目用途起草融资方案与实施安排。'],['发行文件审核','结合规则检查一致性、缺口与风险事项。']].map(([title,desc])=>coCapabilityCard(title,desc,'规划中','book','plugin-detail')).join('')}</div>`:CO.ecoTab==='skills'?`<p class="co-section-description">当前展示产品内置专业能力。自定义 Skill 包的安装、发布与权限管理待接入。</p><div class="co-eco-grid">${coCapabilityCard('逐章财务更新规则','68 条整理规则，17 项来源差异与待确认问题。运行采用专家审阅版。','内置规则','book','rules')}${coCapabilityCard('来源核对与缺口标记','逐处关联原文依据；不能核实的内容保留【】，供项目组处理。','内置能力','link','skill-detail')}${coCapabilityCard('Word 格式保留','沿用历史募集书字体、标题、段落及表格格式，输出修订稿与净稿。','内置能力','file','skill-detail')}${coCapabilityCard('财务分析与行业研究','数字变化原因、行业判断和分析性文字更新。','待扩展','spark','skill-detail')}</div>`:coConnectionsPage()}
  </div>`;
}
function coCapabilityCard(title,desc,status,symbol,action){return `<article class="co-capability"><div><span>${coSymbol(symbol)}</span><span class="co-chip ${status.startsWith('内置')?'green':''}">${status}</span></div><h3>${title}</h3><p>${desc}</p><button class="co-link" data-co="${action}" data-title="${title}">${action==='rules'?'查看专业规则':'查看能力范围'} ${icon('arrow')}</button></article>`;}
function coConnectionsPage(){
  const list=[['Codex CLI','负责接收项目要求、读取材料并执行更新。',S.runtime.ready===true?'当前可用':S.runtime.ready===false?'需要检查':'正在检测','spark','runtime'],['公开网页','在全文更新项目中按项目授权，保存可核对的网页快照。','按项目授权','globe','web'],['预警通','债券发行、存续、兑付及风险信息。','待接入','shield','provider'],['企查查 / 天眼查','工商、股权、人员与变更信息。','待接入','folder','provider'],['Wind（万得）','债券、财务与市场数据，按授权范围使用。','待接入','globe','provider'],['自定义 MCP','连接机构内部知识库、项目资料与业务系统。','待接入','link','provider']];
  return `<p class="co-section-description">连接状态以实际能力为准。外部商业数据需要机构账号与相应权限；当前没有执行这些平台的查询。</p><div class="co-eco-grid">${list.map(([name,desc,status,symbol,action])=>`<article class="co-capability"><div><span>${coSymbol(symbol)}</span><span class="co-chip ${status==='当前可用'?'green':status==='需要检查'?'amber':''}">${status}</span></div><h3>${name}</h3><p>${desc}</p><button class="co-link" data-co="${action}" data-title="${name}">${action==='runtime'?'查看连接状态':action==='web'?'查看项目授权':'查看接入要求'}${icon('arrow')}</button></article>`).join('')}</div>`;
}
function renderCoworkOS(){
  const previous=document.querySelector('.co-shell'),previousKey=previous?.dataset.context;
  if(previousKey){const values=CO.scrolls.get(previousKey)||{};document.querySelectorAll('[data-co-scroll]').forEach(el=>values[el.dataset.coScroll]=el.scrollTop);CO.scrolls.set(previousKey,values);}
  const activeId=document.activeElement?.id,selection=document.activeElement?.selectionStart;
  if(S.p)CO.summaries.set(S.p.id,coSummarize(S.p));
  const key=CO.page==='project'?`project:${S.p?.id}`:CO.page==='conversation'?`conversation:${csKey()}`:CO.page,positions=CO.scrolls.get(key)||{};
  document.getElementById('app').innerHTML=`<div class="co-shell ${CO.focus&&CO.page==='project'?'co-focus':''} ${CO.mobileNav?'co-mobile-open':''}" data-context="${esc(key)}">${coSidebar()}${CO.mobileNav?'<button class="co-nav-scrim" data-co="mobile-menu" aria-label="关闭导航"></button>':''}<main class="co-main">${coTopbar()}${CO.page==='home'?coHome():CO.page==='conversation'?csPage():CO.page==='project'?coProjectPanel():CO.page==='inbox'?coInbox():coEcosystem()}</main></div>`;
  document.querySelectorAll('[data-co-scroll]').forEach(el=>{const pos=positions[el.dataset.coScroll];if(pos!==undefined)el.scrollTop=pos;else if(el.dataset.coScroll==='chat')el.scrollTop=el.scrollHeight;});
  if(activeId==='chat-input'||activeId==='co-home-request'||activeId==='cs-chat-input'){const input=document.getElementById(activeId);input?.focus();input?.setSelectionRange(selection,selection);}
  if(!CO.ready){CO.ready=true;queueMicrotask(()=>coLoadWorkspace(true));}
  if(!CCHAT.booted){CCHAT.booted=true;const id=new URLSearchParams(location.search).get('conversation');if(CO.page==='conversation'&&id)queueMicrotask(()=>csOpen(id));}
}
function coRecipeModal(recipeId,existing){
  const recipe=coRecipes.find(r=>r.id===recipeId)||coRecipes[0];S.modal='co-plan';
  openModal(existing?'主动任务方案':'配置主动任务方案','先约定项目、触发方式和交付物。当前保存为方案草稿。',`<form id="co-plan-form"><div class="modal-body"><input type="hidden" name="recipe" value="${recipe.id}"><input type="hidden" name="planId" value="${esc(existing?.id||'')}"><div class="field"><label for="co-plan-title">工作名称</label><input id="co-plan-title" name="title" required maxlength="100" value="${esc(existing?.title||recipe.title)}" type="text"></div><div class="field"><label for="co-plan-project">关联项目</label><select id="co-plan-project" name="project" required>${S.projects.filter(p=>!p.demo).map(p=>`<option value="${esc(p.id)}" ${p.id===(existing?.projectId||S.p?.id)?'selected':''}>${esc(p.title)}</option>`).join('')}</select></div><div class="field"><label for="co-plan-trigger">何时准备</label><select id="co-plan-trigger" name="trigger">${['新材料加入后','每天检查','每周检查'].map(t=>`<option ${t===(existing?.trigger||recipe.trigger)?'selected':''}>${t}</option>`).join('')}</select></div><div class="inline-row co-plan-schedule" ${((existing?.trigger||recipe.trigger)==='新材料加入后')?'hidden':''}><div class="field"><label for="co-plan-time">检查时间</label><input type="time" id="co-plan-time" name="time" value="${esc(existing?.time||'09:00')}"><div class="hint">北京时间</div></div><div class="field"><label for="co-plan-weekday">每周检查日</label><select id="co-plan-weekday" name="weekday">${['周一','周二','周三','周四','周五','周六','周日'].map(d=>`<option ${d===(existing?.weekday||'周一')?'selected':''}>${d}</option>`).join('')}</select><div class="hint">仅每周检查时采用</div></div></div><div class="field"><label for="co-plan-result">交付内容</label><textarea id="co-plan-result" name="result" required maxlength="2000">${esc(existing?.result||recipe.result)}</textarea></div><div class="co-plan-boundary"><strong>交付到站内收件箱，等待你审阅</strong><p>自动调度与材料事件触发尚未接入；保存方案不会启动 AI、查询外网或发送邮件。正式执行前还需配置检查时间、采用的材料与数据权限。</p></div></div><div class="modal-footer"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="co-primary" type="submit">保存方案草稿</button></div></form>`);
}
function coSearch(){S.modal='co-search';openModal('查找项目','找到项目后，在同一工作区继续文档与对话。',`<div class="modal-body"><div class="field"><label for="co-project-search">项目名称</label><input id="co-project-search" placeholder="输入发行人或项目名称" type="text"></div><div class="co-search-results">${S.projects.map(p=>`<button data-co="project" data-id="${esc(p.id)}" data-project-name="${esc(p.title.toLowerCase())}">${icon('folder')}<div><strong>${esc(p.title)}</strong><small>${dateLabel(p.period)} · ${p.mode==='financial'?'财务数据':'全文更新'}${p.demo?' · 演示项目':''}</small></div>${icon('chevron')}</button>`).join('')}</div><p class="co-search-empty" hidden>没有匹配的项目</p></div>`);}
document.addEventListener('input',event=>{if(event.target.id==='co-project-search'){const query=event.target.value.trim().toLowerCase();let count=0;document.querySelectorAll('[data-project-name]').forEach(el=>{el.hidden=!el.dataset.projectName.includes(query);if(!el.hidden)count++;});document.querySelector('.co-search-empty').hidden=count>0;}});
document.addEventListener('input',event=>{if(event.target.id==='co-home-request'){CO.homeDraft=event.target.value;CO.homeError='';}});
document.addEventListener('change',event=>{if(event.target.id==='co-request-project'){CO.homeProject=event.target.value;render();}});
document.addEventListener('change',event=>{if(event.target.id==='co-plan-trigger'){const schedule=document.querySelector('.co-plan-schedule');if(schedule)schedule.hidden=event.target.value==='新材料加入后';}});
document.addEventListener('submit',async event=>{
  if(event.target.id!=='co-request-form')return;event.preventDefault();event.stopImmediatePropagation();
  const data=new FormData(event.target);
  await coSendHomeRequest(data.get('request'),data.get('project'));
},true);
document.addEventListener('submit',event=>{
  if(event.target.id!=='co-plan-form')return;event.preventDefault();event.stopImmediatePropagation();
  const data=new FormData(event.target),project=S.projects.find(p=>p.id===data.get('project'));if(!project)return;
  const plan={id:data.get('planId')||`plan-${Date.now()}`,recipe:data.get('recipe'),title:String(data.get('title')).trim(),projectId:project.id,projectTitle:project.title,trigger:data.get('trigger'),time:data.get('time'),weekday:data.get('weekday'),result:String(data.get('result')).trim(),status:'draft'};
  if(!plan.title||!plan.result)return;const plans=CO.plans.filter(p=>p.id!==plan.id).concat(plan);if(!coPersist('bond-cowork-plans',plans))return;CO.plans=plans;closeModal();CO.inboxTab='automations';coRoute('inbox');toast('方案草稿已保存；自动执行尚未启用。');
},true);
document.addEventListener('click',async event=>{
  if(!projectWorkspaceActive())return;
  const el=event.target.closest('[data-co]');
  if(!el){const action=event.target.closest('[data-action]');if(action&&['queue','select-change','ask-selection'].includes(action.dataset.action))CO.sideOpen=true;if(event.target.closest('[data-target]'))CO.sideOpen=true;return;}
  event.preventDefault();event.stopImmediatePropagation();
  const action=el.dataset.co;
  try{
    if(action==='nav')coRoute(el.dataset.page);
    else if(action==='conversation')await csOpen(el.dataset.id);
    else if(action==='new-conversation')csNew();
    else if(action==='conversation-history'){await csLoadList();csHistory();}
    else if(action==='cancel-conversation')await csCancel();
    else if(action==='refresh-conversation')await csRefresh();
    else if(action==='retry-home')await coSendHomeRequest(CO.homeDraft,CO.homeProject);
    else if(action==='edit-home-request')coRoute('home');
    else if(action==='project')await coOpenProject(el.dataset.id,el.dataset.filter);
    else if(action==='start-project'){if(S.p)await coOpenProject(S.p.id);else newProject();}
    else if(action==='search')coSearch();
    else if(action==='refresh')await coLoadWorkspace(true);
    else if(action==='document'){S.tab='chat';render();}
    else if(action==='focus'){CO.focus=!CO.focus;render();}
    else if(action==='mobile-menu'){CO.mobileNav=!CO.mobileNav;render();}
    else if(action==='toggle-cowork'){CO.sideOpen=!CO.sideOpen;render();}
    else if(action==='mail-filter'){CO.inboxFilter=el.dataset.filter;CO.selectedMail=null;render();}
    else if(action==='mail-open'||action==='mail-select'){CO.selectedMail=el.dataset.id;CO.inboxTab='deliveries';CO.inboxFilter='all';coRoute('inbox');}
    else if(action==='mail-read'){const updated={...CO.read};if(updated[el.dataset.id])delete updated[el.dataset.id];else updated[el.dataset.id]=true;if(coPersist('bond-cowork-read',updated)){CO.read=updated;render();}}
    else if(action==='mail-work'){const mail=coMails().find(m=>m.id===el.dataset.id);if(mail)await coOpenProject(mail.project.id,mail.filter,mail.type==='result'?mail.target:null);}
    else if(action==='inbox-tab'){CO.inboxTab=el.dataset.tab;render();}
    else if(action==='automations'){CO.inboxTab='automations';coRoute('inbox');}
    else if(action==='recipe')coRecipeModal(el.dataset.id);
    else if(action==='edit-plan'){const plan=CO.plans.find(p=>p.id===el.dataset.id);if(plan)coRecipeModal(plan.recipe,plan);}
    else if(action==='sample-delivery'){
      pwModal('新一期财报影响清单已准备','流程示例 · 不是当前项目的真实分析结果',`<div class="co-sample"><span class="co-chip amber">示例交付</span><h3>AI 已准备了什么</h3><p>识别新旧报告期，整理受影响的正文与表格，并把来源不足的位置保留为【待确认】。</p><h3>需要你决定什么</h3><p>核对采用的材料和期间，再进入项目逐处审阅。AI 的草稿不会自动成为最终披露。</p><div class="co-flow"><span>查看结果</span>${icon('chevron')}<span>核对来源</span>${icon('chevron')}<span>审阅修改</span></div><button class="co-primary" data-co="start-project">进入当前真实项目体验审阅</button></div>`);
    }else if(action==='eco-tab'){CO.ecoTab=el.dataset.tab;render();}
    else if(action==='ecosystem-connections'){CO.ecoTab='connections';coRoute('ecosystem');}
    else if(action==='rules')await pwKnowledge();
    else if(action==='runtime')openWorkspaceInfo();
    else if(action==='web'){if(S.p)pwConnections();else newProject();}
    else if(action==='provider')pwModal(`${el.dataset.title} · 接入要求`,'待接入',`<p>需要机构授权账号、可用的数据接口或 MCP 服务，以及允许访问的项目范围。</p><p>接入后，每次查询需要保留查询时间、来源定位和原文快照。当前可先上传从平台导出的报告作为项目材料。</p><p class="small muted">${S.p?`当前项目：${esc(S.p.title)}`:'尚未选择项目'}</p><button class="secondary" data-action="${S.p?'materials':'new-project'}">${S.p?'添加现有报告':'先创建项目'}</button>`);
    else if(action==='plugin-detail'||action==='skill-detail')pwModal(el.dataset.title,'能力范围',`<p>${action==='plugin-detail'?'此业务模块处于规划阶段。后续会复用项目材料、Cowork 对话、来源定位与审阅机制。':'当前内置能力随募集书更新工作调用。自定义技能配置与独立模块仍待扩展。'}</p><button class="secondary" data-co="start-project">进入募集书工作区</button>`);
    else if(action==='home-filter'){const list=coProjects().filter(p=>el.dataset.kind==='review'?(p.stats.pending||p.stats.needs_review):['failed','interrupted','cancelled'].includes(p.job.status));pwModal(el.dataset.kind==='review'?'待审阅的项目':'需要继续推进的项目','点击项目，回到对应工作。',`<div class="co-search-results">${list.map(p=>`<button data-co="project" data-id="${esc(p.id)}" data-filter="${el.dataset.kind==='review'?(p.stats.pending?'verified':'needs_review'):'awaiting_agent'}">${icon('file')}<div><strong>${esc(p.title)}</strong><small>${pwStatus(p)} · ${p.stats.pending} 处待审核修改 · ${p.stats.needs_review} 处人工待办</small></div>${icon('chevron')}</button>`).join('')||'<p>当前没有此类项目。</p>'}</div>`);}
  }catch(error){toast(error.message,true);}
},true);
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==='k'){event.preventDefault();coSearch();}});
document.addEventListener('keydown',event=>{if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&event.target.id==='co-home-request'&&!event.isComposing){event.preventDefault();document.getElementById('co-request-form')?.requestSubmit();}});
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&CO.page!=='project')coLoadWorkspace();});
setInterval(()=>{if(CO.ready&&!document.hidden&&CO.page!=='project')coLoadWorkspace();},60000);
