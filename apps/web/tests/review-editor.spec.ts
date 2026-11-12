import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes=Buffer.from('synthetic download transport fixture');
const hash=createHash('sha256').update(bytes).digest('hex');
async function editor(page:any,{empty=false,fail=false,corrupt=false}={}){
  const state={fail,corrupt,reads:0,wait:undefined as Promise<void>|undefined};
  const artifacts=['revision','clean','report'].map(kind=>({artifact_id:kind,artifact_version:1,kind,filename:kind+'.docx'}));
  await page.route('**/api/v1/**',async(route:any)=>{
    const path=new URL(route.request().url()).pathname;
    let body:unknown;
    if(path.endsWith('/editor'))body={run_id:'run-1',sha256:hash,snapshot:{version:'review-editor-v1',source_filename:'合成募集书.docx',source_sha256:hash,source_format:'docx',warnings:empty?['报告需人工核对，不能据此认定未发现问题。']:[],paragraphs:[{id:'p0',text:'总资产为12亿元。'}],issues:empty?[]:[{id:'R001',category:'财务数据一致性',title:'资产金额需统一',original:'总资产为12亿元。',replacement:'总资产为13亿元。',reason:'与合成财务报表核对后统一金额。',evidence:'合成财务报表资产行',missing:'',uncertain:false,paragraph_id:'p0',decision:'suggested',manual_text:'',applied:true,limitation:''}]}};
    else if(path.endsWith('/review-history'))body={items:[{version:1,operation:'full_review',created_at:'2026-10-25T08:51:40Z',run:{run_id:'run-1',state:'succeeded'},artifacts}]};
    else if(path.endsWith('/download'))return route.fulfill({status:200,contentType:mime,body:state.corrupt?Buffer.from('wrong bytes'):bytes});
    else if(path.includes('/artifacts/')){
      state.reads++;
      if(state.wait)await state.wait;
      if(state.fail)return route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({code:'DATA_UNAVAILABLE'})});
      const id=path.split('/').at(-1);body={artifact_id:id,run_id:'run-1',version:1,filename:id+'.docx',media_type:mime,sha256:hash,download_url:`/api/v1/artifacts/${id}/download?grant=synthetic`};
    }else return route.fulfill({status:404,contentType:'application/json',body:'{}'});
    return route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.route('**/__review_editor_test', (route:any)=>route.fulfill({contentType:'text/html',body:`<html lang="zh"><head><link rel="stylesheet" href="/src/style.css"></head><body><main id="editor"></main><script type="module">import {ReviewEditor} from '/src/review-editor.ts';import {ApiClient} from '/src/api.ts';const editor=new ReviewEditor(new ApiClient(()=>{}),'project','owner',new AbortController().signal,()=>{},()=>{});editor.mount(document.querySelector('#editor'),'run-1',${JSON.stringify(artifacts)});</script></body></html>`}));
  await page.goto('/__review_editor_test');
  await expect(page.getByRole('heading',{name:'复核成果',exact:true})).toBeVisible();
  return state;
}

test('review editor downloads all variants and exposes progress and recoverable failures',async({page},testInfo)=>{
  const state=await editor(page,{fail:true});
  await page.getByRole('button',{name:'下载修订版',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('文件暂时未能下载，请稍后重试下载。');
  state.fail=false;
  for(const label of ['下载修订版','下载清洁版','下载复核报告']){
    let release!:()=>void;state.wait=new Promise(resolve=>release=resolve);
    const download=page.waitForEvent('download');
    await page.getByRole('button',{name:label,exact:true}).click();
    await expect(page.getByRole('status')).toContainText('正在读取并校验文件');
    await expect(page.getByRole('button',{name:'正在读取…',exact:true})).toBeDisabled();
    release();state.wait=undefined;
    expect((await download).suggestedFilename()).toMatch(/\.docx$/);
    await expect(page.getByRole('status')).toContainText('已提交浏览器下载');
  }
  expect(state.reads).toBe(4);
  await expect(page.locator('del')).toHaveText('总资产为12亿元。');
  await expect(page.locator('ins')).toHaveText('总资产为13亿元。');
  await page.screenshot({path:testInfo.outputPath('editor.png'),fullPage:true});
});

test('unmodified historical output is downloadable without claiming it contains revisions',async({page})=>{
  await editor(page,{empty:true});
  await expect(page.getByText('未提取到可处理的问题条目 · 正文未修改',{exact:false})).toBeVisible();
  await expect(page.getByRole('button',{name:'下载修订版',exact:true})).toHaveCount(0);
  const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载原文（未修订）',exact:true}).click();await download;
  await expect(page.locator('ins,del')).toHaveCount(0);
});

test('corrupt download fails visibly and retry reauthorizes and downloads verified bytes',async({page})=>{
  const state=await editor(page,{corrupt:true});let downloaded=false;page.on('download',()=>downloaded=true);
  await page.getByRole('button',{name:'下载修订版',exact:true}).click();
  await expect(page.getByRole('status')).toContainText('文件暂时未能下载，请稍后重试下载。');expect(downloaded).toBe(false);
  state.corrupt=false;const download=page.waitForEvent('download');
  await page.getByRole('button',{name:'下载修订版',exact:true}).click();await download;expect(state.reads).toBe(2);
});
