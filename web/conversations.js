/* Standalone conversation state never replaces S.p or its document/draft/selection. */
const CCHAT={current:null,items:[],drafts:new Map(),errors:new Map(),attempts:new Map(),sending:false,pending:null,loading:false,listLoading:false,loadError:'',epoch:0,booted:false,polling:false};
function csKey(){return CCHAT.current?.id||'new';}
function csBusy(c=CCHAT.current){return ['queued','running'].includes(c?.job?.status);}
function csRemember(c){CCHAT.items=[{id:c.id,title:c.title,job:c.job,updated_at:c.updated_at,created_at:c.created_at},...CCHAT.items.filter(x=>x.id!==c.id)].sort((a,b)=>b.updated_at.localeCompare(a.updated_at));}
async function csLoadList(){
  if(!S.features?.standalone_conversations||CCHAT.listLoading)return;
  CCHAT.listLoading=true;
  try{CCHAT.items=await api('/api/conversations');CCHAT.loadError='';}
  catch(error){CCHAT.loadError=error.message;}
  finally{CCHAT.listLoading=false;render();}
}
async function csOpen(id){
  const epoch=++CCHAT.epoch;CCHAT.loading=true;CCHAT.current=null;CCHAT.loadError='';coRoute('conversation');
  try{
    if(!S.features?.standalone_conversations)throw Error('后台需要重启以加载独立对话，现有项目和对话不会丢失。');
    const c=await api(`/api/conversations/${encodeURIComponent(id)}`);
    if(epoch!==CCHAT.epoch)return;
    CCHAT.current=c;csRemember(c);if(CO.page==='conversation')coRoute('conversation');
  }catch(error){if(epoch===CCHAT.epoch)CCHAT.loadError=error.message;}
  finally{if(epoch===CCHAT.epoch){CCHAT.loading=false;render();}}
}
function csNew(){if(CCHAT.sending)return;CCHAT.epoch++;CCHAT.current=null;CCHAT.loading=false;CCHAT.loadError='';coRoute('conversation');}
function csScrollLatest(){const el=document.querySelector('[data-co-scroll="standalone-chat"]');if(el)el.scrollTop=el.scrollHeight;}
async function csSend(message,id=CCHAT.current?.id||null){
  message=String(message||'').trim();if(!message||CCHAT.sending||CCHAT.loading)return false;
  const key=id||'new',epoch=CCHAT.epoch;CCHAT.drafts.set(key,message);CCHAT.errors.delete(key);
  if(!S.features?.standalone_conversations){const error=Error('后台需要重启以加载独立对话，输入已保留。');CCHAT.errors.set(key,error.message);render();throw error;}
  if(id&&csBusy(CCHAT.current)&&CCHAT.current.id===id)throw Error('这段对话仍在回复，请等待完成或先停止。');
  if(CCHAT.attempts.get(key)?.message!==message)CCHAT.attempts.set(key,{message,id:globalThis.crypto?.randomUUID?.()||`chat-${Date.now()}-${Math.random().toString(36).slice(2)}`});
  const requestId=CCHAT.attempts.get(key).id;
  CCHAT.sending=true;CCHAT.pending={id,message,epoch};render();csScrollLatest();
  try{
    const result=await post(id?`/api/conversations/${encodeURIComponent(id)}/chat`:'/api/conversations',{message,request_id:requestId});
    csRemember(result.conversation);CCHAT.drafts.delete(key);CCHAT.attempts.delete(key);
    if((CCHAT.current?.id||null)===id&&CCHAT.epoch===epoch){CCHAT.current=result.conversation;if(CO.page==='conversation')coRoute('conversation');}
    return true;
  }catch(error){CCHAT.errors.set(key,error.message);throw error;}
  finally{CCHAT.sending=false;CCHAT.pending=null;render();csScrollLatest();}
}
async function csStartFromHome(message){csNew();return csSend(message,null);}
async function csRefresh(){
  if(!CCHAT.current||CCHAT.polling||CCHAT.loading)return;
  CCHAT.polling=true;const id=CCHAT.current.id,epoch=CCHAT.epoch;
  const el=document.querySelector('[data-co-scroll="standalone-chat"]'),atBottom=!el||el.scrollHeight-el.scrollTop-el.clientHeight<80;
  try{
    const c=await api(`/api/conversations/${encodeURIComponent(id)}`);csRemember(c);
    if(CCHAT.current?.id===id&&epoch===CCHAT.epoch){CCHAT.current=c;CCHAT.loadError='';render();if(atBottom)csScrollLatest();}
  }catch(error){CCHAT.loadError='暂时无法获取新回复，已有消息保留。';render();}
  finally{CCHAT.polling=false;}
}
async function csCancel(){const id=CCHAT.current?.id;if(!id)return;const c=await post(`/api/conversations/${encodeURIComponent(id)}/cancel`);csRemember(c);if(CCHAT.current?.id===id){CCHAT.current=c;render();}}
function csHistory(){pwModal('独立对话','这些对话未关联项目。',!S.features?.standalone_conversations?'<p>请重启工作台以加载独立对话服务，再查看历史消息。</p>':CCHAT.loadError?`<p role="alert">${esc(CCHAT.loadError)}；请稍后重新打开。</p>`:`<div class="co-search-results">${CCHAT.items.map(c=>`<button data-co="conversation" data-id="${esc(c.id)}">${icon('chat')}<div><strong>${esc(c.title)}</strong><small>${smallDate(c.updated_at)}</small></div>${icon('chevron')}</button>`).join('')||'<p>还没有独立对话，从首页直接开始即可。</p>'}</div>`);}
function csPage(){
  const c=CCHAT.current,key=csKey(),pending=CCHAT.pending?.id===(c?.id||null)&&CCHAT.pending.epoch===CCHAT.epoch?CCHAT.pending:null,locked=CCHAT.sending||CCHAT.loading||csBusy();
  return `<section class="co-conversation-page co-standalone" aria-label="不关联项目的 Cowork 对话"><header><div><span class="co-chip">未关联项目</span><h1>${esc(c?.title||'和 Cowork 聊聊')}</h1><p>问答、讨论、撰写短内容 · 这段对话单独保存</p></div><div class="cs-header-actions"><button class="secondary" data-co="conversation-history">最近对话</button><button class="secondary" data-co="new-conversation" ${CCHAT.sending?'disabled':''}>${icon('plus')}新对话</button></div></header><div class="co-conversation-body co-cowork"><div class="co-cowork-scroll" data-co-scroll="standalone-chat">
    ${CCHAT.loading?'<p role="status">正在打开对话…</p>':''}${CCHAT.loadError?`<div class="co-request-failure" role="alert">${esc(CCHAT.loadError)}${c?'<button data-co="refresh-conversation">重试读取</button>':''}</div>`:''}
    ${!c?.messages.length&&!pending&&!CCHAT.loading?'<div class="cs-welcome"><h2>从一个问题开始。</h2><p>可以解释业务概念、讨论方案，或一起把一段文字写清楚。</p><small>这里不读取项目材料。需要更新募集书时，在首页选择对应项目。</small></div>':''}
    ${(c?.messages||[]).map(m=>`<div class="message ${m.role==='user'?'user':'assistant'}"><div class="message-label">${m.role==='user'?'你':'Cowork'} <span>· ${smallDate(m.created_at)}</span></div><div class="message-text">${bracket(m.text)}</div></div>`).join('')}
    ${pending?`<div class="message user pending"><div class="message-label">你 · 正在发送</div><div class="message-text">${bracket(pending.message)}</div></div>`:''}
    ${csBusy()?`<div class="co-chat-activity" role="status"><i class="spinner"></i>${esc(c.job.step)}<button data-co="cancel-conversation">停止</button></div>`:''}
    ${['failed','interrupted','cancelled'].includes(c?.job.status)?`<div class="co-request-failure" role="status">${esc(c.job.error||c.job.step)}<p>可以在下方补充要求，或重新提问。</p></div>`:''}
    ${CCHAT.errors.has(key)?`<div class="co-request-failure" role="alert">${esc(CCHAT.errors.get(key))}<p>输入已保留，可以重试发送。</p></div>`:''}
    </div><form class="composer-wrap" id="cs-chat-form"><div class="composer"><textarea id="cs-chat-input" name="message" aria-label="与 Cowork 直接对话" required maxlength="12000" placeholder="问个问题，或说说你的想法…" ${locked?'disabled':''}>${esc(CCHAT.drafts.get(key)||'')}</textarea><div class="composer-bottom"><span class="badge">未关联项目</span><button class="send-btn" type="submit" title="发送消息（Ctrl + Enter）" ${locked?'disabled':''}>${CCHAT.sending?'<i class="spinner"></i>':icon('send')}</button></div></div><div class="composer-caption">Ctrl + Enter 发送 · 独立保存对话</div></form></div></section>`;
}
document.addEventListener('input',event=>{if(event.target.id==='cs-chat-input')CCHAT.drafts.set(csKey(),event.target.value);});
document.addEventListener('submit',async event=>{if(event.target.id!=='cs-chat-form')return;event.preventDefault();event.stopImmediatePropagation();try{await csSend(new FormData(event.target).get('message'));}catch(error){toast(error.message,true);}},true);
document.addEventListener('keydown',event=>{if(event.target.id==='cs-chat-input'&&(event.ctrlKey||event.metaKey)&&event.key==='Enter'&&!event.isComposing){event.preventDefault();document.getElementById('cs-chat-form')?.requestSubmit();}});
setInterval(()=>{if(!document.hidden&&CO.page==='conversation'&&csBusy())csRefresh();},2000);
