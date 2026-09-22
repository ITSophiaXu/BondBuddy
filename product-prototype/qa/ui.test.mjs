import { materialStudio } from '../public/material-studio.js';
import { projectWorkspace } from '../public/project-workspace.js';
import { SCOPE_NAMES } from '../public/markets.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ROOT } from '../lib/platform.mjs';
import { accountUI } from '../public/account.js';
import { phoneAuthUI } from '../public/phone-auth.js';
import { reportingPeriods } from '../public/reporting-periods.js';
import { querySourcesUI } from '../public/query-sources.js';
import { pointCapacity } from '../public/usage-copy.js';
import { libraryUI } from '../public/library.js';
import { blueprintEligibility } from '../public/library-schema.js';
import { authoringUI } from '../public/authoring.js';
import * as projectFields from '../public/project-fields.js';
// Pure template and event-handler tests. No browser or UI automation is used.
const code=(await readFile(join(ROOT,'public','app.js'),'utf8')).replace(/^import[^\n]+\n/gm,'').replace('void init();','')+'\nglobalThis.ui={state,sidebar,dashboard,workflow,chat,features,authUI,navigate,workspace,addFiles};';
const nodes=new Map(),listeners={};
const document={body:{classList:{toggle(){}}},querySelectorAll:()=>[],querySelector:s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',value:'',dataset:{},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},classList:{remove(){},toggle(){}}});return nodes.get(s);},addEventListener:(type,fn)=>listeners[type]=fn};
const requests=[],order={id:randomUUID(),type:'recharge',credits:5000,status:'pending',amount:5000,mode:'sandbox',createdAt:new Date().toISOString(),lines:[{credits:5000}]};
const context={materialStudio:options=>materialStudio({...options,document,location:context.location}),uploadMultipart:async(path,body,{onProgress=()=>{}}={})=>{onProgress({percent:100,transferred:true});const response=await context.fetch(path,{method:'POST',body});return response.json();},SCOPE_NAMES,projectWorkspace:options=>projectWorkspace({...options,document,location:context.location}),...projectFields,blueprintEligibility,libraryUI:options=>libraryUI({...options,document,location:context.location}),authoringUI,pointCapacity,reportingPeriods,querySourcesUI:options=>querySourcesUI({...options,document}),accountUI:options=>accountUI({...options,document,location:context.location}),phoneAuthUI:options=>phoneAuthUI({...options,document}),document,location:{hash:'#dashboard'},localStorage:{getItem(){return null},setItem(){}},window:{addEventListener(){},scrollTo(){}},setTimeout,clearTimeout,crypto:{randomUUID},URL,URLSearchParams,Date,FormData,fetch:async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/billing'?context.ui.state.billing:{order}};}};vm.createContext(context);vm.runInContext(code,context);
const {ui}=context;ui.state.health={authoringVersion:2,projectInputVersion:3,materialStudioVersion:1};
ui.state.billing={creditVersion:'2026-09-22-v1.1',mode:'sandbox',seat:{id:'primary',quota:{active:true,plan:'credits',externalData:true,legacy:{active:false}}},wallet:{available:2000,paid:0,reward:2000,frozen:0,spent:0,expiring:0,lots:[]},packs:[{cny:50,paid_credits:5000},{cny:500,paid_credits:52500},{cny:2000,paid_credits:220000},{cny:10000,paid_credits:1150000}],invitation:{code:'ABC123',invited:0,pending:0},activity:{today:0,monthlyReward:0},ledger:[],orders:[]};ui.state.health.oneClickExecution=true;
ui.state.user={id:'primary',phoneMasked:'138****8000'};
test('home focuses on results and four task entries, with Q&A beside material generation',()=>{
  const home=ui.dashboard();assert(!home.includes('id="chat-form"'));assert(!home.includes('id="chat-prompt"'));assert(!home.includes('home-dialogue'));assert(!home.includes('task-starters'));assert(!home.includes('新建项目'));assert(!home.includes('新建募集书项目'));assert(home.includes('已更新募集书'));assert(home.includes('已复核募集书'));assert(home.includes('已完成对话'));assert(home.includes('最近项目'));assert.equal((home.match(/class="workflow-card"/g)||[]).length,4);assert(home.includes('href="#qa"'));assert(home.indexOf('href="#generate"')<home.indexOf('href="#qa"'));ui.sidebar();const nav=nodes.get('#sidebar').innerHTML;assert(!nav.includes('#knowledge'));assert(nav.includes('#generate'));assert(nav.includes('#qa'));assert(nav.includes('材料生成'));assert(nav.includes('项目问答'));assert(nav.includes('#billing'));assert(!nav.includes('#connectors'));assert(!nav.includes('#settings'));assert(!nodes.get('#topbar').innerHTML.includes('#settings'));
});
test('workflow starts directly, includes external sources, and keeps required Word rules',()=>{
  for(const kind of ['update','review']){ui.state.route=kind;ui.state.step=2;const html=ui.workflow(kind);assert(html.includes(kind==='update'?'开始更新':'开始复核'));assert(html.includes('上传材料免费'));assert(!html.includes('确认点数'));assert(!html.includes('data-action="query-sources"'));assert(!html.includes('read-knowledge'));assert(html.includes('DOCX'));assert(!html.includes('type="date"'));}
});
test('both workflows show the full rolling window when offering or latest period changes',()=>{
  for(const kind of ['update','review']){
    ui.state.route=kind;ui.state.step=1;ui.workflow(kind);
    Object.assign(ui.state.drafts[kind],{offering:'private',year:'2026',quarter:'06-30'});
    let html=ui.workflow(kind);assert(html.includes('两年一期'));assert(html.includes('2024年度'));assert(html.includes('2025年度'));assert(html.includes('2026年1—6月'));assert(!html.includes('2023年度'));
    ui.state.drafts[kind].offering='public';html=ui.workflow(kind);assert(html.includes('三年一期'));assert(html.includes('2023年度'));assert(!html.includes('name="investor"'));assert(!html.includes('投资者范围'));
    ui.state.drafts[kind].quarter='12-31';html=ui.workflow(kind);assert(html.includes('2026年度'));assert(!html.includes('2026年1—12月'));assert(!html.includes('2023年度'));
  }
});
test('queries need no modal confirmation, and only a missing company name requires input',async()=>{
  const oldQuota=ui.state.billing.seat.quota;ui.state.billing.seat.quota={...oldQuota,active:true,plan:'professional'};ui.state.route='qa';ui.state.connectors=[];ui.state.chatDraft='请查询公司债兑付情况';
  let html=ui.chat();assert(!html.includes('data-action="query-sources"'));assert(html.includes('id="chat-query-subject" class="chat-query-subject" hidden'));
  ui.state.connectors=[{id:'wind-test',name:'Wind',purpose:'bonds',enabled:true}];
  html=ui.chat();assert(html.includes('id="auto-query-status" hidden'));assert(!html.includes('按需查询，回答附来源'));assert(!html.includes('id="chat-query-subject" class="chat-query-subject" hidden'));
  const click=(action,value)=>listeners.click({target:{closest:selector=>selector==='[data-action]'?{dataset:{action,value}}:null}});
  await click('chat-suggestion','请查询公司债兑付情况');assert.equal(nodes.get('#chat-prompt').value,'请查询公司债兑付情况');assert.equal(nodes.get('#chat-prompt').focused,true);assert.equal(nodes.get('#chat-query-subject').hidden,false);assert.equal(nodes.get('#query-issuer').required,true);assert.equal(nodes.get('#auto-query-status').hidden,true);
  ui.state.connectors=[];await click('chat-suggestion','请查询公司债兑付情况');assert.equal(nodes.get('#auto-query-status').hidden,false);assert(nodes.get('#auto-query-status').innerHTML.includes('查询服务暂不可用'));
  await click('chat-suggestion','帮我起草项目说明书');assert.equal(nodes.get('#auto-query-status').hidden,true);assert.equal(nodes.get('#auto-query-status').innerHTML,'');
  ui.state.jobs=[{id:'project1',kind:'review',context:{issuer:'测试发行人'}}];ui.state.projectId='project1';
  html=ui.chat();assert(html.includes('id="chat-query-subject" class="chat-query-subject" hidden'));
  ui.state.connectors=[];ui.state.chatDraft='';ui.state.projectId='';ui.state.jobs=[];ui.state.billing.seat.quota=oldQuota;
});

test('conversation starters fill an editable prompt; active conversations retain messages, attachments and one new-chat action',async()=>{
  ui.state.route='generate';ui.state.jobs=[];ui.state.conversationId='';ui.state.chatDraft='';
  const start=ui.chat();assert.equal((start.match(/data-action="chat-suggestion"/g)||[]).length,12);assert(start.includes('is-start'));assert.equal((start.match(/class="starter-category"/g)||[]).length,3);assert(start.indexOf('task-starters')>start.indexOf('</form>'));
  const prompt=start.match(/data-action="chat-suggestion" data-value="([^"]+)"/)[1];const requestCount=requests.length;
  await listeners.click({target:{closest:selector=>selector==='[data-action]'?{dataset:{action:'chat-suggestion',value:prompt}}:null}});
  assert.equal(ui.state.chatDraft,prompt);assert.equal(nodes.get('#chat-prompt').value,prompt);assert.equal(requests.length,requestCount);
  ui.state.conversationId='chat-one';ui.state.projectId='project1';ui.state.queryIssuer='上一个发行人';ui.state.files.generate=[{file:{name:'说明.txt',size:20}}];
  ui.state.jobs=[{id:'message1',kind:'generate',conversationId:'chat-one',projectId:'project1',prompt:'整理项目资料',title:'整理项目资料',status:'generating',progress:'正在处理'}];
  const active=ui.chat();assert(active.includes('has-conversation'));assert(!active.includes('chat-suggestion'));assert(active.includes('整理项目资料'));assert(active.includes('说明.txt'));assert(active.includes('停止生成'));assert(active.includes('required disabled'));assert.equal((active.match(/data-action="new-conversation"/g)||[]).length,1);
  context.location.hash='#generate';await listeners.click({target:{closest:selector=>selector==='[data-action]'?{dataset:{action:'new-conversation'}}:null}});
  assert.equal(ui.state.queryIssuer,'');assert.equal(ui.state.projectId,'');assert.equal(ui.state.chatDraft,'');assert.equal(ui.state.files.generate.length,0);assert(nodes.get('#main').innerHTML.includes('material-studio-form'));
  ui.state.jobs=[];ui.state.route='dashboard';
});
test('Q&A opens directly, submits and continues a conversation, and starts a new one within Q&A',async()=>{
  const previousFetch=context.fetch,sent=[],jobs=[];
  const form={id:'chat-form',querySelector:()=>({disabled:false}),querySelectorAll:()=>[]};
  context.fetch=async(path,options)=>{
    if(path==='/api/tasks'){
      if(options?.method==='POST'){
        sent.push(options.body);
        const job={id:'qa-turn-'+sent.length,kind:'generate',conversationId:'qa-thread',title:'偿债能力分析',prompt:options.body.get('prompt'),status:'queued',progress:'排队中',downloads:[]};
        jobs.unshift(job);return {ok:true,json:async()=>({job})};
      }
      return {ok:true,json:async()=>({jobs})};
    }
    return previousFetch(path,options);
  };
  try{
    ui.state.jobs=[];ui.state.chatDraft='';ui.state.conversationId='old-chat';context.location.hash='#qa';await ui.navigate();
    assert.equal(ui.state.route,'qa');assert.equal(ui.state.conversationId,'');
    const html=nodes.get('#main').innerHTML;assert(html.includes('<h1>项目问答</h1>'));assert(html.includes('输入你的问题'));assert(html.includes('材料解读'));assert(html.includes('查全部公司债兑付'));assert.equal((html.match(/data-action="chat-suggestion"/g)||[]).length,12);
    ui.state.chatDraft='请分析偿债能力';
    await listeners.submit({preventDefault(){},target:form});
    assert.equal(sent.length,1);assert.equal(sent[0].get('kind'),'generate');assert.equal(sent[0].get('conversationId'),'');assert.equal(sent[0].get('queryMode'),'auto');assert.equal(context.location.hash,'qa/qa-thread');
    context.location.hash='#qa/qa-thread';await ui.navigate();assert(nodes.get('#main').innerHTML.includes('请分析偿债能力'));assert(nodes.get('#main').innerHTML.includes('required disabled'));
    jobs[0].status='complete';ui.state.details[jobs[0].id]={...jobs[0],result:{answer:'已分析项目材料。'}};await ui.navigate();assert(nodes.get('#main').innerHTML.includes('已分析项目材料。'));
    ui.state.chatDraft='再解释一下现金流';await listeners.submit({preventDefault(){},target:form});assert.equal(sent[1].get('conversationId'),'qa-thread');assert.equal(ui.state.route,'qa');
    context.location.hash='#qa/qa-thread';await listeners.click({target:{closest:selector=>selector==='[data-action]'?{dataset:{action:'new-conversation'}}:null}});
    assert.equal(context.location.hash,'qa');assert.equal(ui.state.conversationId,'');assert.equal(ui.state.chatDraft,'');
    context.location.hash='#generate';await ui.navigate();assert(nodes.get('#main').innerHTML.includes('<h1>材料生成</h1>'));assert(nodes.get('#main').innerHTML.includes('要生成哪份材料'));
  }finally{context.fetch=previousFetch;ui.state.jobs=[];ui.state.details={};ui.state.conversationId='';ui.state.chatDraft='';ui.state.route='dashboard';}
});
test('wallet shows unified credits, four packs, rewards and no subscription gates',()=>{
 const html=ui.features.billingPage();for(const text of ['5,000','52,500','220,000','1,150,000','积分流水','每日','邀请','演示充值','不设有效期'])assert(html.includes(text),text);
 assert(!html.includes('开通套餐'));assert(!html.includes('确认点数'));ui.sidebar();assert(nodes.get('#topbar').innerHTML.includes('2,000'));assert(nodes.get('#topbar').innerHTML.includes('充值积分'));
});

test('recharge creates one server-priced order and retains a payment confirmation',async()=>{
 await ui.features.click('recharge','50',{disabled:false});assert(context.location.hash.includes('payment/'));
 const sent=JSON.parse(requests.find(r=>r.path==='/api/billing/orders').options.body);assert.equal(sent.type,'recharge');assert.equal(sent.amountCny,50);assert(!sent.credits);
 const html=await ui.features.paymentPage(order.id);assert(html.includes('确认演示支付'));assert(!html.includes('checkbox'));
});

test('phone registration has just a phone and demo code; guest routes open the login form',async()=>{
  const html=ui.authUI.page();assert(html.includes('id="auth-phone"'));assert(html.includes('id="auth-code"'));assert(html.includes('新手机号自动注册'));assert(html.includes('不会发送短信'));assert(!html.includes('type="password"'));assert(!html.includes('type="email"'));
  ui.state.user=null;context.location.hash='#billing';await ui.navigate();assert.equal(ui.state.route,'login');assert.equal(ui.state.returnTo,'billing');assert(nodes.get('#main').innerHTML.includes('phone-auth-form'));ui.state.user={id:'primary',phoneMasked:'138****8000'};
});
test('task and project text are escaped in templates',()=>{
  ui.state.jobs=[{id:'project-safe',kind:'review',title:'<script>alert(1)</script>'}];assert(ui.dashboard().includes('&lt;script&gt;'));ui.state.jobs=[];ui.state.route='qa';ui.state.chatDraft='<img src=x>';assert(ui.chat().includes('&lt;img src=x&gt;'));
});

test('update restores expanded optional fields while review stays focused on its three checks',async()=>{
  ui.state.route='update';ui.state.step=1;ui.state.drafts={};
  let html=ui.workflow('update');
  assert(html.includes('是否有本发行人的历史募集书'));assert(html.includes('>有</label>'));assert(html.includes('>没有</label>'));
  for(const text of ['蓝图','相似企业','发行人补充资料','品种一 ·','品种二 ·','这次希望更新什么','更新范围','name="dataUpdate"','name="updateYears"','name="sourceScope"','name="majorRestructuring"','name="investorProtection"','name="protectionTerms"'])assert(!html.includes(text),text);
  assert.equal((html.match(/data-optional-group="\d+" open/g)||[]).length,projectFields.OPTIONAL_GROUPS.length);assert(html.includes('name="purposeCategory"'));assert(!html.includes('data-action="project-topic"'));assert(!html.includes('更多信息，边聊边补充'));assert(html.includes('授信总额50亿元'));assert(html.includes('更新整份募集书'));
  for(const name of projectFields.FUNDING_PURPOSES)assert(html.includes(name));assert(html.includes('土地证书'));assert(html.includes('相关许可证'));
  assert(html.includes('普通私募公司债'));assert(html.includes('小公募'));assert(html.includes('大公募'));
  await listeners.change({target:{name:'exchange',value:'nafmii',id:'exchange',closest:()=>true,dataset:{}}});
  html=ui.workflow('update');for(const name of ['PPN','MTN','CP','SCP','ABN','ABCP','PRN'])assert(html.includes(name));assert(!html.includes('SPN'));assert(!html.includes('注册模式'));assert(!html.includes('DFI'));assert.equal(ui.state.drafts.update.offering,'ppn');
  ui.sidebar();assert(!nodes.get('#sidebar').innerHTML.includes('募集书库'));assert(!nodes.get('#sidebar').innerHTML.includes('href="#library"'));
  ui.state.route='review';ui.state.step=1;const review=ui.workflow('review');assert(review.includes('project-message-form'));for(const value of ['data-optional-group','name="purposeCategory"','name="trancheTerms"','name="underwritingArrangements"','更多信息，边聊边补充','data-action="project-topic"'])assert(!review.includes(value),value);for(const value of ['财务数据核对','合规与格式检查','公开信息核验','补充核验线索或特别关注事项'])assert(review.includes(value),value);
  ui.state.route='dashboard';
});

test('project form creates before uploading then executes once without a price confirmation',async()=>{
  const previous=context.fetch,sent=[];
  const job={id:'project-estimate',kind:'update',context:{},files:[{key:'saved-file',filename:'原稿.docx',role:'historical',size:20}],quote:{id:'quote-one',points:7,expiresAt:'2026-12-31T00:00:00Z',reasons:[{label:'跨品种调整',points:7,detail:'测试评估'}],warnings:[]}};
  context.fetch=async(path,options)=>{
    if(path==='/api/projects'||path.startsWith('/api/projects/')){sent.push({path,options});return {ok:true,json:async()=>({job})};}
    if(path==='/api/tasks')return {ok:true,json:async()=>({jobs:[]})};return previous(path,options);
  };
  try{
    ui.state.route='update';ui.state.step=1;ui.state.drafts={};ui.workflow('update');Object.assign(ui.state.drafts.update,{title:'测试项目',issuer:'本次发行人',authoringMode:'historical',exchange:'sse',offering:'private',dataUpdate:'none',updateYears:'10',sourceScope:'nafmii-mtn',registrationMode:'dfi'});
    ui.state.files.update=[{role:'historical',file:new File(['原稿'],'原稿.docx')},{role:'audit',file:new File(['财务报表及附注'],'审计报告.txt')}];
    const form={id:'workflow-form',reportValidity:()=>true};
    await ui.workspace.submit(form);assert.equal(stateStep(),2);assert.equal(sent[0].path,'/api/projects');assert.equal(sent.length,1);for(const key of ['dataUpdate','updateYears','sourceScope','registrationMode','conversationDrafts','conversationTopic'])assert(!(key in JSON.parse(sent[0].options.body)));
    ui.workspace.input({id:'project-message',value:'截至2026年6月末，银行授信总额50亿元，已使用30亿元，未使用20亿元。'});
    await ui.workspace.submit(form);assert.equal(stateStep(),2);assert.equal(sent[1].path,'/api/projects/project-estimate/execute');assert.equal(JSON.parse(sent[1].options.body.get('projectMessages'))[0].text,'截至2026年6月末，银行授信总额50亿元，已使用30亿元，未使用20亿元。');assert(sent[1].options.body.has('historical'));
    assert.equal(sent.length,2);assert.equal(ui.state.files.update.length,0);assert.equal(context.location.hash,'task/project-estimate');assert(!sent.some(r=>r.path.endsWith('/start')));
  }finally{context.fetch=previous;ui.state.route='dashboard';ui.state.drafts={};ui.state.files.update=[];}
  function stateStep(){return ui.state.step;}
});

test('a conversational requirement after assessment invalidates the displayed quote and returns to material review',async()=>{
  ui.state.route='review';ui.state.step=3;ui.state.drafts={};ui.workflow('review');ui.state.drafts.review.assessment={quote:{id:'old',points:4}};
  document.querySelector('#project-message').value='请重点核对有息债务';
  await ui.workspace.submit({id:'project-message-form'});
  assert.equal(ui.state.drafts.review.assessment,undefined);assert.equal(ui.state.step,2);assert.equal(ui.state.drafts.review.projectMessages[0].text,'请重点核对有息债务');
  ui.state.route='dashboard';ui.state.drafts={};
});

test('old backend cannot submit the new fields without full-document support',async()=>{
  const prior=ui.state.health;ui.state.health={authoringVersion:2};ui.state.route='update';ui.state.step=1;
  const html=ui.workflow('update');assert(html.includes('等待服务重启'));assert(html.includes('id="start-task" disabled'));
  const requestCount=requests.length;await assert.rejects(ui.workspace.submit({id:'workflow-form',reportValidity:()=>true}),/重启/);assert.equal(requests.length,requestCount);
  ui.state.health=prior;ui.state.route='dashboard';
});

test('legacy scope controls cannot survive a resumed draft, and conversation shortcuts preserve typed input',async()=>{
  ui.state.route='update';ui.state.step=1;ui.state.drafts={};ui.workflow('update');
  Object.assign(ui.state.drafts.update,{updateMode:undefined,dataUpdate:'none',updateYears:'1',sourceScope:'sse-private',assessment:{quote:{id:'old',points:2}},purpose:'项目建设',protectionTerms:'按已签协议落实保护安排'});
  ui.state.step=3;const html=ui.workflow('update');
  assert.equal(ui.state.step,2);assert.equal(ui.state.drafts.update.assessment,undefined);assert.equal(ui.state.drafts.update.updateMode,'full');
  assert.equal(ui.state.drafts.update.purpose,'项目建设');assert.equal(ui.state.drafts.update.purposeCategory,'项目建设');assert(ui.state.drafts.update.reviewNotes.includes('按已签协议落实保护安排'));
  for(const key of ['dataUpdate','updateYears','sourceScope','protectionTerms'])assert(!(key in ui.state.drafts.update));
  assert(html.includes('开始更新'));
  ui.workspace.input({id:'project-message',value:'已经填写的发行安排'});await ui.workspace.click('project-prompt','授信情况');
  assert(document.querySelector('#project-message').value.startsWith('已经填写的发行安排'));assert(document.querySelector('#project-message').value.includes('未使用'));
  ui.state.route='dashboard';ui.state.drafts={};
});
