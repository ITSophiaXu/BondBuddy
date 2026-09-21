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
const code=(await readFile(join(ROOT,'public','app.js'),'utf8')).replace(/^import[^\n]+\n/gm,'').replace('void init();','')+'\nglobalThis.ui={state,sidebar,dashboard,workflow,chat,features,authUI,navigate,library,addFiles};';
const nodes=new Map(),listeners={};
const document={body:{classList:{toggle(){}}},querySelectorAll:()=>[],querySelector:s=>{if(!nodes.has(s))nodes.set(s,{innerHTML:'',value:'',dataset:{},focus(){this.focused=true;},showModal(){this.open=true;},close(){this.open=false;},classList:{remove(){},toggle(){}}});return nodes.get(s);},addEventListener:(type,fn)=>listeners[type]=fn};
const requests=[],order={id:randomUUID(),type:'subscription',status:'pending',amount:49900,mode:'sandbox',createdAt:new Date().toISOString(),lines:[{plan:'personal'}]};
const context={...projectFields,blueprintEligibility,libraryUI:options=>libraryUI({...options,document,location:context.location}),authoringUI,pointCapacity,reportingPeriods,querySourcesUI:options=>querySourcesUI({...options,document}),accountUI:options=>accountUI({...options,document,location:context.location}),phoneAuthUI:options=>phoneAuthUI({...options,document}),document,location:{hash:'#dashboard'},localStorage:{getItem(){return null},setItem(){}},window:{addEventListener(){},scrollTo(){}},setTimeout,clearTimeout,crypto:{randomUUID},URL,URLSearchParams,Date,FormData,fetch:async(path,options)=>{requests.push({path,options});return {ok:true,json:async()=>path==='/api/billing'?context.ui.state.billing:{order}};}};vm.createContext(context);vm.runInContext(code,context);
const {ui}=context;
ui.state.billing={seat:{id:'primary',name:'测试',email:'test@example.com',quota:{active:false,plan:null,limit:{qa:0,documents:0,points:0},available:{qa:0,documents:0,points:0},used:{qa:0,documents:0,points:0},reserved:{qa:0,documents:0,points:0}}},plans:[{id:'personal',name:'个人版',price:49900,qa:1000,documents:40,points:4},{id:'professional',name:'专业版',price:99900,qa:2000,documents:80,points:12}],seats:[{id:'primary',name:'测试',email:'test@example.com',plan:null}],orders:[],rules:{cycle:'按月重置',documents:'每文件一个单元'}};
ui.state.user={id:'primary',phoneMasked:'138****8000'};
test('home focuses on results and four task entries, with Q&A beside material generation',()=>{
  const home=ui.dashboard();assert(!home.includes('id="chat-form"'));assert(!home.includes('id="chat-prompt"'));assert(!home.includes('home-dialogue'));assert(!home.includes('task-starters'));assert(!home.includes('新建项目'));assert(!home.includes('新建募集书项目'));assert(home.includes('已更新募集书'));assert(home.includes('已复核募集书'));assert(home.includes('已完成对话'));assert(home.includes('最近项目'));assert.equal((home.match(/class="workflow-card"/g)||[]).length,4);assert(home.includes('href="#qa"'));assert(home.indexOf('href="#generate"')<home.indexOf('href="#qa"'));ui.sidebar();const nav=nodes.get('#sidebar').innerHTML;assert(!nav.includes('#knowledge'));assert(nav.includes('#generate'));assert(nav.includes('#qa'));assert(nav.includes('材料生成'));assert(nav.includes('项目问答'));assert(nav.includes('#billing'));assert(!nav.includes('#connectors'));assert(!nav.includes('#settings'));assert(!nodes.get('#topbar').innerHTML.includes('#settings'));
});
test('workflow previews task cost, includes external sources, and keeps required Word rules',()=>{
  for(const kind of ['update','review']){ui.state.route=kind;ui.state.step=2;const html=ui.workflow(kind);assert(html.includes(kind==='update'?'4 点':'1 点'));assert(html.includes('直接上传材料即可'));assert(!html.includes('data-action="query-sources"'));assert(!html.includes('read-knowledge'));assert(html.includes('DOCX'));assert(!html.includes('type="date"'));}
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
  assert.equal(ui.state.queryIssuer,'');assert.equal(ui.state.projectId,'');assert.equal(ui.state.chatDraft,'');assert.equal(ui.state.files.generate.length,0);assert(nodes.get('#main').innerHTML.includes('is-start'));
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
    context.location.hash='#generate';await ui.navigate();assert(nodes.get('#main').innerHTML.includes('<h1>材料生成</h1>'));assert(nodes.get('#main').innerHTML.includes('描述要生成的材料'));
  }finally{context.fetch=previousFetch;ui.state.jobs=[];ui.state.details={};ui.state.conversationId='';ui.state.chatDraft='';ui.state.route='dashboard';}
});
test('plans and add-ons explain different allowances and show what points can buy',()=>{
  let html=ui.features.billingPage();for(const text of ['¥499','¥999','1,000','2,000','40','80','4 点募集书额度','12','¥299','不会收取费用','更新 1 份','复核 1 份','4 + 1 = 5 点','在对话中上传文件','专业版专享 · 外部数据查询','企查查 / 工商','企业预警通','Wind'])assert(html.includes(text),text);
  assert(!html.includes('type="email"'));assert(!html.includes('seat-name'));assert(!html.includes('add-seat'));assert(!html.includes('实名'));assert(!html.includes('对话附件处理'));assert(!html.includes('音频转写'));assert(!html.includes('OCR'));assert(!html.includes('两档功能相同'));assert(!html.includes('配置'));assert(html.includes('两档均支持募集书更新、复核、材料起草与分析'));assert(html.includes('不含工商、债券等外部数据库查询'));assert(html.includes('包含个人版全部能力'));
  assert(html.indexOf('id="plan-options"')<html.indexOf('class="addon-banner"'));assert(!ui.dashboard().includes('data-action="buy-addon"'));ui.sidebar();assert(nodes.get('#topbar').innerHTML.includes('开通套餐'));assert(!nodes.get('#topbar').innerHTML.includes('data-action="buy-addon"'));
  const original=ui.state.billing.seat.quota;ui.state.billing.seat.quota={...original,active:true,plan:'personal',endsAt:'2026-10-18T00:00:00.000Z',available:{qa:900,documents:30,points:4}};
  html=ui.features.billingPage();assert(html.includes('可更新 1 次，或复核 4 次'));assert(html.includes('加购 4 点'));assert(html.includes('与本期套餐一起到期'));
  assert(html.indexOf('id="plan-options"')<html.indexOf('class="addon-banner"'));assert(html.indexOf('id="plan-options"')<html.indexOf('<details'));assert(!html.includes('<summary>查看套餐对比</summary>'));assert(!ui.dashboard().includes('data-action="buy-addon"'));assert(!ui.dashboard().includes('purchase-bar'));ui.sidebar();const topbar=nodes.get('#topbar').innerHTML,topbarText=topbar.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ');assert(topbarText.includes('剩余额度 4 点'));assert(!topbarText.includes('点/份'));assert(topbar.includes('套餐与用量'));assert(topbar.includes('¥299 / 4 点'));assert.equal((topbar.match(/data-action="buy-addon"/g)||[]).length,1);assert(!nodes.get('#sidebar').innerHTML.includes('sidebar-plan'));
  ui.state.billing.seat.quota=original;
});
test('choosing a plan goes straight to one confirmation button without checkboxes',async()=>{
  await ui.features.click('choose-plan','personal',{disabled:false});assert(context.location.hash.includes('payment/'));const sent=JSON.parse(requests.find(r=>r.path==='/api/billing/orders').options.body);assert.equal(sent.plan,'personal');assert(!sent.seats);assert(!sent.name);assert(!sent.email);
  const html=await ui.features.paymentPage(order.id);assert(html.includes('确认演示支付 · ¥499'));assert.equal((html.match(/type="submit"/g)||[]).length,1);assert(!html.includes('type="checkbox"'));assert(!html.includes('type="email"'));
});
test('phone registration has just a phone and demo code; guest routes open the login form',async()=>{
  const html=ui.authUI.page();assert(html.includes('id="auth-phone"'));assert(html.includes('id="auth-code"'));assert(html.includes('新手机号自动注册'));assert(html.includes('不会发送短信'));assert(!html.includes('type="password"'));assert(!html.includes('type="email"'));
  ui.state.user=null;context.location.hash='#billing';await ui.navigate();assert.equal(ui.state.route,'login');assert.equal(ui.state.returnTo,'billing');assert(nodes.get('#main').innerHTML.includes('phone-auth-form'));ui.state.user={id:'primary',phoneMasked:'138****8000'};
});
test('task and project text are escaped in templates',()=>{
  ui.state.jobs=[{id:'project-safe',kind:'review',title:'<script>alert(1)</script>'}];assert(ui.dashboard().includes('&lt;script&gt;'));ui.state.jobs=[];ui.state.route='qa';ui.state.chatDraft='<img src=x>';assert(ui.chat().includes('&lt;img src=x&gt;'));
});

test('authoring fields are optional, submission waits for the third step, and inactive primary files are not sent',async()=>{
  const previousFetch=context.fetch,previousDrafts=ui.state.drafts,previousFiles=ui.state.files.update;
  let submitted;
  context.fetch=async(path,options)=>{
    if(path==='/api/tasks'&&options?.method==='POST'){submitted=options.body;return {ok:true,json:async()=>({job:{id:'new-reference'}})};}
    if(path==='/api/tasks')return {ok:true,json:async()=>({jobs:[]})};
    if(path==='/api/health')return {ok:true,json:async()=>({authoringVersion:1,libraryVersion:1})};
    return previousFetch(path,options);
  };
  try{
    ui.state.drafts={};ui.state.route='update';ui.state.step=1;
    const initial=ui.workflow('update');assert(!initial.includes('value="reference" checked'));assert(!initial.includes('value="historical" checked'));
    for(const name of ['title','issuer','exchange','offering','year','quarter'])assert(new RegExp('name="'+name+'"[^>]*required').test(initial),name);
    for(const f of projectFields.OPTIONAL_FIELDS)assert(!new RegExp('name="'+f.key+'"[^>]*required').test(initial),f.key);
    Object.assign(ui.state.drafts.update,{title:'新项目',issuer:'本企业',authoringMode:'reference',hasRating:'否',issuerRating:'旧评级',bookrunner:'簿记管理人'});
    ui.state.files.update=[{role:'historical',file:new File(['own'],'本企业.docx')},{role:'reference',file:new File(['peer'],'同业.docx')},{role:'issuancePlan',file:new File(['plan'],'方案.txt')}];
    const form={id:'workflow-form',reportValidity:()=>true,querySelectorAll:()=>[]};
    await listeners.submit({preventDefault(){},target:form});assert.equal(ui.state.step,2);assert.equal(submitted,undefined);
    let html=nodes.get('#main').innerHTML;assert(html.includes('相似企业参考募集书'));assert(html.includes('本项目材料'));assert(html.includes('银行授信情况表'));assert(html.includes('章程、治理制度与组织架构'));
    await listeners.submit({preventDefault(){},target:form});assert.equal(ui.state.step,3);assert.equal(submitted,undefined);assert(nodes.get('#main').innerHTML.includes('尚未核验'));
    await listeners.submit({preventDefault(){},target:form});assert.equal(submitted.get('authoringMode'),'reference');assert.equal(submitted.get('bookrunner'),'簿记管理人');assert.equal(submitted.get('issuerRating'),'');assert.equal(submitted.has('historical'),false);assert.equal(submitted.has('reference'),true);assert.equal(submitted.has('issuancePlan'),true);assert.equal(ui.state.files.update.length,1);assert.equal(ui.state.files.update[0].role,'historical');
  }finally{context.fetch=previousFetch;ui.state.drafts=previousDrafts;ui.state.files.update=previousFiles;ui.state.route='dashboard';ui.state.step=1;}
});

test('an old running service cannot silently discard optional fields or misroute reference tasks',async()=>{
  const previousFetch=context.fetch,previousDrafts=ui.state.drafts,previousFiles=ui.state.files.update;let submitted=false;
  context.fetch=async(path,options)=>{if(path==='/api/health')return {ok:true,json:async()=>({version:'1.4.0'})};if(path==='/api/tasks'&&options?.method==='POST')submitted=true;return previousFetch(path,options);};
  try{
    ui.state.route='update';ui.state.drafts={};ui.state.step=1;ui.workflow('update');Object.assign(ui.state.drafts.update,{title:'项目',issuer:'发行人',authoringMode:'historical'});
    ui.state.files.update=[{role:'historical',file:new File(['old'],'历史稿.docx')}];ui.state.step=3;
    await listeners.submit({preventDefault(){},target:{id:'workflow-form',querySelectorAll:()=>[]}});
    assert.equal(submitted,false);assert.equal(ui.state.files.update.length,1);assert(nodes.get('#toast').textContent.includes('请先重启'));assert(ui.workflow('update').includes('重启前可填写信息和选择材料'));
  }finally{context.fetch=previousFetch;ui.state.drafts=previousDrafts;ui.state.files.update=previousFiles;ui.state.route='dashboard';ui.state.step=1;}
});

test('library browse renders real counts, official sources and escaped searchable entries',async()=>{
  const previousFetch=context.fetch,previousDrafts=ui.state.drafts;
  const entry={id:'a'.repeat(64),title:'<script>unsafe</script>募集书',issuer:'测试企业',market:'sse',instrument:'公司债券',offering:'public',projectStatus:'审核通过',sourceUrl:'https://bond.sse.com.cn/example',documentUrl:'https://static.sse.com.cn/example.pdf',file:{name:'稿.pdf',size:100},textReady:true,confirmedAt:'2026-07-01',publishedAt:'2026-06-30',version:'申报稿',verification:'个人已核对官方来源',visibility:'personal',warnings:[],chapters:[],match:{reasons:['行业相同'],differences:[],unknown:[]}};
  context.fetch=async path=>path.startsWith('/api/library')?{ok:true,json:async()=>({items:[entry],total:1,page:1,pages:1,stats:{total:1,ready:1,issuers:1,public:0},facets:{issuer:[entry.issuer],region:[]},sources:[{id:'sse',name:'上交所',url:entry.sourceUrl,count:1}]})}:previousFetch(path);
  try{ui.state.drafts={};ui.state.libraryId='';let html=await ui.library.page();assert(html.includes('募集书库'));assert(html.includes('library-search-form'));assert(html.includes('企业性质'));assert(html.includes('发行企业'));assert(html.includes('&lt;script&gt;unsafe'));assert(!html.includes('<script>unsafe'));assert(html.includes('本库已收录 1 份'));assert(html.includes('仅自己可见'));assert(html.includes('推荐相似募集书'));assert(!html.includes('library-project-context'));assert(!html.includes('library-target-form'));assert(!html.includes('未选择推荐项目'));assert(!html.includes('与本项目发行方式不同'));await ui.library.click('library-select-project');assert(nodes.get('#modal-content').innerHTML.includes('先填写项目信息'));nodes.get('#modal').close();ui.sidebar();assert(nodes.get('#sidebar').innerHTML.includes('href="#library"'));}
  finally{context.fetch=previousFetch;ui.state.drafts=previousDrafts;ui.library.reset();}
});

test('choosing a library blueprint retains target facts and support files and submits only its ID',async()=>{
  const previousFetch=context.fetch,previousDrafts=ui.state.drafts,previousFiles=ui.state.files.update;let submitted;
  const entry={id:'b'.repeat(64),title:'参考企业募集书',issuer:'另一个发行人',market:'sse',instrument:'公司债券',offering:'private',projectStatus:'审核通过',file:{name:'库内蓝图.pdf',size:100},textReady:true,confirmedAt:'2026-07-01',publishedAt:'2026-06-30',version:'申报稿'};
  context.fetch=async(path,options)=>{if(path==='/api/library/'+entry.id)return {ok:true,json:async()=>({item:entry})};if(path==='/api/health')return {ok:true,json:async()=>({authoringVersion:1,libraryVersion:1})};if(path==='/api/tasks'&&options?.method==='POST'){submitted=options.body;return {ok:true,json:async()=>({job:{id:'library-task'}})};}if(path==='/api/tasks')return {ok:true,json:async()=>({jobs:[]})};return previousFetch(path,options);};
  try{
    ui.state.drafts={};ui.state.route='update';ui.state.step=1;ui.workflow('update');Object.assign(ui.state.drafts.update,{title:'本企业项目',issuer:'本次发行人',size:'10亿元',authoringMode:'historical'});
    ui.state.files.update=[{role:'historical',file:new File(['own'],'本企业.docx')},{role:'reference',file:new File(['old'],'原参考.docx')},{role:'financial',file:new File(['own facts'],'财务.txt')}];
    await ui.library.click('library-use-draft');await ui.library.click('library-confirm-pick',entry.id);assert.equal(ui.state.drafts.update.issuer,'本次发行人');assert.equal(ui.state.drafts.update.size,'10亿元');assert.equal(ui.state.drafts.update.authoringMode,'reference');assert.equal(ui.state.files.update.length,2);
    context.location.hash='#update';await ui.navigate();assert.equal(ui.state.step,2);assert(ui.workflow('update').includes('库内蓝图.pdf'));assert(ui.workflow('update').includes('从募集书库选择'));
    const form={id:'workflow-form',querySelectorAll:()=>[],reportValidity:()=>true};await listeners.submit({preventDefault(){},target:form});assert.equal(ui.state.step,3);await listeners.submit({preventDefault(){},target:form});assert.equal(submitted.get('blueprintId'),entry.id);assert.equal(submitted.get('issuer'),'本次发行人');assert.equal(submitted.has('reference'),false);assert.equal(submitted.has('historical'),false);assert.equal(submitted.has('libraryBlueprint'),false);assert.equal(submitted.has('financial'),true);assert.equal(ui.state.drafts.update.libraryBlueprint,undefined);
  }finally{context.fetch=previousFetch;ui.state.drafts=previousDrafts;ui.state.files.update=previousFiles;ui.state.route='dashboard';ui.state.step=1;ui.library.reset();}
});

test('library opens on documents and recommendations use an explicit draft picker with a compact project summary',async()=>{
  const previousFetch=context.fetch,previousDrafts=ui.state.drafts;let libraryRequest='';
  const item={id:'c'.repeat(64),title:'蓝图',issuer:'参考企业',warnings:[],chapters:[],market:'sse',instrument:'公司债券',offering:'public',projectStatus:'审核通过',file:{name:'蓝图.pdf',size:100},textReady:true,confirmedAt:'2026-07-01'};
  context.fetch=async path=>{if(path==='/api/library/'+item.id)return {ok:true,json:async()=>({item})};if(path.startsWith('/api/library?')){libraryRequest=path;return {ok:true,json:async()=>({items:[],total:0,page:1,pages:0,stats:{total:0,ready:0,issuers:0,public:0},facets:{issuer:[],region:[]},sources:[]})};}return previousFetch(path);};
  try{
    ui.library.reset();ui.state.libraryReturn=false;ui.state.drafts={};ui.state.route='update';ui.workflow('update');Object.assign(ui.state.drafts.update,{title:'明确的项目名称',issuer:'明确的发行人',exchange:'sse',offering:'public'});ui.state.route='library';ui.state.libraryId='';context.location.hash='#library';
    let html=await ui.library.page();assert(html.includes('全部募集书'));assert(html.includes('推荐相似募集书'));assert(!html.includes('明确的项目名称'));assert(!html.includes('为这份草稿推荐'));assert(!html.includes('library-project-context'));assert(!html.includes('library-target-form'));assert(!html.includes('data-value="recommended"'));assert(!libraryRequest.includes('target_'));
    await ui.library.click('library-select-project');assert(nodes.get('#modal').open);assert(nodes.get('#modal-content').innerHTML.includes('为这份草稿推荐'));assert(nodes.get('#modal-content').innerHTML.includes('明确的项目名称'));assert.equal(ui.state.libraryReturn,false);assert(!libraryRequest.includes('target_'));
    await assert.rejects(ui.library.click('library-confirm-pick',item.id),/尚未选择推荐项目/);
    await ui.library.click('library-use-draft');html=await ui.library.page();assert(!nodes.get('#modal').open);assert(html.includes('library-project-summary'));assert(!html.includes('library-project-context'));assert(!html.includes('library-target-form'));assert(html.includes('推荐项目'));assert(html.includes('明确的项目名称'));assert(html.includes('发行人：明确的发行人'));assert(html.includes('待创建 · 尚未提交'));assert(libraryRequest.includes('target_exchange=sse'));assert(libraryRequest.includes('target_offering=public'));
    await ui.library.click('library-select-project');assert(nodes.get('#modal-content').innerHTML.includes('library-target-form'));nodes.get('#modal').close();
    await ui.library.click('library-sort','');html=await ui.library.page();assert(!libraryRequest.includes('sort=recommended'));assert(html.includes('明确的项目名称'));
    await ui.library.click('library-sort','recommended');html=await ui.library.page();assert(libraryRequest.includes('sort=recommended'));
    await ui.library.click('library-pick',item.id);assert(nodes.get('#modal-content').innerHTML.includes('应用到项目：明确的项目名称'));nodes.get('#modal').close();
    ui.state.drafts.update.issuer='另一发行人';html=await ui.library.page();assert(!html.includes('library-project-summary'));assert(html.includes('推荐相似募集书'));assert(!libraryRequest.includes('target_'));await assert.rejects(ui.library.click('library-confirm-pick',item.id),/尚未选择推荐项目/);
    await ui.library.click('library-use-draft');await ui.library.click('library-select-project');await ui.library.click('library-unlink');assert(!nodes.get('#modal').open);html=await ui.library.page();assert(!html.includes('library-project-summary'));assert(!libraryRequest.includes('target_'));
    await ui.library.click('library-use-draft');await ui.library.click('library-open');html=await ui.library.page();assert(!html.includes('library-project-summary'));assert(html.includes('推荐相似募集书'));assert(!libraryRequest.includes('target_'));
    ui.state.libraryId=item.id;html=await ui.library.page();assert(html.includes('library-detail'));assert(!html.includes('library-project-context'));assert(!html.includes('明确的项目名称'));
  }finally{context.fetch=previousFetch;ui.state.drafts=previousDrafts;ui.state.route='dashboard';ui.state.libraryId='';ui.library.reset();}
});
