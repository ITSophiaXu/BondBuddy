const paths = {
  plus:'M12 5v14M5 12h14', file:'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8ZM14 2v6h6M8 13h8M8 17h5',
  folder:'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  check:'m5 12 4 4L19 6', circleCheck:'M22 11v1a10 10 0 1 1-5.9-9.1M22 4 12 14.01l-3-3',
  chevron:'m9 5 7 7-7 7', down:'m6 9 6 6 6-6', arrow:'M7 17 17 7M7 7h10v10', send:'M12 19V5m-6 6 6-6 6 6',
  spark:'m12 3 2.7 6.3L21 12l-6.3 2.7L12 21l-2.7-6.3L3 12l6.3-2.7ZM20 2v4M18 4h4',
  chat:'M21 11.5a8.4 8.4 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.4 8.4 0 0 1-3.8-.9L3 21l1.9-5.7a8.4 8.4 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.4 8.4 0 0 1 3.8-.9h.5a8.5 8.5 0 0 1 8 8Z',
  list:'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01', clip:'m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l10-10a4 4 0 0 1 5.7 5.7L9.3 18.1a2 2 0 0 1-2.8-2.8l9.2-9.2',
  edit:'m16 3 5 5M3 21l5-1 13-13a3.54 3.54 0 0 0-5-5L3 15Z', close:'m6 6 12 12M6 18 18 6',
  download:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3', upload:'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 8l5-5 5 5M12 3v12',
  clock:'M12 8v4l3 3M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0', globe:'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0M3 12h18M12 3a19 19 0 0 1 0 18 19 19 0 0 1 0-18',
  info:'M12 16v-4M12 8h.01M22 12A10 10 0 1 1 2 12a10 10 0 0 1 20 0', stop:'M6 6h12v12H6Z',
  eye:'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
  shield:'M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11m-4-11 3 3 5-5',
  link:'M10 13a5 5 0 0 0 7 .3l3-3a5 5 0 0 0-7-7l-1.7 1.7M14 11a5 5 0 0 0-7-.3l-3 3a5 5 0 0 0 7 7l1.7-1.7',
  settings:'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2',
  book:'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${paths[name] || paths.file}"/></svg>`;
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const bracket = value => esc(value).replace(/【[^】]*】/g, '<span class="uncertain">$&</span>');
const dateLabel = date => { const [y,m,d] = date.split('-'); return `${y}年${Number(m)}月${Number(d)}日`; };
const smallDate = value => new Date(value).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const formatBytes = value => {
  const bytes=Number(value)||0;if(bytes<1024)return `${bytes} B`;
  const units=['KB','MB','GB','TB'];let size=bytes/1024,index=0;
  while(size>=1024&&index<units.length-1){size/=1024;index++;}
  return `${size>=10?size.toFixed(0):size.toFixed(1)} ${units[index]}`;
};
const categoryNames = {financial:'财务报表', notes:'报表附注', audit:'审计报告', credit:'征信报告', registry:'工商材料', rating:'评级报告', other:'其他材料', web:'公开网页', prospectus:'募集书底稿'};
const S = {p:null,projects:[],token:'',runtime:{},storage:{},view:localStorage.getItem('bond-view') || 'revision',tab:'chat',selected:null,draft:'',queue:'needs_review',mobile:false,modal:null,uploading:false,uploads:[],blockLimit:80};
let events, refreshing = false, refreshPending = false, editRevision = null;
document.addEventListener('error', event=>{
  if(event.target.matches?.('img.pdf-preview')){
    const notice=document.createElement('div');notice.className='status-card error';notice.setAttribute('role','alert');
    notice.textContent='暂时无法打开 PDF 原页，请确认本机可读取原文件，并从本机终端启动工作台后重试。已提取文字不等于完成了原页核验。';
    event.target.replaceWith(notice);
  }
},true);

let accessRefresh = null;
async function refreshAccess(){
  if(!accessRefresh)accessRefresh=fetch('/api/health',{cache:'no-store'}).then(async response=>{
    const data=await response.json();
    if(!response.ok)throw new Error(data.error || '访问会话刷新失败，请重新加载页面。');
    applyHealth(data);
    return data;
  }).finally(()=>accessRefresh=null);
  return accessRefresh;
}
async function api(path, options={}, retried=false) {
  const response = await fetch(path, {...options, headers:{...(options.body && typeof options.body === 'string' ? {'Content-Type':'application/json'} : {}), 'X-Bond-Token':S.token, ...options.headers}});
  let data;
  try { data=await response.json(); } catch { throw new Error('服务没有返回有效结果，请检查工作台是否仍在运行。'); }
  if(response.status===403&&!retried&&path!=='/api/health'&&String(data.error || '').includes('访问校验失败')){
    await refreshAccess();
    return api(path,options,true);
  }
  if(!response.ok) throw new Error(data.error || '操作未完成，请重试。');
  return data;
}
const post = (path, data={}) => api(path, {method:'POST',body:JSON.stringify(data)});
const base = () => `/api/projects/${S.p.id}`;
const busy = () => ['queued','running'].includes(S.p?.job.status);
const getChange = id => S.changeIndex?.get(id);
const awaitingAgent = c => c?.review_stage === 'awaiting_agent';
const missingSource = c => c?.review_stage === 'missing_source';
const selectedTarget = () => S.targetIndex?.get(S.selected);
const activeUploads = () => S.uploads.filter(item=>['queued','uploading','processing'].includes(item.status));
const applyHealth = health => {S.token=health.csrf || S.token;S.runtime=health.runtime || S.runtime;S.storage=health.storage || S.storage;};
function toast(text, error=false) {
  const el=document.createElement('div');el.className=`toast${error?' error':''}`;el.textContent=text;
  document.getElementById('toasts').append(el);setTimeout(()=>el.remove(),6000);
}

async function loadProjects(){ S.projects=await api('/api/projects'); }
async function selectProject(id) {
  events?.close(); S.selected=null;S.tab='chat';S.draft='';S.mobile=false;S.blockLimit=80;
  S.p=await api(`/api/projects/${id}`);localStorage.setItem('bond-project',id);render();
  events=new EventSource(`/api/projects/${id}/events`);
  events.onmessage=async event=>{
    const data=JSON.parse(event.data);
    if(data.updated_at===S.p?.updated_at || S.p?.id!==id) return;
    refreshPending=true;
    if(refreshing)return;
    refreshing=true;
    try {do{refreshPending=false;await refresh();}while(refreshPending && S.p?.id===id);} catch {} finally {refreshing=false;}
  };
  events.onerror=()=>{};
}
async function refresh(){ if(!S.p)return; const id=S.p.id;const [data,health]=await Promise.all([api(`/api/projects/${id}`),api('/api/health')]);if(S.p?.id===id){S.p=data;applyHealth(health);render();} }

function render() {
  const scrolls={}; document.querySelectorAll('[data-scroll]').forEach(el=>scrolls[el.dataset.scroll]=el.scrollTop);
  const composerFocused=document.activeElement?.id==='chat-input';
  const selection=composerFocused ? document.activeElement.selectionStart : null;
  const p=S.p;
  S.changeIndex=new Map((p?.changes || []).map(c=>[c.target_id,c]));
  S.targetIndex=new Map((p?.targets || []).map(t=>[t.id,t]));
  if(!p){document.getElementById('app').innerHTML='<div class="boot"><span class="brandmark">B</span><p>新建你的第一个募集书更新项目</p><button class="primary" data-action="new-project">新建项目</button></div>';return;}
  const headings=p.document?.blocks.filter(b=>b.type==='heading') || [];
  document.getElementById('app').innerHTML=`<div class="app-shell">
    <aside class="sidebar">
      <div class="brand"><span class="brandmark">B</span><div><div class="brand-name">募集书 Cowork</div><div class="brand-sub">让每一处更新都有依据</div></div></div>
      <button class="secondary new-project" data-action="new-project" title="新建项目">${icon('plus')}<span>新建更新任务</span></button>
      <div class="side-label">${S.storage.shared?'共享工作空间':'我的工作空间'} <span class="eyebrow">${S.storage.shared?'AZURE':'LOCAL'}</span></div>
      <nav class="project-list" aria-label="项目列表">${S.projects.map(pr=>`<button class="project-item ${pr.id===p.id?'active':''}" data-action="project" data-id="${pr.id}" title="${esc(pr.title)}">${icon('folder')}<span class="project-name"><span>${esc(pr.title.split(' · ')[0])}</span><small>${esc(pr.period)} · ${pr.mode==='financial'?'财务':'全文'}</small></span>${pr.demo?'<span class="badge">示例</span>':''}</button>`).join('')}</nav>
      <div class="side-tools">
        <button class="side-tool" data-action="materials" title="项目材料">${icon('file')}<span>项目材料</span><span class="side-count">${p.files.length}</span></button>
        <button class="side-tool" data-action="queue" data-filter="needs_review" title="待确认清单">${icon('list')}<span>待确认清单</span><span class="side-count">${p.stats.needs_review}</span></button>
        <button class="side-tool" data-action="history" title="操作记录">${icon('clock')}<span>操作记录</span></button>
      </div>
      <div class="side-label">文档目录 <span>${headings.length}</span></div>
      <nav class="outline" aria-label="文档目录" data-scroll="outline">${headings.map((h,i)=>`<a href="#doc-${esc(h.id)}" class="${i===0?'current':''} ${h.level>1?'sub':''}" data-action="jump" data-id="${esc(h.id)}">${esc(h.text)}</a>`).join('') || '<span class="muted small">上传募集书后显示目录</span>'}</nav>
      <button class="sidebar-bottom workspace-card" data-action="workspace-info" title="查看工作空间与存储"><span class="workspace-avatar">${S.storage.shared?'云':'本地'}</span><div class="workspace-info">${esc(S.storage.label || '项目工作空间')}<div class="small muted"><i class="dot ${S.runtime.ready?'':'amber'}"></i>${S.runtime.ready?(S.runtime.execution_verified?'Agent 已就绪':'CLI 已登录'):(S.runtime.authenticated?'执行权限不足':'Agent 待连接')} · ${formatBytes(S.storage.used_bytes || 0)}</div></div>${icon('chevron')}</button>
    </aside>
    <main class="main">
      <header class="topbar"><div style="min-width:0"><div class="breadcrumbs"><span>工作空间</span><span>/</span><span>${p.mode==='financial'?'财务数据更新':'全文更新'}</span></div><div class="project-title"><span>${esc(p.title)}</span>${p.demo?'<span class="badge">演示项目</span>':`<span class="badge ${p.job.status==='failed'?'amber':'green'}">${({failed:'运行受阻',idle:'待开始',running:'更新中',queued:'准备中',completed:'待审阅',cancelled:'已停止',interrupted:'已中断'})[p.job.status] || '待开始'}</span>`}</div></div>
        <div class="top-actions"><button id="global-upload-status" class="upload-global" data-action="materials" style="${activeUploads().length?'':'display:none'}">${icon('upload')}<span>${activeUploads().length?`${activeUploads().length} 份材料处理中`:''}</span></button><span class="saved">${icon('circleCheck')}已自动保存</span><button class="secondary" data-action="export" ${p.document?'':'disabled'}>${icon('download')}<span>导出</span></button><button class="primary" data-action="${busy()?'cancel':'run'}" ${!p.document?'disabled':''}>${icon(busy()?'stop':'spark')}<span>${busy()?'停止任务':'开始更新'}</span></button><button class="icon-btn mobile-tools" data-action="toggle-panel" title="打开协作面板">${icon('chat')}</button><button class="icon-btn mobile-tools" data-action="new-project" title="新建项目">${icon('plus')}</button></div>
      </header>
      <div class="work-grid">
        <section class="editor" aria-label="募集书编辑区">
          <div class="review-toolbar"><div class="toolbar-top"><div><div class="document-label">${icon('book')}募集说明书 <span class="badge green">${p.mode==='financial'?'仅财务':'全文'}</span></div><div class="document-meta">目标报告期末 · ${dateLabel(p.period)}</div></div><div class="segmented" aria-label="文档视图"><button data-action="view" data-view="revision" class="${S.view==='revision'?'active':''}" aria-pressed="${S.view==='revision'}">${icon('edit')}修订模式</button><button data-action="view" data-view="final" class="${S.view==='final'?'active':''}" aria-pressed="${S.view==='final'}">${icon('eye')}最终模式</button></div></div>
          <div class="stats"><button class="stat" data-action="queue" data-filter="verified"><b>${p.stats.changes}</b>处有来源修改</button><button class="stat warning" data-action="queue" data-filter="needs_review"><b>${p.stats.needs_review}</b>处人工待办</button>${p.stats.missing_source?`<button class="stat warning" data-action="queue" data-filter="needs_review" title="Agent 建议因没有有效引文而未写入文档"><b>${p.stats.missing_source}</b>处缺来源</button>`:''}${p.stats.awaiting_agent?`<button class="stat" data-action="queue" data-filter="awaiting_agent"><b>${p.stats.awaiting_agent}</b>处待 Agent 处理</button>`:''}${p.stats.layout_tasks?`<button class="stat" data-action="queue" data-filter="layout" title="Word 表格保持原列宽和结构，新增报告期列需单独处理"><b>${p.stats.layout_tasks}</b>张表结构待处理</button>`:''}<button class="stat" data-action="queue" data-filter="accepted"><b>${p.stats.accepted}</b>处已确认</button><button class="stat" data-action="materials">${icon('file')}${p.stats.sources} 份来源</button></div></div>
          <div class="legend-bar"><span>黄色 <b>【】</b> 是人工待办；灰色候选仍由 Agent 处理，不需要你逐项填写</span><div class="legend">${S.view==='revision'?'<span><i class="removed"></i>原文</span>':''}<span><i class="new"></i>已更新</span><span><i class="needs"></i>需确认</span></div></div>
          <div class="doc-scroll" data-scroll="doc">${p.demo?`<div class="demo-banner">${icon('info')}这是可操作的演示，所列公司与数据均为示例。<button data-action="new-project">创建真实项目 ${icon('chevron')}</button></div>`:''}${p.document?renderDocument():renderEmpty()}</div>
        </section>
        <aside class="right-panel ${S.mobile?'open':''}" aria-label="协作与来源面板"><div class="panel-tabs"><button data-action="tab" data-tab="chat" class="${S.tab==='chat'?'active':''}">${icon('spark')}Agent</button><button data-action="tab" data-tab="source" class="${S.tab==='source'?'active':''}">${icon('link')}修改依据</button><button data-action="tab" data-tab="queue" class="${S.tab==='queue'?'active':''}">${icon('list')}待办${p.stats.needs_review?` <span class="badge amber">${p.stats.needs_review}</span>`:''}</button><button class="icon-btn mobile-tools" data-action="toggle-panel" title="关闭面板">${icon('close')}</button></div>
        <div class="panel-body" data-scroll="panel">${S.tab==='chat'?renderChat():S.tab==='source'?renderSource():renderQueue()}</div>${renderComposer()}</aside>
      </div>
    </main>
  </div>`;
  document.querySelectorAll('[data-scroll]').forEach(el=>{if(scrolls[el.dataset.scroll]!==undefined)el.scrollTop=scrolls[el.dataset.scroll];});
  if(composerFocused){const t=document.getElementById('chat-input');t?.focus();t?.setSelectionRange(selection,selection);}
}

function renderedText(t) {
  const c=getChange(t.id);
  if(!c || c.status==='rejected') return bracket(t.text);
  if(awaitingAgent(c)) return `<span class="awaiting-agent-text" title="初步扫描标记，等待 Agent 核对">${bracket(c.after)}</span>`;
  let html;
  if(S.view==='final') html=bracket(c.after);
  else html=c.diff.map(d=>d.type==='equal'?bracket(d.old):`${d.old?`<del class="change-del">${bracket(d.old)}</del>`:''}${d.new?`<ins class="change-add">${bracket(d.new)}</ins>`:''}`).join('');
  return html+(c.status==='accepted'?`<span class="accepted-dot" title="已由用户确认">${icon('check')}</span>`:'');
}
function renderDocument(){
  const p=S.p;
  const warnings=p.document.warnings || [];
  const notStarted=p.job.status==='failed' && !p.stats.changes && !p.stats.scanned;
  const tasks=p.document.layout_tasks || [];
  return `${p.document.extension==='.docx'?`<div class="word-format-notice">${icon('file')}普通预览 <span>便于查看修改与来源。导出 Word 沿用历史募集书的字体、标题、段落和表格格式。</span></div>`:''}
    ${tasks.length?`<details class="word-layout-tasks"><summary>${tasks.length} 张表需确认报告期列安排</summary>${tasks.map(t=>`<button data-action="select-change" data-id="${esc(t.target_id)}">${esc(t.text)}</button>`).join('')}<p>导出保持原表列数和列宽，这些【】事项保留为 Word 批注。</p></details>`:''}`+renderPlainDocument(notStarted,warnings);
}
function renderPlainDocument(notStarted=false,warnings=[]){
  const p=S.p;
  const blocks=p.document.blocks.slice(0,S.blockLimit);
  const remaining=Math.max(0,p.document.blocks.length-blocks.length);
  return `${notStarted?`<div class="document-warning" role="status">${icon('info')}<span><strong>自动更新未能启动 · 实际修改 0 处</strong><br>当前为初步扫描标记，尚未完成来源匹配和数据替换。待 Agent 处理的事项不应交给你逐项填写。</span><button class="secondary" data-action="runtime">检查连接</button></div>`:''}${warnings.length?`<button class="document-warning" data-action="materials">${icon('info')}<span>${esc(warnings[0])}${warnings.length>1?`（共 ${warnings.length} 项文件提示）`:''}</span>${icon('chevron')}</button>`:''}<article class="paper"><div class="paper-topline"><span>募集说明书 · 审阅工作稿</span><span>${p.mode==='financial'?'FINANCIAL UPDATE':'FULL DOCUMENT UPDATE'}</span></div>${blocks.map((b,i)=>{
    if(b.type==='table') return `<div class="table-wrap"><table class="doc-table" aria-label="募集书财务表格">${b.rows.map((row,ri)=>`<tr>${row.filter(cell=>!cell.merged).map(cell=>{
      const c=getChange(cell.id),active=c&&c.status!=='rejected'; const tag=ri===0?'th':'td';
      return `<${tag} ${ri===0?'scope="col"':''} rowspan="${cell.rowspan||1}" colspan="${cell.colspan||1}" tabindex="0" role="button" title="查看本处修改与来源" id="doc-${esc(cell.id)}" data-target="${esc(cell.id)}" class="${active?(awaitingAgent(c)?'cell-awaiting':c.needs_review?'cell-review':'cell-changed'):''} ${cell.id===S.selected?'cell-selected':''}">${renderedText(cell)||'&nbsp;'}</${tag}>`;
    }).join('')}</tr>`).join('')}</table></div>`;
    const c=getChange(b.id), active=c&&c.status!=='rejected';
    const cls=`${b.type==='heading'?(i===0?'doc-title':'doc-heading level'+b.level):'doc-paragraph'} ${active&&!awaitingAgent(c)?'has-change':''} ${active&&c.needs_review&&!awaitingAgent(c)?'needs-review':''} ${S.selected===b.id?'is-selected':''}`;
    const tag=b.type==='heading'?(i===0?'h1':'h2'):'p';
    return `<${tag} class="${cls}" id="doc-${esc(b.id)}" data-target="${esc(b.id)}" tabindex="0" role="button" title="点击查看依据或修改本处">${renderedText(b)}</${tag}>`;
  }).join('')}${remaining?`<button class="load-more-document" data-action="load-more">继续加载后续内容（剩余 ${remaining} 个区块）</button>`:''}<div class="paper-footnote">${S.view==='revision'?'修订模式保留原文和更新内容；点击正文或表格可查看依据。':'最终模式隐藏删改痕迹，保留全部未解决的【】。最终模式不代表已经审核通过。'}<br>原始底稿保持不变 · 所有人工操作保留审核记录</div></article>`;
}
function renderEmpty(){return `<div class="upload-empty"><span class="pill">${icon('spark')}开始新的协作</span><h2>把募集书和材料放到这里</h2><p>上传上一版募集说明书，Agent 会核对正文和表格。<br>有依据的更新给出来源，缺少资料的地方用【】留给你。</p><button class="upload-box" data-action="upload-original"><span class="file-icon">${icon('upload')}</span><div><strong>上传待更新的募集说明书</strong><p>推荐 DOCX，也支持 PDF、TXT、Markdown</p></div></button><button class="upload-box" data-action="materials"><span class="file-icon">${icon('folder')}</span><div><strong>添加${S.p.mode==='financial'?'财务报表、附注或审计报告':'报告、征信及其他来源材料'}</strong><p>材料不足也可以开始，缺口会逐项标记</p></div></button></div>`;}
function renderChat(){
  const p=S.p;
  return `<div class="agent-welcome"><span class="agent-avatar">${icon('spark')}</span><div><div class="agent-title">你的募集书协作助手</div><div class="agent-subtitle">核对数据 · 标记缺口 · 保留依据</div></div></div>
    ${busy()?`<div class="status-card"><strong>Agent 正在更新文档</strong><div class="progress-track"><div style="width:${p.job.progress}%"></div></div><div class="activity"><i class="spinner"></i>${esc(p.job.step)}</div><p>你可以浏览原文和材料，停止任务后可继续人工编辑。</p></div>`:''}
    ${p.job.status==='failed'?`<div class="status-card error"><strong>本次任务尚未完成${p.job.progress!=null?` · 停止于 ${p.job.progress}%`:''}</strong><p>${esc(p.job.error)}</p><p>已逐项判断 ${p.stats.scanned} / ${p.stats.total} 个位置；已保存的有来源修改不会丢失。</p></div>`:''}
    ${p.job.status==='completed'?`<div class="status-card"><strong>本轮更新已完成</strong><p>已逐项判断 ${p.stats.scanned} / ${p.stats.total} 个位置。请继续处理人工待办并确认有来源修改。</p></div>`:''}
    ${p.stats.awaiting_agent?`<div class="status-card"><strong>${p.stats.awaiting_agent} 处待 Agent 处理</strong><p>系统尚未完成数据匹配。这些初步标记不表示材料缺失，也不要求你逐项填写。</p></div>`:''}
    ${p.stats.original_todos?`<div class="status-card"><strong>${p.stats.original_todos} 处原稿待办</strong><p>原募集书已含有【】，这里继续保留。它们与 Agent 尚未处理的事项分别计数。</p></div>`:''}
    ${p.messages.map(m=>`<div class="message ${m.role}"><div class="message-label">${m.role==='assistant'?icon('spark')+ ' Agent':'你'} <span>· ${smallDate(m.created_at)}</span></div><div class="message-text">${bracket(m.text)}</div></div>`).join('') || '<div class="message-text">我会根据你选择的范围更新募集书。请先上传底稿和来源材料，再点击“开始更新”。你也可以直接告诉我具体要修改的章节。</div>'}
    ${p.stats.changes||p.stats.missing_source?`<div class="agent-note"><div>${icon('check')}<strong>${p.stats.changes} 处有来源修改</strong>可在文档中逐一查看</div>${p.stats.missing_source?`<div>${icon('info')}<strong>${p.stats.missing_source} 处建议未应用</strong>因为没有可核实引文</div>`:''}<div>${icon('link')}点击修改 → 引用原文 → 来源文件</div></div>`:''}
    <div class="suggestions"><button data-action="suggest" data-prompt="请检查全文中是否还有遗漏的更新位置，特别是正文、表格和所有【】；缺少材料也请逐项标记。">检查全文遗漏 ${icon('arrow')}</button><button data-action="suggest" data-prompt="请列出当前缺少哪些资料，按要补充的字段、期间和来源说明。只回答，不修改文档。">还需要哪些材料？</button>${S.selected?'<button data-action="suggest" data-prompt="请解释选中位置为什么这样修改，并说明引用原文的主体、期间和口径。只回答，不修改。">解释选中这处修改</button>':''}</div>
    ${S.runtime.ready===false?`<div class="runtime-notice">${esc(S.runtime.message)}<button data-action="runtime">重新检测 Agent 连接</button></div>`:''}`;
}
function renderComposer(){const t=selectedTarget();return `<div class="composer-wrap"><div class="composer">${t?`<div class="selection-pill"><span>${icon('file')} 已选择：${esc(t.text || t.context).slice(0,80)}</span><button class="icon-btn" data-action="clear-selection" title="取消选中">${icon('close')}</button></div>`:''}<textarea id="chat-input" aria-label="与 Agent 对话" placeholder="告诉 Agent 你想怎么改…" ${busy()?'disabled':''}>${esc(S.draft)}</textarea><div class="composer-bottom"><div><button class="icon-btn" data-action="materials" title="添加材料">${icon('clip')}</button><span class="badge">${S.p.mode==='financial'?'财务数据':'全文更新'}</span>${S.p.web_enabled?`<span class="badge green">${icon('globe')} 联网</span>`:''}</div><button class="send-btn" data-action="send" title="发送消息（Ctrl + Enter）" ${busy()?'disabled':''}>${icon('send')}</button></div></div><div class="composer-caption">${busy()?'任务运行中 · 可随时停止':'Ctrl + Enter 发送 · 最终披露仍由项目组确认'}</div></div>`;}
function renderSource(){
  const tasks=S.p.document?.layout_tasks?.filter(t=>t.target_id===S.selected) || [];
  return tasks.map(t=>`<div class="status-card"><strong>报告期列安排需确认</strong><p>${esc(t.text)}</p><p>原表列数和列宽保持不变，此事项会保留在 Word 批注中。</p></div>`).join('')+renderSourceDetail();
}
function renderSourceDetail(){
  const t=selectedTarget();if(!t)return `<div class="empty-state">${icon('link')}<strong>每一处修改，都能追溯</strong><p>点击左侧正文或表格中的修改，<br>这里会显示原文、新文和来源材料。</p></div>`;
  const c=getChange(t.id);
  if(!c)return `<div class="source-head">原文位置 <span class="badge">未修改</span></div><div class="source-position">${esc(t.chapter)} · ${esc(t.locator)}</div><div class="compare-text">${bracket(t.text)}</div><p class="reason">${esc(S.p.coverage[t.id]?.reason || '此处尚未形成修改建议。你可以手动编辑，也可以让 Agent 核对。')}</p><div class="source-actions"><button class="secondary" data-action="edit">${icon('edit')}手动编辑</button><button class="primary" data-action="ask-selection">${icon('spark')}交给 Agent</button></div>`;
  if(awaitingAgent(c)) return `<div class="source-head">等待系统处理 <span class="badge">尚未核对</span></div><div class="source-position">${esc(t.chapter)} · ${esc(t.locator)}</div><div class="compare-label">原文（尚未更新）</div><div class="compare-text">${bracket(c.before) || '拟新增的报告期位置'}</div><div class="reason">规则扫描发现这个位置可能涉及报告期更新，但 Agent 尚未核对。已有材料是否足够、应替换成哪个数字，目前都没有结论。</div><div class="no-source"><strong>来源尚未匹配</strong>这不代表你没有提供数据。Agent 运行后应直接替换证据明确的数字，只有资料缺失或口径不确定的内容才交给你确认。</div><div class="source-actions"><button class="secondary" data-action="edit">手动编辑</button><button class="primary" data-action="runtime">检查 Agent 连接</button></div>`;
  if(missingSource(c)) return `<div class="source-head">建议未应用 <span class="badge amber">缺少来源</span></div><div class="source-position">${esc(t.chapter)}<br>${esc(t.locator)}</div><div class="compare-label">当前仍保留的原文</div><div class="compare-text old">${esc(c.before) || '新增报告期位置'}</div><div class="compare-label">安全待办</div><div class="compare-text review">${bracket(c.after)}</div><div class="reason">${esc(c.reason)}</div><div class="no-source"><strong>没有可核实引文，因此没有写入 Agent 建议值</strong>请补充对应报表、附注或审计材料后让 Agent 重新核对，或者由你直接填写并确认。未验证的模型数值不会进入预览和导出。</div><div class="source-actions"><button class="secondary" data-action="review" data-review="reject">保留原文</button><button class="secondary" data-action="edit">${icon('edit')}人工填写</button><button class="primary" data-action="ask-selection">${icon('spark')}重新核对</button></div>`;
  const labels={needs_review:'需要确认',pending:'待审核',accepted:'已确认',rejected:'已拒绝'};
  return `<div class="source-head">修改详情 <span class="badge ${c.needs_review?'amber':'green'}">${labels[c.status]}</span></div><div class="source-position">${esc(t.chapter)}<br>${esc(t.locator)}</div><div class="compare-label">原文</div><div class="compare-text old">${esc(c.before) || '新增报告期列'}</div><div class="compare-label">${c.status==='rejected'?'已拒绝的建议':'更新后'}</div><div class="compare-text ${c.needs_review?'review':'new'}">${bracket(c.after)||'（已删除）'}</div><div class="reason">${esc(c.reason)}</div>
    <div class="evidence-label"><span>来源依据</span><span>${c.sources.length?'引文已匹配原文':''}</span></div>
    ${c.sources.length?c.sources.map((s,i)=>`<div class="source-card"><button class="source-file" data-action="source-file" data-index="${i}" title="打开来源并定位到原文"><span class="file-icon">${icon('file')}</span><div><div class="source-filename">${esc(s.name)}</div><div class="source-location">${esc(s.locator)} · 查看原文 ${icon('arrow')}</div></div></button><blockquote class="source-quote">“${esc(s.quote)}”</blockquote></div>`).join(''):`<div class="no-source"><strong>${c.origin==='human'?'用户填写并确认':'尚无可核实的数据源'}</strong>${c.origin==='human'?'该内容来自你的直接编辑。之前的 Agent 修改记录已保留。':'需要更新的位置已经标出。你可以补充来源材料，或直接填写【】内的内容。'}</div>`}
    <div class="source-actions">${c.status==='accepted'||c.status==='rejected'?`<button class="secondary" data-action="review" data-review="reopen">重新审核</button>`:`<button class="secondary" data-action="review" data-review="reject">拒绝</button>`}<button class="secondary" data-action="edit">${icon('edit')}编辑</button>${c.status!=='accepted'&&c.status!=='rejected'?`<button class="primary" data-action="${c.needs_review?'edit':'review'}" data-review="accept">${icon('check')}${c.needs_review?'填写确认':'接受修改'}</button>`:''}</div>${c.needs_review?'<p class="small muted" style="line-height:1.9">请先核对或填写【】中的内容，再保存确认。</p>':''}`;
}
function renderQueue(){
  const p=S.p;
  const filters={needs_review:'人工待办',verified:'有来源修改',awaiting_agent:'待 Agent 处理',layout:'表格结构',all:'修改与标记',accepted:'已确认',unscanned:'尚未核对'};
  const list=S.queue==='verified'?p.changes.filter(c=>c.status!=='rejected'&&c.before!==c.after&&(c.sources?.length||c.origin==='human')):S.queue==='layout'?(p.document?.layout_tasks || []).map(t=>({target_id:t.target_id,chapter:'原表格式保留',after:t.text,issue:'表格列安排'})):S.queue==='unscanned'?p.targets.filter(t=>!p.coverage[t.id]).map(t=>({target_id:t.id,chapter:t.chapter,after:t.text || t.context,issue:'尚未逐项判断'})):p.changes.filter(c=>S.queue==='all'?c.status!=='rejected':S.queue==='awaiting_agent'?awaitingAgent(c):c.status===S.queue&&!awaitingAgent(c));
  return `<div class="queue-title"><span>${filters[S.queue]} <span class="muted">${list.length}</span></span><select aria-label="修改筛选" id="queue-filter" style="border:1px solid var(--line);border-radius:5px;padding:5px;color:var(--muted);font-size:10px">${Object.entries(filters).map(([v,l])=>`<option value="${v}" ${S.queue===v?'selected':''}>${l}</option>`).join('')}</select></div><div class="filter-note">${S.queue==='awaiting_agent'?'这些位置尚未由 Agent 处理，不是要求你逐项填写。':'点击待办，定位正文并查看依据'}</div>${list.map(c=>`<button class="queue-item ${c.target_id===S.selected?'active':''}" data-action="select-change" data-id="${esc(c.target_id)}"><span class="tag">${esc(awaitingAgent(c)?'待 Agent 处理':missingSource(c)?'缺少来源，建议未应用':c.review_stage==='original_todo'?'原稿已有【】':c.issue || (c.status==='accepted'?'已确认':'待审核'))}</span><div class="queue-chapter">${esc(c.chapter)}</div><div class="queue-text">${bracket(c.after || c.before)}</div></button>`).join('') || `<div class="empty-state">${icon('circleCheck')}<strong>当前没有${filters[S.queue]}项</strong><p>${p.stats.scanned<p.stats.total?'部分位置尚未获得逐项判断，请运行 Agent 后继续核对。':'你可以继续查看其他修改或导出文档。'}</p></div>`}<div class="source-metadata" style="margin-top:20px">逐项判断 ${p.stats.scanned} / ${p.stats.total} 个正文与表格位置${p.demo?'（示例项目）':''}。此计数不代表披露已审核通过。</div>`;
}

function openModal(title, subtitle, body, footer='', wide=false){
  document.getElementById('overlay').innerHTML=`<div class="modal-backdrop" data-backdrop="true"><section class="modal ${wide?'wide':''}" role="dialog" aria-modal="true" aria-labelledby="modal-title"><div class="modal-head"><div><h2 id="modal-title">${esc(title)}</h2><p>${esc(subtitle)}</p></div><button class="icon-btn" data-action="close-modal" title="关闭">${icon('close')}</button></div>${body}${footer?`<div class="modal-footer">${footer}</div>`:''}</section></div>`;
  setTimeout(()=>document.querySelector('.modal input:not([type=radio]):not([type=checkbox]), .modal textarea, .modal .primary, .modal .icon-btn')?.focus(),20);
}
function closeModal(){if(S.uploading)toast('材料会继续在后台上传，可从顶部进度或“项目材料”查看。');document.getElementById('overlay').innerHTML='';S.modal=null;}
function openWorkspaceInfo(){
  const s=S.storage;
  openModal(s.label || '项目工作空间',s.shared?'这是由共享密码保护的 Azure 工作空间。':'文件保存在当前设备的本地工作空间。',`<div class="modal-body"><div class="workspace-metrics"><div><span>应用数据</span><strong>${formatBytes(s.used_bytes || 0)}</strong></div><div><span>磁盘可用</span><strong>${formatBytes(s.disk_free_bytes || 0)}</strong></div><div><span>单项目材料上限</span><strong>${formatBytes(s.project_limit_bytes || 0)}</strong></div><div><span>项目数量</span><strong>${s.project_count || 0}</strong></div></div><div class="status-card"><strong>材料保存方式</strong><p>${s.shared?'上传的原文件、解析结果和审核记录保存在 Azure VM 的 Docker 持久化卷中，不会因为容器重启而消失。它们占用磁盘空间，不会长期占用同等大小的内存。':'上传的原文件、解析结果和审核记录保存在本机磁盘。'} 原文件用于来源定位、下载核对和保持 Word 格式，因此不能在解析后立即删除。</p></div>${s.shared?`<div class="status-card error"><strong>当前是共享工作区，不是多租户系统</strong><p>所有持有共享账号密码的人都能看到这里的全部项目和材料。面向更多独立客户前，应改用用户登录、项目权限、数据库和 Azure Blob Storage。</p></div>`:''}<p class="small muted" style="line-height:1.9">服务器会保留最近 3 次 Agent 运行目录，并在磁盘剩余低于 ${formatBytes(s.min_free_bytes || 0)} 时停止接收新文件，避免写满系统盘。</p></div>`,`<button class="secondary" data-action="close-modal">完成</button>`);
}
function newProject(){
  S.modal='new';
  openModal('新建募集书更新任务','从一份底稿开始，把更新和审阅放在同一个工作空间。',`<form id="new-project-form"><div class="modal-body"><div class="field"><label for="project-name">项目名称</label><input id="project-name" name="title" type="text" maxlength="120" placeholder="例如：某某城投 · 2026年私募公司债" required></div><div class="field"><label>更新范围</label><div class="mode-options"><label class="mode-option"><input type="radio" name="mode" value="financial" checked><strong>只更新财务数据</strong><p>财务报表、附注、审计报告<br>同步更新正文和表格中的财务数据。</p></label><label class="mode-option"><input type="radio" name="mode" value="full"><strong>全文更新</strong><p>增加征信、工商、评级等材料<br>支持公开网页查询，覆盖更多事实。</p></label></div></div><div class="field"><label for="period">目标报告期末</label><input id="period" type="date" name="period" value="2026-06-30" required><div class="hint">请按实际材料确认。募集书编制月份不会自动决定财务报告期。</div></div><label class="checkline" id="web-check" style="display:none"><input type="checkbox" name="web_enabled"><span><strong>允许查询公开网页</strong><br>Agent 可查找公开来源。私密材料中的金额及个人信息不作为搜索词。</span></label></div><div class="modal-footer"><button class="secondary" type="button" data-action="close-modal">取消</button><button class="primary" type="submit">创建并添加材料 ${icon('chevron')}</button></div></form>`);
}
function uploadOriginal(){openMaterials('prospectus');}
function openMaterials(role='source'){
  S.modal='materials';
  const p=S.p;
  const projectBytes=p.files.reduce((sum,f)=>sum+(f.size||0),0);
  openModal('项目材料', '上传后保留原文件，并为正文、表格和 PDF 页码建立可定位来源。', `<div class="modal-body"><div class="material-storage-note">${icon('shield')}<div><strong>${S.storage.shared?'保存在 Azure 持久化存储':'保存在本机磁盘'}</strong><span>本项目原文件 ${formatBytes(projectBytes)}；文件用于来源核对和 Word 导出，不是长期占用内存。</span></div></div><div class="materials-list">${p.files.map(f=>`<div class="material-row"><span class="file-icon">${icon(f.category==='web'?'globe':'file')}</span><div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${categoryNames[f.category] || '来源材料'} · ${formatBytes(f.size)} · ${f.page_count?f.page_count+' 页':'按段落或单元格定位'}</div>${f.warnings.length?`<div class="warn">${esc(f.warnings.join(' '))}</div>`:''}</div><button class="icon-btn" data-action="open-material" data-id="${f.id}" title="查看材料原文">${icon('eye')}</button></div>`).join('') || '<div class="muted small">还没有上传材料</div>'}</div>
    <div class="inline-row"><div class="field"><label for="upload-role">上传到</label><select id="upload-role"><option value="source" ${role==='source'?'selected':''}>来源材料</option>${!p.original_id?`<option value="prospectus" ${role==='prospectus'?'selected':''}>待更新的募集书底稿</option>`:''}</select></div><div class="field"><label for="upload-category">材料类型</label><select id="upload-category">${Object.entries(categoryNames).filter(([k])=>!['web','prospectus'].includes(k)).map(([k,v])=>`<option value="${k}">${v}</option>`).join('')}</select></div></div>
    <div class="dropzone ${busy()?'disabled':''}" id="dropzone" tabindex="0" role="button" aria-label="选择或拖入文件" data-action="choose-files">${icon('upload')}<strong>${busy()?'Agent 运行时不能添加材料':'点击选择文件，或拖入这里'}</strong>DOCX / PDF / XLSX / CSV / TXT / MD · 单份不超过 25 MB<br>可继续选择其他文件，系统会自动加入上传队列</div><input type="file" id="file-input" accept=".docx,.pdf,.xlsx,.csv,.txt,.md" multiple hidden><div id="upload-status" class="upload-queue" aria-live="polite"></div>
    ${p.mode==='full'&&p.web_enabled?`<div class="field" style="margin-top:24px"><label for="source-url">添加公开网页</label><div class="inline-row"><input type="url" id="source-url" placeholder="https://…"><button class="secondary" data-action="add-url">${icon('globe')}读取网页</button></div><div class="hint">保存可核实的正文快照和查询时间；登录页面请另行提供导出的材料。</div></div>`:''}
    ${p.mode==='financial'?'<p class="small muted" style="line-height:1.9">本项目仅处理财务数据。公司概况中的注册资本、实缴资本归工商查询模块，不会从财务报表自动替换。</p>':''}</div>`, `<button class="secondary" data-action="close-modal">完成</button>`);
  document.querySelector('.modal-body')?.insertAdjacentHTML('beforeend','<p class="small muted" style="line-height:1.9">上传完成前请保持页面打开。关闭此窗口或切换项目不会中断上传；刷新或关闭浏览器会中断当前文件。运行 Agent 时，相关内容会发送给 Codex 当前配置的模型服务。</p>');
  renderUploadStatus();
}
function uploadStatusLabel(item){
  return {queued:'等待上传',uploading:`上传中 ${item.progress || 0}%`,processing:'服务器解析中',done:'上传完成',failed:'上传失败'}[item.status] || item.status;
}
function renderUploadStatus(){
  const host=document.getElementById('upload-status');if(!host||!S.p)return;
  const items=S.uploads.filter(item=>item.projectId===S.p.id).slice(-20);
  host.innerHTML=items.map(item=>`<div class="upload-item ${item.status}"><div class="upload-item-head"><span class="name">${esc(item.file.name)}</span><span>${esc(uploadStatusLabel(item))}</span></div><div class="upload-progress"><i style="width:${item.status==='done'?100:item.progress || 0}%"></i></div>${item.error?`<div class="upload-error">${esc(item.error)}</div>`:''}</div>`).join('');
}
function updateUploadIndicators(){
  const active=activeUploads(),button=document.getElementById('global-upload-status');
  if(button){button.style.display=active.length?'':'none';button.querySelector('span').textContent=active.length?`${active.length} 份材料处理中`:'';}
  renderUploadStatus();
}
function uploadRequest(item,retried=false){
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    const query=new URLSearchParams({name:item.file.name,role:item.role,category:item.category});
    xhr.open('POST',`/api/projects/${item.projectId}/files?${query}`);
    xhr.setRequestHeader('Content-Type','application/octet-stream');
    xhr.setRequestHeader('X-Bond-Token',S.token);
    xhr.upload.onprogress=event=>{if(event.lengthComputable){item.progress=Math.round(event.loaded/event.total*100);updateUploadIndicators();}};
    xhr.upload.onload=()=>{item.progress=100;item.status='processing';updateUploadIndicators();};
    xhr.onerror=()=>reject(new Error('网络连接中断，请重新选择该文件。'));
    xhr.onload=()=>{
      let data={};try{data=JSON.parse(xhr.responseText || '{}');}catch{}
      if(xhr.status>=200&&xhr.status<300)resolve(data);
      else if(xhr.status===403&&!retried&&String(data.error || '').includes('访问校验失败')){
        refreshAccess().then(()=>uploadRequest(item,true)).then(resolve,reject);
      }else reject(new Error(data.error || `上传失败（HTTP ${xhr.status}）`));
    };
    xhr.send(item.file);
  });
}
async function drainUploadQueue(){
  if(S.uploading)return;
  S.uploading=true;let completed=0,failed=0;
  try{
    for(let item;(item=S.uploads.find(entry=>entry.status==='queued'));){
      item.status='uploading';item.progress=0;updateUploadIndicators();
      try{await uploadRequest(item);item.status='done';item.progress=100;completed++;}
      catch(error){item.status='failed';item.error=error.message;failed++;}
      updateUploadIndicators();
    }
  }finally{
    S.uploading=false;S.uploads=S.uploads.slice(-40);updateUploadIndicators();
    if(S.p)await refresh();
    if(S.modal==='materials')openMaterials(S.p.original_id?'source':'prospectus');
    if(completed)toast(`已添加 ${completed} 份材料，原文定位已建立。`);
    if(failed)toast(`${failed} 份材料上传失败，请查看队列中的原因。`,true);
  }
}
function uploadFiles(files){
  if(busy()){toast('Agent 正在运行，请等待完成或先停止任务。',true);return;}
  const role=document.getElementById('upload-role')?.value || 'source';
  const category=role==='prospectus'?'prospectus':document.getElementById('upload-category')?.value || 'financial';
  const list=Array.from(files);
  if(role==='prospectus'&&list.length>1){toast('请一次选择一份募集书底稿。',true);return;}
  if(role==='prospectus'&&(S.p.original_id||S.uploads.some(item=>item.projectId===S.p.id&&item.role==='prospectus'&&item.status!=='failed'))){toast('当前项目已有或正在上传募集书底稿。',true);return;}
  let added=0;
  for(const file of list){
    if(file.size>25*1024*1024){toast(file.name+' 超过 25 MB，请拆分材料。',true);continue;}
    S.uploads.push({id:`upload-${Date.now()}-${Math.random()}`,projectId:S.p.id,file,role,category,status:'queued',progress:0,error:''});added++;
  }
  if(!added)return;
  if(S.uploading)toast(`已将 ${added} 份材料加入队列。`);
  updateUploadIndicators();
  drainUploadQueue().catch(error=>toast(error.message,true));
}
async function showSource(fileId,segmentId=null,quoteText=''){
  const f=await api(`${base()}/files/${fileId}`);S.modal='source';
  const selected=f.segments.find(s=>s.id===segmentId);const page=selected?.page || 1;
  const rawLink=`${base()}/files/${f.id}/raw`;
  const body=f.extension==='.pdf'?`<div class="source-paper"><div class="source-metadata">PDF 原文件 · 第 ${page} 页</div><img class="pdf-preview" alt="${esc(f.name)} 第 ${page} 页" src="${base()}/files/${f.id}/page/${page}">${selected?`<div class="source-segment highlight"><span class="segment-locator">本处引用</span>${esc(quoteText || selected.text)}</div>`:''}</div>`:`<div class="source-paper">${f.segments.map(s=>`<div id="src-${esc(s.id)}" class="source-segment ${s.id===segmentId?'highlight':''}"><span class="segment-locator">${esc(s.locator)}</span>${esc(s.text)}</div>`).join('')}</div>`;
  openModal(f.name,selected?`已定位：${selected.locator} · 原始材料内容`:'来源文件原文', `<div class="viewer-layout"><aside class="viewer-index"><span class="eyebrow">SOURCE FILE</span><p>${esc(f.name)}</p><span class="badge green">${categoryNames[f.category] || '来源材料'}</span><div class="source-metadata">上传于 ${smallDate(f.uploaded_at)}<br>${(f.size/1024).toFixed(1)} KB</div>${f.url?`<a href="${esc(f.url)}" target="_blank" rel="noopener noreferrer" class="small">打开公开网页 ${icon('arrow')}</a>`:''}${f.extension==='.pdf'?Array.from({length:f.page_count},(_,i)=>`<button class="source-navitem ${i+1===page?'active':''}" data-action="pdf-page" data-file="${f.id}" data-page="${i+1}">第 ${i+1} 页</button>`).join(''):`<div class="source-metadata">这里显示已提取原文。DOCX 按段落或单元格定位，XLSX 按工作表和单元格定位，可下载原文件核对格式。</div>`}<a class="secondary" href="${rawLink}" download style="font-size:10px;margin-top:14px">${icon('download')}下载原文件</a></aside><div class="viewer-content" data-scroll="source">${body}</div></div>`, '', true);
  if(segmentId)setTimeout(()=>document.getElementById('src-'+segmentId)?.scrollIntoView({block:'center'}),40);
}
function editSelected(){
  const t=selectedTarget();if(!t)return;const c=getChange(t.id);S.modal='edit';
  editRevision=S.p.revision;
  openModal('编辑并确认本处内容',t.chapter+' · '+t.locator,`<form id="edit-form"><div class="modal-body"><div class="field"><label for="edit-content">修改后的内容</label><textarea id="edit-content" name="text">${esc(c&&c.status!=='rejected'?c.after:t.text)}</textarea><div class="hint">填写并去掉已解决的【】后保存，即记录为你的人工确认。仍含【】的内容继续保留在待办。</div></div><p class="small muted" style="line-height:1.8">手工修改不会继续沿用旧引文作为新内容的依据；之前的修改保留在审核记录中。</p></div><div class="modal-footer"><button type="button" class="secondary" data-action="close-modal">取消</button><button class="primary" type="submit">保存并确认 ${icon('check')}</button></div></form>`);
}
function exportModal(){
  S.modal='export';const p=S.p;
  openModal('导出当前募集书','修订记录和未解决的【】都会按所选模式保留。',`<div class="modal-body">${p.stats.awaiting_agent?`<p class="warning-text">还有 ${p.stats.awaiting_agent} 处待 Agent 处理，导出将保留初步扫描标记，不能视为已完成的数据更新。</p>`:''}${p.stats.needs_review?`<p class="warning-text">还有 ${p.stats.needs_review} 处需要人工确认。最终视图仍保留这些【】，不会将它们当作已确认内容。</p>`:''}<a class="export-option" href="${base()}/export?view=revision" download>${icon('edit')}<div><strong>Word 修订版</strong><p>保留历史 Word 格式，使用 Word 原生修订记录查看新旧文字。</p></div>${icon('download')}</a><a class="export-option" href="${base()}/export?view=final" download>${icon('file')}<div><strong>Word 最终视图</strong><p>隐藏删除痕迹，保留当前内容和所有未解决的【】。</p></div>${icon('download')}</a><a class="export-option" href="${base()}/export?format=json" download>${icon('list')}<div><strong>审核与来源记录</strong><p>导出修改前后、来源引文及审核状态，便于留档。</p></div>${icon('download')}</a><div class="export-note">${p.document.extension==='.docx'?'网页使用普通预览。导出直接在历史 Word 原文件上替换文字，保留原字体、段落、标题、表格、图片和页眉页脚。需要新增报告期列的事项保留为【】批注，不改变原列宽。':'当前底稿不是 Word；仅 DOCX 底稿支持保留原 Word 格式。'}</div></div>`,`<button class="secondary" data-action="close-modal">完成</button>`);
}
async function sendMessage(message){
  message=(message ?? S.draft).trim();if(!message){toast('先告诉 Agent 你想修改什么。');return;}
  if(!S.p.original_id){toast('请先上传募集书底稿。');uploadOriginal();return;}
  await post(`${base()}/chat`,{message,target_id:S.selected});S.draft='';S.tab='chat';S.mobile=true;await refresh();
  const panel=document.querySelector('[data-scroll="panel"]');if(panel)panel.scrollTop=panel.scrollHeight;
}
function ensureBlockVisible(id){
  const blocks=S.p?.document?.blocks || [];
  const index=blocks.findIndex(block=>block.id===id||(block.type==='table'&&block.rows.some(row=>row.some(cell=>cell.id===id))));
  if(index>=S.blockLimit)S.blockLimit=Math.min(blocks.length,index+20);
}
function selectTarget(id,jump=false){S.selected=id;S.tab='source';S.mobile=true;ensureBlockVisible(id);render();if(jump)setTimeout(()=>document.getElementById('doc-'+id)?.scrollIntoView({behavior:'smooth',block:'center'}),0);}

document.addEventListener('input',event=>{if(event.target.id==='chat-input')S.draft=event.target.value;});
document.addEventListener('change',event=>{
  if(event.target.name==='mode')document.getElementById('web-check').style.display=event.target.value==='full'?'flex':'none';
  if(event.target.id==='queue-filter'){S.queue=event.target.value;render();}
  if(event.target.id==='file-input'){uploadFiles(event.target.files);event.target.value='';}
});
document.addEventListener('submit',async event=>{
  event.preventDefault();const form=event.target;
  try{
    if(form.id==='new-project-form'){
      const data=new FormData(form);const payload={title:data.get('title'),mode:data.get('mode'),period:data.get('period'),web_enabled:data.get('web_enabled')==='on'};
      const p=await post('/api/projects',payload);closeModal();await loadProjects();await selectProject(p.id);uploadOriginal();toast('项目已创建，先添加募集书底稿。');
    }else if(form.id==='edit-form'){
      await post(`${base()}/edit`,{target_id:S.selected,revision:editRevision,text:new FormData(form).get('text')});closeModal();await refresh();toast('修改已保存，审核记录已更新。');
    }
  }catch(e){toast(e.message,true);}
});
document.addEventListener('click',async event=>{
  const el=event.target.closest('[data-action]');
  if(!el){const t=event.target.closest('[data-target]');if(t)selectTarget(t.dataset.target);if(event.target.dataset.backdrop)closeModal();return;}
  event.preventDefault();
  try{
    const action=el.dataset.action;
    if(action==='new-project')newProject();
    else if(action==='project')await selectProject(el.dataset.id);
    else if(action==='close-modal')closeModal();
    else if(action==='view'){S.view=el.dataset.view;localStorage.setItem('bond-view',S.view);render();}
    else if(action==='tab'){S.tab=el.dataset.tab;render();}
    else if(action==='materials')openMaterials();
    else if(action==='upload-original')uploadOriginal();
    else if(action==='choose-files'){document.getElementById('file-input')?.click();}
    else if(action==='queue'){S.queue=el.dataset.filter || 'needs_review';S.tab='queue';S.mobile=true;render();}
    else if(action==='jump'){ensureBlockVisible(el.dataset.id);render();setTimeout(()=>document.getElementById('doc-'+el.dataset.id)?.scrollIntoView({behavior:'smooth',block:'start'}),0);}
    else if(action==='load-more'){S.blockLimit=Math.min(S.p.document.blocks.length,S.blockLimit+80);render();}
    else if(action==='select-change')selectTarget(el.dataset.id,true);
    else if(action==='source-file'){const c=getChange(S.selected);const s=c?.sources[Number(el.dataset.index)];if(s)await showSource(s.source_id,s.segment_id,s.quote);}
    else if(action==='open-material')await showSource(el.dataset.id);
    else if(action==='pdf-page'){const image=document.querySelector('.pdf-preview');if(image)image.src=`${base()}/files/${el.dataset.file}/page/${Number(el.dataset.page)}`;document.querySelectorAll('.source-navitem').forEach(x=>x.classList.toggle('active',x===el));const meta=document.querySelector('.source-paper>.source-metadata');if(meta)meta.textContent=`PDF 原文件 · 第 ${el.dataset.page} 页`;document.querySelector('.source-segment.highlight')?.remove();}
    else if(action==='edit')editSelected();
    else if(action==='review'){const c=getChange(S.selected);await post(`${base()}/review`,{change_id:c.id,action:el.dataset.review,version:c.version});await refresh();toast(el.dataset.review==='accept'?'已接受修改':el.dataset.review==='reject'?'已拒绝建议，最终视图保留原文':'已重新开放审核');}
    else if(action==='clear-selection'){S.selected=null;render();}
    else if(action==='toggle-panel'){S.mobile=!S.mobile;render();}
    else if(action==='send')await sendMessage();
    else if(action==='suggest')await sendMessage(el.dataset.prompt);
    else if(action==='ask-selection'){S.draft='请核对选中的位置是否需要更新。材料不足的地方请用【】标出，并说明缺少什么资料。';S.tab='chat';render();document.getElementById('chat-input')?.focus();}
    else if(action==='run'){await post(`${base()}/run`);S.tab='chat';S.mobile=true;await refresh();toast('任务已提交，将使用本机 Codex CLI 执行。');}
    else if(action==='cancel'){await post(`${base()}/cancel`);await refresh();toast('任务已停止，已完成的修改保留。');}
    else if(action==='export')exportModal();
    else if(action==='runtime'){el.disabled=true;S.runtime=await post('/api/runtime/check');render();toast(S.runtime.message,!S.runtime.ready);}
    else if(action==='add-url'){const url=document.getElementById('source-url').value.trim();if(!url)return;el.disabled=true;el.textContent='正在读取…';await post(`${base()}/url`,{url});await refresh();openMaterials();toast('网页正文快照已保存。');}
    else if(action==='history'){S.modal='history';openModal('操作记录','保留人工审核、直接编辑和 Agent 更新的记录。',`<div class="modal-body">${S.p.history.slice().reverse().map(h=>`<div class="history-item"><span>${esc(({accept:'接受修改',reject:'拒绝建议',edit:'人工修改',reopen:'重新审核'})[h.action] || h.action)}</span><time>${smallDate(h.at)}</time></div>`).join('') || '<div class="empty-state">暂无操作记录</div>'}</div>`);}
    else if(action==='workspace-info')openWorkspaceInfo();
  }catch(e){toast(e.message,true);if(el.isConnected)el.disabled=false;}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if(S.modal)closeModal();else{S.mobile=false;S.selected=null;render();}}
  if((event.ctrlKey||event.metaKey)&&event.key==='Enter'&&event.target.id==='chat-input'){event.preventDefault();if(!busy())sendMessage().catch(e=>toast(e.message,true));}
  if(event.key==='Enter'&&event.target.matches('[data-target]'))selectTarget(event.target.dataset.target);
  if((event.key==='Enter'||event.key===' ')&&event.target.id==='dropzone'){event.preventDefault();document.getElementById('file-input')?.click();}
  if(event.key==='Tab'&&S.modal){const focusables=[...document.querySelectorAll('.modal button:not(:disabled),.modal input:not([hidden]),.modal select,.modal textarea,.modal a[href]')].filter(x=>x.offsetParent!==null);const first=focusables[0],last=focusables.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}
});
document.addEventListener('dragover',event=>{const dz=event.target.closest('#dropzone');if(dz){event.preventDefault();dz.classList.add('dragover');}});
document.addEventListener('dragleave',event=>{event.target.closest('#dropzone')?.classList.remove('dragover');});
document.addEventListener('drop',event=>{const dz=event.target.closest('#dropzone');if(dz){event.preventDefault();dz.classList.remove('dragover');uploadFiles(event.dataTransfer.files);}});

async function boot(){
  try {const health=await api('/api/health');applyHealth(health);await loadProjects();const previous=new URLSearchParams(location.search).get('project') || localStorage.getItem('bond-project');const id=S.projects.find(p=>p.id===previous)?.id || S.projects[0]?.id;if(id)await selectProject(id);else render();if(S.runtime.ready===null){S.runtime=await post('/api/runtime/check');render();}}
  catch(e){document.getElementById('app').innerHTML=`<div class="boot"><span class="brandmark">B</span><p>工作台暂时无法连接</p><p class="small">${esc(e.message)}</p><button class="secondary" onclick="location.reload()">重新连接</button></div>`;}
}
boot();
