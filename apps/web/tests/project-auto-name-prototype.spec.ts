import { test, expect } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';

test('project creation prototype places required on the section and generates the name', async ({page}) => {
  await page.route('http://prototype.test/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==='/')return route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><link rel="stylesheet" href="/styles.css"><link rel="stylesheet" href="/project-workspace.css"></head><body><main id="preview"></main></body></html>'});
    if(!/^\/[\w.-]+$/.test(path))return route.fulfill({status:404});
    return route.fulfill({body:await readFile('../../product-prototype/public'+path),contentType:path.endsWith('.js')?'text/javascript':'text/css'});
  });
  await page.goto('http://prototype.test/');
  await page.evaluate(async()=>{
    const path='/project-workspace.js';const {projectWorkspace}=await import(path);
    const d={issuer:'合成发行人有限公司',exchange:'sse',offering:'private',year:'2026',quarter:'',updateMode:'full',projectMessages:[]};
    const noop=()=>{};
    const workspace=projectWorkspace({state:{route:'update',accountEpoch:1,step:1,files:{update:[]},health:{authoringVersion:2,projectInputVersion:3,oneClickExecution:true}},draft:()=>d,saveDraft:noop,esc:(s:unknown)=>String(s??'').replaceAll('&','&amp;').replaceAll('<','&lt;'),icon:()=>'',bytes:String,head:()=>'<div class="page-head"><div><div class="eyebrow">PROSPECTUS WORKSPACE</div><h1>更新募集说明书</h1><p>提供项目材料和要求，点击开始即可执行。</p></div></div>',api:noop,post:noop,toast:noop,render:noop,authoring:{optional:()=>''},reportingPreview:()=>'',refreshJobs:noop});
    document.querySelector('#preview')!.innerHTML=workspace.page('update');
    document.addEventListener('input',e=>workspace.input(e.target));
  });
  await expect(page.getByRole('heading',{name:'项目基本信息 必填'})).toBeVisible();
  await expect(page.locator('input[name=title]')).toHaveCount(0);
  await expect(page.locator('#generated-project-name')).toHaveText('合成发行人有限公司-上交所-普通私募公司债-募集书更新');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===1440?960:844});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    if(process.env.BB_NAME_EVIDENCE){const dir='test-evidence/project-auto-name-20261011';await mkdir(dir,{recursive:true});await page.screenshot({path:`${dir}/prototype-${width}.png`});}
  }
  await page.getByLabel('发行人全称').fill('另一合成发行人');
  await expect(page.locator('#generated-project-name')).toHaveText('另一合成发行人-上交所-普通私募公司债-募集书更新');
});
