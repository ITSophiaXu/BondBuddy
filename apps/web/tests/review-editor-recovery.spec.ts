import {expect,test,type Page,type Route} from '@playwright/test';
import {createHash} from 'node:crypto';
import type {ReviewEditorResponse,ReviewArtifact,ReviewExportRequest,Run} from '@bondbuddy/contracts';

// Component-only synthetic receipts. No model, account data or production mutation.
const project='synthetic-editor-project',owner='synthetic-editor-owner',runId='synthetic-editor-v1',secondRun='synthetic-editor-v2';
const sha='a'.repeat(64),now='2026-10-25T04:00:00Z',base=`/projects/${project}`;
const artifact:ReviewArtifact={artifact_id:'synthetic-clean-v1',artifact_version:1,kind:'clean',filename:'合成清洁版.docx'};
const artifacts=[artifact];
const run=(id=runId):Run=>({run_id:id,execution_request_id:`request-${id}`,project_id:project,input_revision:1,input_hash:sha,channel:'production',test_grant_id:null,uncovered_items:[],state:'succeeded',stage:null,event_cursor:0,billing_mode:'platform_trial',reservation_id:null,artifact_id:artifact.artifact_id,prompt_snapshot_ref:null,updated_at:now});
const editor=(id=runId):ReviewEditorResponse=>({run_id:id,sha256:sha,snapshot:{version:'review-editor-v1',source_filename:'合成募集书.docx',source_sha256:sha,source_format:'docx',warnings:[],paragraphs:[{id:'p1',text:'旧文'}],issues:[{id:'issue-1',decision:'suggested',manual_text:'',category:'合成类别',title:'合成发现',original:'旧文',replacement:'建议文',reason:'合成依据',evidence:'合成材料',missing:'',uncertain:false,paragraph_id:'p1',applied:true,limitation:''}]}});
const reply=(route:Route,status:number,body:unknown)=>route.fulfill({status,json:body});

async function fixture(page:Page,reviewTemplate?:ReviewEditorResponse){
  const state={posts:[] as ReviewExportRequest[],failure:'network' as 'network'|'401'|'none',editorMismatch:false,historyFailure:false,metadataMismatch:false,bytes:0,hold:undefined as Promise<void>|undefined};
  const bytes=Buffer.from('Synthetic saved Word bytes'),mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname.replace('/api/v1','');
    if(path===`${base}/review-history`)return reply(route,200,{items:[runId,secondRun].map((id,i)=>({run:run(id),operation:'full_review',version:i+1,artifacts,created_at:now}))});
    const match=path.match(/\/review-executions\/([^/]+)\/editor$/);
    if(match){if(state.historyFailure&&match[1]===secondRun)return reply(route,503,{code:'DATA_UNAVAILABLE'});const id=state.editorMismatch?'synthetic-other-run':match[1];return reply(route,200,reviewTemplate?{...reviewTemplate,run_id:id}:editor(id));}
    if(path===`${base}/review-exports`){state.posts.push(request.postDataJSON());if(state.hold)await state.hold;
      if(state.failure==='network')return route.abort('connectionreset');if(state.failure==='401')return reply(route,401,{code:'UNAUTHENTICATED'});
      return reply(route,200,{...run('synthetic-export-run'),state:'queued',execution_request_id:state.posts.at(-1)!.request_id});}
    if(path===`/artifacts/${artifact.artifact_id}`)return reply(route,200,{artifact_id:state.metadataMismatch?'wrong-id':artifact.artifact_id,run_id:runId,version:1,filename:artifact.filename,media_type:mime,sha256:createHash('sha256').update(bytes).digest('hex'),download_url:`/api/v1/artifacts/${artifact.artifact_id}/download`});
    if(path===`/artifacts/${artifact.artifact_id}/download`){state.bytes++;return route.fulfill({status:200,contentType:mime,body:bytes});}
    return reply(route,404,{code:'NOT_FOUND'});
  });
  const origin=process.env.BB_E2E_BASE_URL??'http://127.0.0.1:5173';
  await page.route(new URL('/',origin).href,route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html lang="zh-CN"><body><main id="editor-host"></main></body></html>'}));
  const boot=async(options:{storageBroken?:boolean;seed?:unknown}={})=>{
    await page.goto('/');
    await page.evaluate(async({project,owner,runId,artifacts,storageBroken,seed})=>{
      if(seed!==undefined)localStorage.setItem(`bb-review-editor:${owner}:${project}:${runId}`,JSON.stringify(seed));
      if(storageBroken)Storage.prototype.setItem=()=>{throw new DOMException('Synthetic quota','QuotaExceededError');};
      const editorPath='/src/review-editor.ts',apiPath='/src/api.ts';
      const {ReviewEditor}=await import(editorPath),{ApiClient}=await import(apiPath);
      const host=document.querySelector<HTMLElement>('#editor-host')!,controller=new AbortController();
      const editor=new ReviewEditor(new ApiClient(()=>{controller.abort();editor.dispose();host.innerHTML='<p>合成登录页</p>';}),project,owner,controller.signal,
        ()=>{host.dataset.submitted=String(Number(host.dataset.submitted??0)+1);},()=>{},
        (id:string)=>{host.dataset.selected=id;});
      Object.assign(window,{syntheticEditor:editor});await editor.mount(host,runId,artifacts);
    },{project,owner,runId,artifacts,...options});
  };
  return {state,boot};
}

for(const width of [1280,390])test(`review categories and pending notes stay outside the prospectus body (${width}px)`,async({page})=>{
  await page.setViewportSize({width,height:900});
  const response=editor();response.snapshot.warnings=['合成版本提示，仅显示在结果页'];
  Object.assign(response.snapshot.issues[0],{category:'合规',uncertain:true,applied:false,missing:'合成用途明细'});
  const f=await fixture(page,response);await f.boot();
  const comment=page.locator('.review-preview-comment');
  await expect(comment.locator('p').first()).toHaveText('问题类别：合规');
  await expect(comment).toContainText('合成依据');
  for(const view of ['original','clean']){
    await page.locator(`[data-editor-view="${view}"]`).click();
    await expect(page.locator('.review-paper')).toHaveText('旧文');
    await expect(page.locator('.review-paper .review-preview-comment')).toHaveCount(0);
    await expect(page.locator('.review-notice')).toHaveText(response.snapshot.warnings[0]);
    await expect(page.locator('.review-issue-detail')).toContainText('合成用途明细');
  }
});

test('unknown export receipt freezes decisions and explicitly retries the identical envelope after reopen',async({page})=>{
  const f=await fixture(page);await f.boot();
  await page.getByRole('radio',{name:'手动修改',exact:true}).check();await page.locator('#review-manual-text').fill('人工确认文');
  await page.locator('[data-editor-save]').click();await expect(page.locator('[data-editor-status]')).toContainText(/尚未确认|未确认/);
  expect(f.state.posts).toHaveLength(1);const first=structuredClone(f.state.posts[0]);
  await expect(page.getByRole('radio',{name:'保留原文',exact:true})).toBeDisabled();
  await expect(page.locator('#review-manual-text')).toBeDisabled();await expect(page.locator('[data-editor-history]')).toBeDisabled();
  await page.getByRole('radio',{name:'保留原文',exact:true}).evaluate(el=>{(el as HTMLInputElement).checked=true;el.dispatchEvent(new Event('change',{bubbles:true}));});
  await expect(page.getByRole('radio',{name:'手动修改',exact:true})).toBeChecked();
  await page.locator('#review-manual-text').evaluate(el=>{(el as HTMLTextAreaElement).value='迟到事件修改';el.dispatchEvent(new Event('input',{bubbles:true}));});
  await expect(page.locator('#review-manual-text')).toHaveValue('人工确认文');
  expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(true);
  await f.boot();await expect(page.locator('#review-manual-text')).toHaveValue('人工确认文');expect(f.state.posts).toHaveLength(1);
  f.state.failure='none';await page.locator('[data-editor-save]').click();await expect(page.locator('#editor-host')).toHaveAttribute('data-submitted','1');
  expect(f.state.posts).toEqual([first,first]);
});

test('unavailable recovery storage prevents submitting a fresh export',async({page})=>{
  const f=await fixture(page);await f.boot({storageBroken:true});await page.getByRole('radio',{name:'保留原文',exact:true}).check();
  await page.locator('[data-editor-save]').click();await expect(page.locator('[data-editor-status]')).toContainText(/浏览器.*保存|恢复记录/);
  expect(f.state.posts).toHaveLength(0);
  expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(false);
});

test('legacy complete pending receipt keeps its request id and cannot auto submit on mount',async({page})=>{
  const f=await fixture(page),pending:ReviewExportRequest={request_id:'legacy-request',source_run_id:runId,expected_editor_sha256:sha,decisions:[{id:'issue-1',decision:'manual',manual_text:'历史人工处理'}]};
  await f.boot({seed:{sha256:sha,decisions:pending.decisions,pending}});await expect(page.locator('#review-manual-text')).toHaveValue('历史人工处理');expect(f.state.posts).toHaveLength(0);
  f.state.failure='none';await page.locator('[data-editor-save]').click();await expect(page.locator('#editor-host')).toHaveAttribute('data-submitted','1');expect(f.state.posts).toEqual([pending]);
});

test('explicit history callback follows successful exact load only',async({page})=>{
  const f=await fixture(page);await f.boot();await expect(page.locator('#editor-host')).not.toHaveAttribute('data-selected');
  f.state.historyFailure=true;await page.locator('[data-editor-history]').selectOption(secondRun);await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('#editor-host')).not.toHaveAttribute('data-selected');
  f.state.historyFailure=false;await page.locator('[data-reload-editor]').click();await expect(page.locator('#editor-host')).toHaveAttribute('data-selected',secondRun);
});

test('dirty preview retains downloads of the pinned saved Word',async({page})=>{
  const f=await fixture(page);await f.boot();await page.getByRole('radio',{name:'保留原文',exact:true}).check();
  await expect(page.locator('[data-editor-document]')).toContainText('尚未保存');await expect(page.locator('[data-editor-download]')).toBeEnabled();
  const download=page.waitForEvent('download');await page.locator('[data-editor-download]').click();expect((await download).suggestedFilename()).toBe(artifact.filename);expect(f.state.bytes).toBe(1);
});

test('late 401 after export cannot restore private editor or submitted callback',async({page})=>{
  const f=await fixture(page);await f.boot();await page.getByRole('radio',{name:'保留原文',exact:true}).check();f.state.failure='401';
  await page.locator('[data-editor-save]').click();await expect(page.getByText('合成登录页')).toBeVisible();await expect(page.locator('[data-editor-save]')).toHaveCount(0);await expect(page.locator('#editor-host')).not.toHaveAttribute('data-submitted');
});

test('malformed pending receipt is preserved and blocks fresh export instead of replacing its key',async({page})=>{
  const f=await fixture(page);await f.boot({seed:{sha256:sha,decisions:[{id:'issue-1',decision:'original',manual_text:''}],pending:{request_id:'uncertain-legacy',source_run_id:'wrong-source',expected_editor_sha256:sha,decisions:[]}}});
  await expect(page.locator('[data-editor-status]')).toContainText('无法校验');await expect(page.locator('[data-editor-save]')).toBeDisabled();
  await expect(page.getByRole('radio',{name:'保留原文',exact:true})).toBeDisabled();
  expect(f.state.posts).toHaveLength(0);expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(false);
  expect(await page.evaluate(({owner,project,runId})=>localStorage.getItem(`bb-review-editor:${owner}:${project}:${runId}`),{owner,project,runId})).toContain('uncertain-legacy');
});

test('busy receipt blocks leaving and acknowledged cached dirty preview can leave',async({page})=>{
  const f=await fixture(page);await f.boot();await page.getByRole('radio',{name:'保留原文',exact:true}).check();
  expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(true);
  let release!:()=>void;f.state.hold=new Promise<void>(resolve=>release=resolve);f.state.failure='none';
  await page.locator('[data-editor-save]').click();await expect(page.locator('[data-editor-save]')).toBeDisabled();
  expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(false);
  release();await expect(page.locator('#editor-host')).toHaveAttribute('data-submitted','1');
});

test('download metadata with a substituted artifact id never requests bytes',async({page})=>{
  const f=await fixture(page);await f.boot();f.state.metadataMismatch=true;await page.locator('[data-editor-download]').click();
  await expect(page.locator('[data-editor-status]')).toContainText('当前复核版本不一致');expect(f.state.bytes).toBe(0);
});

test('another tab pending envelope cannot overwrite or replace this page uncertain request',async({page})=>{
  const f=await fixture(page);await f.boot();await page.getByRole('radio',{name:'手动修改',exact:true}).check();await page.locator('#review-manual-text').fill('本页待确认文本');
  await page.locator('[data-editor-save]').click();await expect(page.locator('[data-editor-status]')).toContainText('处理选择已保留并锁定');expect(f.state.posts).toHaveLength(1);
  const original=structuredClone(f.state.posts[0]),other:ReviewExportRequest={...original,request_id:'another-tab-request',decisions:original.decisions.map(d=>({...d,manual_text:'另一页面待确认文本'}))};
  const raw=JSON.stringify({version:'review-editor-cache-v1',owner,project,run:runId,value:{sha256:sha,decisions:other.decisions,pending:other}});
  await page.evaluate(({owner,project,runId,raw})=>localStorage.setItem(`bb-review-editor:${owner}:${project}:${runId}`,raw),{owner,project,runId,raw});
  f.state.failure='none';await page.locator('[data-editor-save]').click();await expect(page.locator('[data-editor-status]')).toContainText('另一页面的待确认导出请求与本页请求不一致');
  expect(f.state.posts).toEqual([original]);await expect(page.locator('#review-manual-text')).toHaveValue('本页待确认文本');await expect(page.locator('[data-editor-save]')).toBeDisabled();
  expect(await page.evaluate(({owner,project,runId})=>localStorage.getItem(`bb-review-editor:${owner}:${project}:${runId}`),{owner,project,runId})).toBe(raw);
  await page.locator('[data-editor-recover]').click();await expect(page.locator('#review-manual-text')).toHaveValue('本页待确认文本');expect(f.state.posts).toHaveLength(1);
  expect(await page.evaluate(()=>(window as unknown as {syntheticEditor:{beforeLeave:()=>boolean}}).syntheticEditor.beforeLeave())).toBe(false);
});
