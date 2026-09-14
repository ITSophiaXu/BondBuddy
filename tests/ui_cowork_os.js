// Product boundary checks without a browser, model calls, or changes to project data.
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const assert=require('node:assert/strict');
const handlers={},saved={},fields={app:{innerHTML:''},overlay:{innerHTML:''}};
const context=vm.createContext({
  assert,URL,URLSearchParams,location:{href:'http://localhost/cowork.html',search:''},
  history:{replaceState(){}},localStorage:{getItem(key){return saved[key]??null},setItem(key,value){saved[key]=value}},
  document:{body:{dataset:{layout:'project'}},addEventListener(type,fn){(handlers[type]??=[]).push(fn)},querySelector(){return null},querySelectorAll(){return []},getElementById(id){return fields[id]||null}},
  setInterval(){},setTimeout(){},queueMicrotask(){},FormData:class{constructor(form){this.data=form.data}get(key){return this.data[key]??null}},
});
for(const file of ['project-workspace.js','cowork-os.js','conversations.js','app.js']){
  const source=fs.readFileSync(path.join(__dirname,'../web',file),'utf8').replace(/\nboot\(\);\s*$/,'');
  vm.runInContext(source,context);
}
vm.runInContext(`
const fixture=(id,demo=false)=>({id,title:'测试发行人 '+id,period:'2026-06-30',mode:'financial',demo,updated_at:'2026-09-14T01:00:00Z',
  original_id:null,document:null,files:[],changes:[],coverage:{},messages:[],history:[],job:{status:'idle'},targets:[],
  stats:{changes:0,pending:0,needs_review:1,awaiting_agent:10,original_todos:1,total:12,scanned:0,layout_tasks:0,sources:0,accepted:0}});
S.p=fixture('p1');S.projects=[S.p];S.runtime={ready:false};S.storage={};CO.ready=true;
let writes=0,renders=0;api=async(path,options={})=>{if(options.method==='POST'){writes++;throw Error('Unexpected project write')}return {};};render=()=>{renders++};toast=()=>{};CO.refreshed=Date.now();
const scan={id:'scan',target_id:'t1',origin:'scan',status:'needs_review',version:1,before:'金额1',after:'【待核对：金额1】',sources:[],created_at:'2026-09-14T01:00:00Z'};
S.p.changes=[scan];CO.summaries.set('p1',coSummarize(S.p));
assert.equal(coMails().length,0,'Unprocessed scans must never appear as completed AI work');
const actual={...scan,id:'change',origin:'agent',status:'pending',after:'金额2',sources:[{source_id:'source'}]};
S.p.changes.push(actual);S.p.stats.changes=1;S.p.stats.pending=1;
CO.summaries.set('p1',coSummarize(S.p));
const first=coMails()[0];assert.equal(first.project.result.count,1);assert.equal(coUnread(),1);
CO.read[first.id]=true;assert.equal(coUnread(),0);
actual.version=2;CO.summaries.set('p1',coSummarize(S.p));assert.equal(coUnread(),1,'A new revision must be visible even if the old result was read');
const demo=fixture('demo',true);demo.changes=[actual];CO.summaries.set('demo',coSummarize(demo));
assert.equal(coProjects().length,1,'Demo projects must be excluded from the working overview');
S.p.changes=[{...actual,origin:'human'}];CO.summaries.set('p1',coSummarize(S.p));assert.equal(coMails().length,0,'Human edits must not be attributed to AI');
S.p.changes=[{...actual,status:'rejected'}];CO.summaries.set('p1',coSummarize(S.p));assert.equal(coMails().length,0,'Rejected suggestions are not delivered drafts');
S.p.job={status:'failed',error:'工具无法执行 <script>'};CO.summaries.set('p1',coSummarize(S.p));
const failure=coMails()[0];assert.equal(failure.type,'attention');assert.ok(coMailDetail(failure).includes('&lt;script&gt;'));
assert.ok(!coMailDetail(failure).includes('原文审核通过'));
const home=coHome();assert.ok(home.includes('co-request-form'));assert.ok(!home.includes('id="chat-input"'));
S.tab='chat';const conversation=coProjectPanel();assert.ok(conversation.includes('co-conversation-page'));assert.ok(!conversation.includes('co-document editor'));
S.p.document={blocks:[]};const workspace=coProjectPanel();assert.equal((workspace.match(/id="chat-input"/g)||[]).length,1);
assert.ok(workspace.indexOf('co-document editor')<workspace.indexOf('co-cowork '),'Document precedes Cowork');
const layoutBefore=S.p.document;S.p.document={blocks:[],layout_tasks:[{target_id:'table1',text:'确认报告期列'}]};
S.p.changes=[{...actual,id:'sourced',status:'pending',review_stage:'pending'},
{...actual,id:'missing',target_id:'missing1',sources:[],status:'needs_review',review_stage:'missing_source'},
{...scan,review_stage:'awaiting_agent'},{...actual,id:'human',target_id:'human1',origin:'human',sources:[],status:'accepted',review_stage:'accepted'}];
S.p.stats={...S.p.stats,changes:2,needs_review:1,missing_source:1,awaiting_agent:1,accepted:1,layout_tasks:1,sources:2};
const stats=coDocumentStats(S.p);assert.ok(stats.includes('处有来源修改'));assert.ok(stats.includes('处人工修改'));assert.ok(stats.includes('张表结构待处理'));
S.queue='sourced';assert.ok(renderQueue().includes('data-id="t1"'));assert.ok(!renderQueue().includes('data-id="human1"'));
S.queue='missing_source';assert.ok(renderQueue().includes('data-id="missing1"'));assert.ok(!renderQueue().includes('data-id="t1"'));
S.queue='layout';assert.ok(renderQueue().includes('data-id="table1"'));S.p.document=layoutBefore;
S.tab='source';assert.ok(!coProjectPanel().includes('id="chat-input"'));
assert.ok(coAutomations().includes('自动执行待接入'));assert.ok(coConnectionsPage().includes('待接入'));
assert.ok(coConnectionsPage().includes('需要检查'),'Runtime availability must use the actual runtime state');
assert.equal(writes,0);
`,context);
// Saving a proactive plan only stores an explicit local draft; it does not invoke the agent.
const event={target:{id:'co-plan-form',data:{recipe:'financial',title:'财报更新提醒',project:'p1',trigger:'每天检查',time:'09:00',weekday:'周一',result:'章节影响清单'}},preventDefault(){},stopImmediatePropagation(){}};
for(const handler of handlers.submit)handler(event);
assert.equal(JSON.parse(saved['bond-cowork-plans'])[0].status,'draft');
vm.runInContext("assert.equal(writes,0);assert.equal(CO.page,'inbox');assert.equal(CO.inboxTab,'automations');",context);
console.log('PASS: Inbox provenance, revision unread state, demo separation, document/Cowork layout, truthful connectors, and non-executing automation drafts.');
