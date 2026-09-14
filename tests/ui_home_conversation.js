// Exercise the real home -> project -> chat path with controlled responses, no live writes.
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path'),assert=require('node:assert/strict');
const handlers={},fields={overlay:{innerHTML:''}},posts=[],gates=[],reads=[];
let projectReadError=false;
const fixture=id=>({id,title:id,period:'2026-06-30',mode:'financial',demo:false,original_id:'original',document:{blocks:[]},
  files:[],messages:[],changes:[],targets:[],coverage:{},job:{status:'idle'},stats:{scanned:0,total:0},updated_at:'2026-09-14'});
const projects={p1:fixture('p1'),p2:fixture('p2')};
const context=vm.createContext({assert,URL,URLSearchParams,location:{href:'http://localhost/cowork.html',search:''},history:{replaceState(){}},
  localStorage:{getItem(){return null},setItem(){}},EventSource:class{close(){}},setInterval(){},setTimeout(){},queueMicrotask(){},
  document:{body:{dataset:{layout:'project'}},addEventListener(type,fn){(handlers[type]??=[]).push(fn)},getElementById(id){return fields[id]},querySelector(){return null},querySelectorAll(){return []}},
  FormData:class{constructor(form){this.data=form.data}get(key){return this.data[key]}},
  request:async(url,options={})=>{
    if(options.method==='POST'){posts.push({url,...JSON.parse(options.body)});return new Promise((resolve,reject)=>gates.push({resolve,reject}));}
    reads.push(url);if(projectReadError)throw Error('项目读取失败');return structuredClone(projects[url.split('/').at(-1)]);
  },
});
for(const file of ['project-workspace.js','cowork-os.js','conversations.js','app.js'])vm.runInContext(fs.readFileSync(path.join(__dirname,'../web',file),'utf8').replace(/\nboot\(\);\s*$/,''),context);
const run=code=>vm.runInContext(code,context);
run(`api=request;render=()=>{};toast=()=>{};refresh=async()=>{};CO.ready=true;CO.refreshed=Date.now();
S.p=${JSON.stringify(projects.p1)};S.projects=[S.p,${JSON.stringify(projects.p2)}];S.draft='项目一未发送';S.selected='paragraph-from-p1';
PW.cache.set('p2',{mode:'collab',draft:'项目二未发送',selected:'paragraph-from-p2',tab:'source',blockLimit:80});`);
const flush=async()=>{for(let i=0;i<8;i++)await Promise.resolve()};
(async()=>{
  const event={target:{id:'co-request-form',data:{request:'这一版现金流有什么变化？',project:'p2'}},preventDefault(){},stopImmediatePropagation(){}};
  const submit=handlers.submit[0](event);
  const duplicate=handlers.submit[0](event);
  await flush();await duplicate;
  assert.equal(posts.length,1,'One home submit produces one chat request, including duplicate clicks');
  assert.equal(posts[0].url,'/api/projects/p2/chat');assert.equal(posts[0].target_id,null);
  assert.equal(posts[0].scope,'chat');
  assert.equal(posts[0].message,event.target.data.request,'Neither project draft is sent');
  assert.equal(run('CO.page'),'project');assert.equal(run('CO.sideOpen'),true);
  assert.equal(run('S.pendingMessage.text'),event.target.data.request);assert.equal(run('S.draft'),'项目二未发送');
  assert.equal(run("PW.cache.get('p1').draft"),'项目一未发送');
  gates.shift().resolve({run_id:'first'});await submit;
  assert.equal(run('CO.homeDraft'),'');assert.equal(run('S.draft'),'项目二未发送');
  assert.equal(run('S.selected'),null);assert.equal(run('S.sending'),false);

  // Failure keeps the home request separate from an existing project draft.
  run("S.p.job={status:'idle'};");
  const failed=run("coSendHomeRequest('请解释现金流口径，只回答','p2')");await flush();
  const failedId=posts.at(-1).request_id;gates.shift().reject(Error('连接暂时中断'));await failed;
  assert.equal(run('CO.homeDraft'),'请解释现金流口径，只回答');assert.equal(run('S.draft'),'项目二未发送');
  assert.ok(run('coHomeRequestFailure()').includes('重试发送'));
  const retry=run('coSendHomeRequest(CO.homeDraft,CO.homeProject)');await flush();
  assert.equal(posts.at(-1).request_id,failedId,'A retry retains the idempotency key');
  gates.shift().resolve({run_id:'retried'});await retry;

  // An unavailable project must never fall back to sending into the current project.
  const count=posts.length;projectReadError=true;
  await run("coSendHomeRequest('项目一的问题','p1')");projectReadError=false;
  assert.equal(posts.length,count);assert.equal(run('CO.homeDraft'),'项目一的问题');assert.equal(run('CO.page'),'home');
  run("S.p.job={status:'running'};");await run("coSendHomeRequest('忙碌时的新要求','p2')");assert.equal(posts.length,count);

  // Project-scoped questions work before a prospectus exists with a compatible backend.
  run("S.p.original_id=null;S.p.document=null;S.p.job={status:'idle'};S.features={project_chat_without_document:true};");
  const beforeDoc=run("coSendHomeRequest('解释一下合并报表与母公司报表','p2')");await flush();
  assert.equal(posts.length,count+1);assert.ok(run('coProjectPanel()').includes('co-conversation-page'));
  gates.shift().resolve({run_id:'no-document'});await beforeDoc;
  run("S.p.job={status:'completed',kind:'chat',result_intent:'answer'};");
  assert.ok(!run('renderChat()').includes('本轮更新已完成'));

  // Late failure must not overwrite the draft of a project navigated to in the meantime.
  run("S.p.original_id='original';S.p.job={status:'idle'};S.draft='需要保留的发送失败草稿';");
  const late=run('sendMessage()');await flush();
  await run("selectProject('p1')");run("S.draft='项目一的新草稿';");
  gates.shift().reject(Error('稍后失败'));await assert.rejects(late,/稍后失败/);
  assert.equal(run('S.draft'),'项目一的新草稿');
  assert.equal(run("PW.cache.get('p2').draft"),'需要保留的发送失败草稿');
  // No project is the default option, including an entirely empty workspace.
  run("CO.homeProject='';S.features={standalone_conversations:true};S.p.job={status:'running'};");
  assert.ok(run('coHomeComposer()').includes('<option value="" selected>不关联项目'));
  run('const savedProjects=S.projects;S.projects=[];');
  assert.ok(run('coHomeComposer()').includes('co-request-form'));run('S.projects=savedProjects;');
  const beforeProject=run('JSON.stringify([S.p,S.draft,S.selected])');
  const direct=run("coSendHomeRequest('请解释债券久期','')");await flush();
  assert.equal(posts.at(-1).url,'/api/conversations');
  assert.equal(posts.at(-1).project_id,undefined);assert.equal(posts.at(-1).target_id,undefined);
  assert.equal(run('CO.page'),'conversation');
  await run("coSendHomeRequest('请解释债券久期','')");
  const c1={id:'c1',title:'债券久期',project_id:null,updated_at:'2026-09-14T02:00:00Z',created_at:'2026-09-14T02:00:00Z',messages:[{role:'user',text:'请解释债券久期',created_at:'2026-09-14'}],job:{id:'reply1',status:'queued',step:'准备回复'}};
  gates.shift().resolve({conversation:c1,run_id:'reply1'});await direct;
  assert.equal(run('JSON.stringify([S.p,S.draft,S.selected])'),beforeProject,'A standalone request must not change the active project state');
  assert.equal(run('CCHAT.current.id'),'c1');assert.equal(run('CO.homeDraft'),'');
  assert.ok(run('csPage()').includes('未关联项目'));assert.ok(!run('csPage()').includes('data-action="export"'));
  assert.equal(run("chatRequestScope('根据新一期财报更新募集书',null)"),'full_update');
  assert.equal(run("chatRequestScope('请根据新一期财报更新募集书，并说明修改依据',null)"),'full_update');
  assert.equal(run("chatRequestScope('请帮我更新整份募集说明书，并解释修改依据',null)"),'full_update');
  assert.equal(run("chatRequestScope('请更新募集说明书中的所有财务数据，不要修改其他章节',null)"),'full_update');
  assert.equal(run("chatRequestScope('请更新募集说明书中的财务数据，其他章节不要修改。',null)"),'full_update');
  assert.equal(run("chatRequestScope('为什么要更新募集书？',null)"),'chat');
  assert.equal(run("chatRequestScope('解释如何更新募集书',null)"),'chat');
  assert.equal(run("chatRequestScope('更新募集说明书是什么意思？',null)"),'chat');
  assert.equal(run("chatRequestScope('募集说明书更新需要哪些材料？',null)"),'chat');
  assert.equal(run("chatRequestScope('更新募集说明书有什么风险？',null)"),'chat');
  assert.equal(run("chatRequestScope('更新募集说明书会影响哪些章节？',null)"),'chat');
  assert.equal(run("chatRequestScope('请修改募集说明书第三章，其他章节不要修改。',null)"),'chat');
  assert.equal(run("chatRequestScope('为什么要更新募集书？',null,'full_update')"),'chat');
  assert.equal(run("chatRequestScope('请修改募集说明书第三章，其他章节不要修改。',null,'full_update')"),'chat');
  assert.equal(run("chatRequestScope('请更新整份募集说明书，附录不要修改。',null)"),'full_update');
  assert.equal(run("chatRequestScope('请检查全部位置，风险提示章节不要修改。',null)"),'full_update');
  assert.equal(run("chatRequestScope('请更新募集说明书，风险提示章节不要修改。',null,'full_update')"),'full_update');
  assert.deepEqual(
    JSON.parse(run("JSON.stringify(suggestionOptions({dataset:{scope:'full_update',projectWide:'1'}}))")),
    {scope:'full_update',targetId:null}
  );

  run("CCHAT.current.job={status:'completed'};");
  const followup=run("csSend('给我一个例子')");await flush();
  assert.equal(posts.at(-1).url,'/api/conversations/c1/chat');
  const followupId=posts.at(-1).request_id;gates.shift().reject(Error('发送失败'));await assert.rejects(followup,/发送失败/);
  assert.equal(run("CCHAT.drafts.get('c1')"),'给我一个例子');
  const retryFollowup=run("csSend(CCHAT.drafts.get('c1'))");await flush();
  assert.equal(posts.at(-1).request_id,followupId);
  gates.shift().resolve({conversation:{...c1,job:{status:'queued'}}});await retryFollowup;

  // Reloaded conversation data is separate, and stale reads cannot replace another selection.
  projects.c1={...c1,job:{status:'completed'},messages:[...c1.messages,{role:'assistant',text:'久期示例',created_at:'2026-09-14'}]};
  await run("csOpen('c1')");assert.equal(run('CCHAT.current.messages.length'),2);
  const afterChats=posts.length;run('csNew();S.features={};');
  await run("coSendHomeRequest('输入仍要保留','')");
  assert.equal(posts.length,afterChats);assert.equal(run('CO.homeDraft'),'输入仍要保留');
  assert.ok(run('csPage()').includes('后台需要重启'));
  assert.equal(run('JSON.stringify([S.p,S.draft,S.selected])'),beforeProject);
  console.log('PASS: One-send home workflow, project scope, draft preservation, retry identity, busy/load failures, and conversation without a document.');
})().catch(e=>{console.error(e);process.exitCode=1});
