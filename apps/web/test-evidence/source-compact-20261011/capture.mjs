
import { chromium } from '@playwright/test';
import { projectWorkspace } from '../../../../product-prototype/public/project-workspace.js';
import { authoringUI } from '../../../../product-prototype/public/authoring.js';
import { readFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const file={stored:true,key:'correct',role:'historical',file:{name:'正确募集书.pdf',size:22}};
const state={route:'update',step:2,accountEpoch:0,health:{authoringVersion:2,projectInputVersion:3,oneClickExecution:true},files:{update:[file],review:[]},drafts:{update:{projectId:'p',exchange:'sse',offering:'private',updateMode:'full',issuer:'合成发行人',title:'合成任务项目',sourceProspectuses:{correct:{issuer_name:'合成发行人',relation:'same_issuer',market:'sse',offering:'private',year:'2024',quarter:'12-31'}}}},connectors:[],billing:null};
const esc=v=>String(v??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('"','&quot;');
const shared={state,esc,icon:name=>name==='close'?'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg>':'',bytes:n=>n+' B',head:()=>'<h1>合成任务项目</h1>',draft:kind=>state.drafts[kind],reportingPreview:()=>''};
const workspace=projectWorkspace({...shared,authoring:authoringUI(shared),api:async()=>({}),post:async()=>({}),toast:()=>{},saveDraft:()=>{},render:async()=>{},refreshJobs:async()=>{}});

const out='./apps/web/test-evidence/source-compact-20261011';
await mkdir(out,{recursive:true});
let css='';for(const name of ['styles','authoring','project-workspace','source-prospectus'])css+=await readFile('./product-prototype/public/'+name+'.css','utf8');
css=css.replace(/@import[^;]*;/g,'');
const browser=await chromium.launch({channel:'msedge'});
const metrics=[];
try {
  const implementation=await browser.newPage();
  await implementation.route('**/api/v1/**',route=>route.fulfill({status:401,contentType:'application/json',body:'{}'}));
  await implementation.goto(process.env.BB_E2E_BASE_URL || 'http://127.0.0.1:5188');
  const markup=await implementation.evaluate(async()=>{
    const {sourceFields}=await import('/src/source-prospectus.ts');
    const material={material_id:'synthetic-history',material_version:1,sha256:'a'.repeat(64),role:'historical'};
    const source={...material,relation:'same_issuer',market:'sse',offering:'private',reporting_periods:[{start:'2021-01-01',end:'2021-12-31',period_kind:'annual'},{start:'2022-01-01',end:'2022-12-31',period_kind:'annual'},{start:'2023-01-01',end:'2023-06-30',period_kind:'interim'}]};
    return sourceFields(material,[source]);
  });
  state.drafts.update.sourceProspectuses.correct.year='2023';
  state.drafts.update.sourceProspectuses.correct.quarter='06-30';
  const prototype=await browser.newPage();
  for(const [name,width,height,container] of [['desktop',1440,960,1004],['tablet',1024,960,620],['narrow',768,960,450],['mobile',390,844,294],['small',320,844,250]]) {
    await implementation.setViewportSize({width,height});
    await implementation.evaluate(({markup,container})=>{document.body.className='prototype-app';document.body.innerHTML='<main style="margin:0 auto;padding:20px 0;width:'+container+'px;max-width:100%;background:white">'+markup+'</main>';},{markup,container});
    await prototype.setViewportSize({width,height});
    await prototype.setContent('<html lang="zh-CN"><meta charset="utf-8"><style>'+css+'</style><main style="margin:0 auto;padding:20px 0;width:'+container+'px;max-width:100%;background:white">'+workspace.page('update').match(/<fieldset class="prototype-source[\s\S]*?<\/fieldset>/)[0]+'</main></html>');
    for(const [label,page] of [['implementation',implementation],['prototype',prototype]]) {
      const fieldset=page.locator('.source-prospectus');
      await fieldset.screenshot({path:out+'/'+label+'-'+name+'.png'});
      metrics.push({label,name,...await fieldset.evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth,columns:getComputedStyle(el.querySelector('.source-fields')).gridTemplateColumns}))});
    }
  }
  await implementation.setViewportSize({width:1440,height:960});
  await implementation.evaluate(markup=>{document.body.innerHTML='<div class="ba-form" style="width:360px;margin:20px">'+markup+'</div>';},markup);
  await implementation.locator('.source-prospectus').screenshot({path:out+'/implementation-assistant.png'});
  metrics.push({label:'assistant',...await implementation.locator('.source-prospectus').evaluate(el=>({width:el.getBoundingClientRect().width,height:el.getBoundingClientRect().height,overflow:el.scrollWidth>el.clientWidth}))});
  await import('node:fs/promises').then(fs=>fs.writeFile(out+'/metrics.json',JSON.stringify(metrics,null,2)+'\n'));
  console.log(JSON.stringify(metrics,null,2));
} finally {await browser.close();}
