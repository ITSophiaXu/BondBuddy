
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
let css='';for(const name of ['styles','authoring','project-workspace'])css+=await readFile('./product-prototype/public/'+name+'.css','utf8');
const browser=await chromium.launch({channel:'msedge'});
const page=await browser.newPage();
await mkdir('./apps/web/test-evidence/no-source-issuer-20261009',{recursive:true});
for(const [name,width,height] of [['desktop',1440,960],['mobile',390,844]]){
 await page.setViewportSize({width,height});
 await page.setContent('<html lang="zh-CN"><meta charset="utf-8"><style>'+css+'</style><main class="main" style="margin:auto;max-width:1100px;padding:24px">'+workspace.page('update')+'</main></html>');
 await page.locator('.file-item').first().scrollIntoViewIfNeeded();
 await page.screenshot({path:'./apps/web/test-evidence/no-source-issuer-20261009/prototype-'+name+'.png'});
}
await browser.close();
assert(!workspace.page('update').includes('data-source-field="issuer_name"'));


console.log('prototype no manual issuer field: passed');
