/* Project-scoped layout. Parsing, review, sources, chat and export use the existing application. */
const PW = {mode:'collab',cache:new Map(),scrolls:new Map(),loadingProject:false,knowledge:null};
function projectWorkspaceActive(){return document.body.dataset.layout==='project';}
function rememberProjectWorkspace(){
  if(!S.p)return;
  PW.cache.set(S.p.id,{mode:PW.mode,draft:S.draft,selected:S.selected,tab:S.tab,blockLimit:S.blockLimit});
}
function restoreProjectWorkspace(id){
  const cached=PW.cache.get(id);
  PW.mode=cached?.mode || (S.p.document?'collab':'chat');
  if(cached){S.draft=cached.draft;S.selected=cached.selected;S.tab=cached.tab;S.blockLimit=cached.blockLimit;}
  const url=new URL(location.href);url.searchParams.set('project',id);history.replaceState(null,'',url);
  if(typeof CO!=='undefined'&&CO.ready){CO.page='project';url.searchParams.set('screen','project');history.replaceState(null,'',url);}
}
function pwStatus(p){if(chatJob(p)&&p.job.status==='running')return '正在回复';if(chatJob(p)&&p.job.status==='completed')return '已回复';return ({idle:'待开始',queued:'排队中',running:'正在更新',completed:'本轮结束',failed:'运行受阻',cancelled:'已停止',interrupted:'已中断'})[p.job.status] || '待开始';}
function pwChat(){
  const p=S.p;
  const native=p.processing_mode==='original_files';
  const progress=native&&!busy()?'原文件由 Agent 读取，建议在网页逐条审阅；导出仅写入已接受修改。':busy()?p.job.step:p.job.status==='failed'?'本轮执行受阻，已保存的修改保留':p.stats.scanned<p.stats.total?'全文仍有未核对位置，请继续更新':'请审阅修改并处理人工待办';
  return `<section class="pw-chat" aria-label="当前项目的 Cowork 对话">
    <div class="pw-pane-label">${icon('spark')}<strong>Cowork</strong><span>当前项目</span></div>
    ${p.document?`<div class="pw-deliverable"><div class="pw-deliverable-title">${icon('file')}<strong>募集说明书 · 当前工作稿</strong></div><p>${esc(progress)}</p><div class="pw-inline-actions"><button class="secondary" data-action="queue" data-filter="verified">查看 ${p.stats.changes} 处修改 ${icon('chevron')}</button><button class="ghost" data-action="queue" data-filter="needs_review">【】${p.stats.needs_review} 处待办</button></div><details class="pw-progress"><summary>${native?'已返回 '+p.stats.total+' 个审阅位置':'处理进展 · 已核对 '+p.stats.scanned+' / '+p.stats.total+' 处'}</summary><p>${p.stats.awaiting_agent||0} 处待系统匹配；${p.stats.original_todos||0} 处原稿已有【】；${p.stats.layout_tasks||0} 张表需确认列安排。待系统匹配不表示材料缺失。</p>${p.job.error?`<p>${esc(p.job.error)}</p>`:''}<button class="ghost" data-pw="task-details">查看任务详情</button></details></div>`:''}
    <div class="pw-chat-scroll pw-chat-history" data-scroll="chat">${renderChat(true)}</div>${renderComposer()}</section>`;
}
function pwDocument(){
  const p=S.p,review=PW.mode==='review';
  return `<section class="pw-document editor" aria-label="募集书成果"><header class="pw-document-head"><div><strong>${icon('book')} 募集说明书</strong><p>${dateLabel(p.period)} · ${p.mode==='financial'?'只更新财务数据':'全文更新'}</p></div><div class="pw-inline-actions"><button class="secondary" data-pw="${review?'collab':'review'}">${review?'返回协作':'专注审阅'}</button><button class="secondary" data-action="export" ${p.document&&!S.exporting?'':'disabled'}>${icon('download')} 导出</button><button class="icon-btn" data-pw="chat" aria-label="收起成果">${icon('close')}</button></div></header><div class="pw-document-tools"><button class="ghost" data-pw="outline">${icon('list')} 章节</button><button class="ghost pw-verified" data-action="queue" data-filter="verified">有来源修改 ${p.stats.changes}</button><button class="ghost" data-action="queue" data-filter="needs_review"><span class="pw-amber">【】${p.stats.needs_review}</span></button>${p.stats.awaiting_agent?`<button class="ghost" data-action="queue" data-filter="awaiting_agent">待系统核对 ${p.stats.awaiting_agent}</button>`:''}<div class="segmented" aria-label="文档视图"><button data-action="view" data-view="revision" class="${S.view==='revision'?'active':''}" aria-pressed="${S.view==='revision'}">修订模式</button><button data-action="view" data-view="final" class="${S.view==='final'?'active':''}" aria-pressed="${S.view==='final'}">最终模式</button></div></div><div class="pw-legend"><span>绿色为已更新 · 黄色【】需人工处理</span><button data-pw="task-details">查看任务范围</button></div><div class="doc-scroll" data-scroll="doc">${p.document?renderDocument():renderEmpty()}</div></section>`;
}
function pwEvidence(){
  return `<aside class="pw-evidence" aria-label="修改依据与审阅"><div class="pw-evidence-tabs"><button data-action="tab" data-tab="source" class="${S.tab==='source'?'active':''}">${icon('link')}依据</button><button data-action="tab" data-tab="queue" class="${S.tab==='queue'?'active':''}">${icon('list')}待办</button><button data-action="tab" data-tab="chat" class="${S.tab==='chat'?'active':''}">${icon('chat')}对话</button></div><div class="pw-evidence-scroll" data-scroll="${S.tab==='chat'?'chat':S.tab}">${S.tab==='source'?renderSource(true):S.tab==='queue'?renderQueue():renderChat(true)}</div>${S.tab==='chat'?renderComposer():`<div class="pw-evidence-footer"><button class="secondary" data-pw="discuss">${icon('chat')} 在原对话中讨论</button><button class="ghost" data-pw="collab">返回协作</button></div>`}</aside>`;
}
function renderProjectWorkspace(){
  if(typeof renderCoworkOS==='function'){renderCoworkOS();return;}
  const previousProject=document.querySelector('.pw-shell')?.dataset.project;
  if(previousProject){
    const positions=PW.scrolls.get(previousProject)||{};
    document.querySelectorAll('[data-scroll]').forEach(el=>positions[el.dataset.scroll]=el.scrollTop);
    PW.scrolls.set(previousProject,positions);
  }
  const scrolls=PW.scrolls.get(S.p?.id)||{};
  const focused=document.activeElement?.id==='chat-input',selection=focused?document.activeElement.selectionStart:null;
  const p=S.p;
  if(!p){document.getElementById('app').innerHTML=`<div class="boot"><span class="brandmark">B</span><h2>开始一个募集书项目</h2><p>材料、对话与更新结果放在同一项目中。</p><button class="primary" data-action="new-project">新建项目</button></div>`;return;}
  const review=PW.mode==='review',doc=PW.mode!=='chat';
  document.getElementById('app').innerHTML=`<div data-project="${esc(p.id)}" class="pw-shell ${review?'pw-review':''} ${!doc?'pw-conversation-only':''}"><aside class="pw-sidebar"><div class="brand"><span class="brandmark">B</span><div><div class="brand-name">募集书 Cowork</div><div class="brand-sub">项目工作区</div></div></div><label class="pw-project-label" for="pw-project-selector">当前项目</label><div class="pw-project-picker"><select id="pw-project-selector" aria-label="切换当前项目" ${PW.loadingProject?'disabled':''}>${S.projects.map(pr=>`<option value="${esc(pr.id)}" ${pr.id===p.id?'selected':''}>${esc(pr.title)}</option>`).join('')}</select><button class="icon-btn" data-action="new-project" aria-label="新建项目">${icon('plus')}</button></div><button class="primary pw-start" data-pw="prepare">${icon('edit')} 更新募集书</button><button class="ghost pw-start" data-pw="chat">${icon('chat')} 继续对话</button><div class="pw-side-label">本项目的工作</div><button class="pw-current-work" data-pw="open-document"><span>${icon('file')} 募集书更新</span><small>${dateLabel(p.period)} · ${p.mode==='financial'?'财务':'全文'}</small><span class="pw-work-status"><i class="dot ${p.job.status==='failed'?'amber':''}"></i>${pwStatus(p)}</span></button><button class="pw-history" data-action="history">${icon('clock')} 查看处理记录</button><div class="pw-resources"><div class="pw-side-label">项目上下文</div><button data-action="materials">${icon('folder')} 项目材料 <small>${p.files.length}</small></button><button data-pw="memory">${icon('chat')} 项目记忆 <small>待开放</small></button><button data-pw="knowledge">${icon('book')} 更新规则</button></div><button class="pw-settings" data-pw="settings">${icon('settings')} 设置 <span>${S.storage.shared?'共享':'本机'}</span></button></aside><main class="pw-main"><header class="pw-header"><div class="pw-heading"><div class="pw-breadcrumb">${esc(p.title)} ${p.demo?'<span class="badge amber">演示项目</span>':''}<span class="badge">新布局预览</span></div><h1>募集书更新 <span>${pwStatus(p)}</span></h1></div><div class="pw-header-actions"><button class="secondary pw-mobile-project" data-pw="projects">${icon('folder')}项目</button><button class="secondary pw-mobile-chat" data-pw="chat">${icon('chat')}对话</button><button id="global-upload-status" class="upload-global" data-action="materials" >${activeUploads().length} 份材料处理中</button><button class="ghost" data-pw="task-details">任务详情</button><button class="secondary" data-pw="open-document">${icon('file')}当前成果</button>${busy()?`<button class="secondary" data-action="cancel">${icon('stop')}停止更新</button>`:''}</div></header><div class="pw-body ${review?'is-review':''}">${review?pwDocument()+pwEvidence():pwChat()+(doc?pwDocument():'')}</div><footer class="pw-footer"><span>${icon('circleCheck')} 项目材料与已保存修改保留 · 所有工作均在当前项目内</span><button data-pw="connections">${icon('globe')} 查询外部数据</button></footer></main></div>`;
  document.querySelectorAll('[data-scroll]').forEach(el=>{if(scrolls[el.dataset.scroll]!==undefined)el.scrollTop=scrolls[el.dataset.scroll];else if(el.dataset.scroll==='chat')el.scrollTop=el.scrollHeight;});
  const uploadsButton=document.getElementById('global-upload-status');
  if(uploadsButton)uploadsButton.style.display=activeUploads().length?'inline-flex':'none';
  if(focused){const input=document.getElementById('chat-input');input?.focus();input?.setSelectionRange(selection,selection);}
}
function pwModal(title,subtitle,body,wide=false){S.modal='workspace';openModal(title,subtitle,`<div class="modal-body pw-modal-body">${body}</div>`,`<button class="secondary" data-action="close-modal">返回当前工作</button>`,wide);}
function pwTaskDetails(){
  const p=S.p,sourceFiles=p.files.filter(f=>f.id!==p.original_id);
  pwModal('当前更新任务','本项目内的更新范围、进度和材料。',`<dl class="pw-details"><dt>项目</dt><dd>${esc(p.title)}</dd><dt>目标报告期</dt><dd>${dateLabel(p.period)}</dd><dt>更新模式</dt><dd>${p.mode==='financial'?'只更新财务数据':'全文更新'}</dd><dt>执行状态</dt><dd>${pwStatus(p)}</dd><dt>有来源修改</dt><dd>${p.stats.changes} 处</dd><dt>人工待办</dt><dd>${p.stats.needs_review} 处</dd><dt>待系统核对</dt><dd>${p.stats.awaiting_agent||0} 处</dd><dt>来源材料</dt><dd>${sourceFiles.length} 份</dd></dl><p class="small muted">当前成果保留全部未解决的【】。本轮结束不代表已经审核通过。</p><div class="pw-inline-actions"><button class="secondary" data-action="materials">查看材料</button><button class="secondary" data-pw="knowledge">查看更新规则</button><button class="secondary" data-action="history">处理记录</button></div>`);
}
async function pwKnowledge(){
  pwModal('更新规则','正在读取当前产品使用的知识…','<p class="muted">正在加载</p>');
  const loadingDialog=document.querySelector('.modal');
  try{
    const data=await api('/api/knowledge');PW.knowledge=data;
    if(document.querySelector('.modal')!==loadingDialog)return;
    pwModal('本项目采用的更新规则','当前运行读取财务数据更新专家审阅版；全文知识的完整规则化仍待完善。',`<div class="pw-knowledge-intro"><strong>${esc(data.title)}</strong><p>${esc(data.version)}</p><p>实缴资本采用工商来源；报表的实收资本／股本单独核对。</p><p class="small muted">原始知识：${data.source_names.map(esc).join('、')}。共 ${data.rules.length} 条已整理规则，${data.conflict_count} 项来源差异及待确认事项；整理完成不代表专家全部确认。</p></div><details class="pw-rule"><summary>查看运行采用的专家审阅版全文</summary><pre>${esc(data.expert_text)}</pre></details>${data.rules.map(r=>`<details class="pw-rule"><summary><span>${esc(r.id)}</span> ${esc(r.title)}<small>${esc(r.chapter)}</small></summary><pre>${esc(r.body_markdown)}</pre></details>`).join('')}`,true);
  }catch(error){if(document.querySelector('.modal')===loadingDialog)pwModal('更新规则','读取未完成',`<p>${esc(error.message)}</p>`);}
}
function pwConnections(){
  const p=S.p;
  pwModal('查询外部数据',`当前项目：${p.title}。查询结果归属此项目，账号与权限在连接设置中管理。`,`<div class="pw-connection-row"><div><strong>公开网页</strong><p>${p.mode==='full'&&p.web_enabled?'本项目已允许公开网页查询，可添加网页保存原文快照。':'当前项目未启用公开网页查询。'}</p></div><span class="badge ${p.mode==='full'&&p.web_enabled?'green':''}">${p.mode==='full'&&p.web_enabled?'已允许':'未启用'}</span></div>${[['预警通','债券发行、兑付、存续及风险线索'],['企查查 / 天眼查','工商信息、股权、人员及变更'],['Wind（万得）','债券、行情估值及获授权的数据集']].map(([name,desc])=>`<div class="pw-connection-row"><div><strong>${name}</strong><p>${desc}</p></div><span class="badge amber">待接入</span></div>`).join('')}<p class="small muted">专业平台尚未接入，当前不会执行这些平台的查询。可以上传已有的报告作为来源材料。</p><button class="secondary" data-action="materials">${icon('upload')} 添加项目资料</button>`);
}
document.addEventListener('change',async event=>{
  if(!projectWorkspaceActive()||event.target.id!=='pw-project-selector')return;
  if(PW.loadingProject)return;
  PW.loadingProject=true;event.target.disabled=true;
  try{await selectProject(event.target.value);}catch(error){toast(error.message,true);}finally{PW.loadingProject=false;render();}
});
document.addEventListener('click',async event=>{
  if(!projectWorkspaceActive())return;
  const existing=event.target.closest('[data-action]');
  if(existing&&['queue','select-change','jump'].includes(existing.dataset.action)){PW.mode='review';if(existing.dataset.action==='jump'&&S.modal)closeModal();}
  const el=event.target.closest('[data-pw]');if(!el)return;
  event.preventDefault();event.stopImmediatePropagation();
  try{
    const action=el.dataset.pw;
    if(['collab','review','chat','open-document','discuss'].includes(action)){
      closeModal();PW.mode=action==='open-document'?(S.p.document?'collab':'chat'):action==='discuss'?'review':action;
      if(action==='review'&&S.tab==='chat')S.tab='source';if(action==='discuss')S.tab='chat';if(action==='chat')S.tab='chat';render();
      if(action==='chat'||action==='discuss')document.getElementById('chat-input')?.focus();
    }else if(action==='prepare'){
      if(!S.p.original_id){uploadOriginal();return;}
      pwModal('更新当前项目的募集书','确认范围后开始，已有已确认及已拒绝决定继续保留。',`<dl class="pw-details"><dt>目标报告期</dt><dd>${dateLabel(S.p.period)}</dd><dt>更新模式</dt><dd>${S.p.mode==='financial'?'只更新财务数据':'全文更新'}</dd><dt>项目材料</dt><dd>${S.p.files.length} 份</dd></dl><div class="pw-inline-actions"><button class="secondary" data-action="materials">查看材料</button><button class="primary" data-pw="start-run" ${busy()?'disabled':''}>${busy()?'任务正在执行':'开始更新'}</button></div>`);
    }else if(action==='start-run'){closeModal();await post(`${base()}/run`);PW.mode='collab';S.tab='chat';await refresh();toast('已提交当前项目的更新任务。');}
    else if(action==='outline'){const headings=S.p.document?.blocks.filter(b=>b.type==='heading')||[];pwModal('章节目录','点击定位当前成果中的章节。',`<nav class="pw-outline">${headings.map(h=>`<button data-action="jump" data-id="${esc(h.id)}" class="${h.level>1?'sub':''}">${esc(h.text)}</button>`).join('')||'<p>上传募集书后显示目录。</p>'}</nav>`);}
    else if(action==='task-details')pwTaskDetails();
    else if(action==='connections')pwConnections();
    else if(action==='knowledge')await pwKnowledge();
    else if(action==='memory')pwModal('项目记忆','当前项目的已确认信息与未决问题。','<div class="pw-coming"><span class="badge amber">保存功能待开放</span><h3>先在原对话中补充项目背景</h3><p>项目记忆的提取、确认和版本管理尚未开放。已有聊天记录继续保留，不会自动变成已确认事实。</p><button class="secondary" data-pw="chat">继续项目对话</button></div>');
    else if(action==='settings')pwModal('设置','配置工具与连接，不汇总跨项目任务。',`<div class="pw-settings-grid"><button data-pw="connections">${icon('globe')}<strong>数据连接</strong><span>公开网页与专业数据平台</span></button><button data-pw="knowledge">${icon('book')}<strong>专业知识</strong><span>查看当前采用的专家规则</span></button><button data-action="workspace-info">${icon('shield')}<strong>工作空间</strong><span>存储、共享范围与 Agent 状态</span></button></div><p class="small muted">这是使用真实项目的新布局预览。任务、来源、人工审核和 Word 导出复用现有功能。</p><a class="small" href="/?project=${encodeURIComponent(S.p.id)}">打开原布局</a>`);
    else if(action==='projects')pwModal('切换项目','切换后只显示所选项目的工作和材料。',`<div class="pw-project-options">${S.projects.map(p=>`<button data-pw="pick-project" data-id="${esc(p.id)}">${esc(p.title)}<small>${dateLabel(p.period)} · ${p.mode==='financial'?'财务':'全文'}</small></button>`).join('')}<button data-action="new-project">＋ 新建项目</button></div>`);
    else if(action==='pick-project'){if(PW.loadingProject)return;PW.loadingProject=true;closeModal();try{await selectProject(el.dataset.id);}finally{PW.loadingProject=false;}}
  }catch(error){toast(error.message,true);}
},true);
