import { test, expect, type Page, type Route } from '@playwright/test';
import { createHash } from 'node:crypto';
import type { ProspectusVersion, ProspectusVersions } from '@bondbuddy/contracts';
import type { Dto } from '../src/api';

// Browser-only component tests: all files, owners and receipts below are synthetic.
// They exercise the real ApiClient and component, without a model or private service.
const projectId='synthetic-prospectus-project';
const base=`/api/v1/projects/${projectId}`;
const now='2026-10-25T00:00:00Z';
const mime='application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const bytes=Buffer.from('Synthetic prospectus upload fixture; no customer information.');
const hash=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
const filename='合成募集书新稿.docx';
const version=(id:string,sequence:number,name:string,sha256=hash(id)):ProspectusVersion=>({
  version_id:id,sequence,origin:'upload',filename:name,sha256,created_at:now,
  material_id:`material-${id}`,material_version:1,artifact_id:null,artifact_version:null,
  revision_artifact_id:null,run_id:null,
});
const oldVersion=version('version-old',1,'合成募集书旧稿.docx');
const newVersion=version('version-new',2,filename,hash(bytes));
type Selection=Dto<'ProspectusVersionSelectRequest'>;
type Upload=Dto<'UploadCreateRequest'>;
type Session={input:Upload;received:boolean;material?:Dto<'MaterialResponse'>};
type Mutation={method:string;path:string;body:unknown};
type FixtureOptions={
  current?:boolean;candidate?:boolean;failCompleteOnce?:boolean;dropCompleteOnce?:boolean;
  dropSelectionOnce?:boolean;conflictSelectionOnce?:boolean;
  failChanged?:boolean;holdBeforeChange?:boolean;
  clearTrackingBeforeVersionReply?:boolean;
};

async function fixture(page:Page,options:FixtureOptions={}){
  const state:ProspectusVersions={project_id:projectId,current_version_id:options.current===false?null:oldVersion.version_id,
    selection_revision:options.current===false?0:7,inactive_material_ids:[],
    versions:options.candidate?[structuredClone(newVersion),structuredClone(oldVersion)]:[structuredClone(oldVersion)]};
  if(options.current===false&&!options.candidate)state.versions=[];
  const sessions=new Map<string,Session>(),receipts=new Map<string,{input:Selection;response:ProspectusVersions}>();
  const mutations:Mutation[]=[],selections:Selection[]=[],declarations:Upload[]=[];
  let puts=0,completions=0,reads=0,appliedSelections=0;
  const flags={...options};
  const projection=()=>{
    const current=state.versions.find(v=>v.version_id===state.current_version_id);
    state.inactive_material_ids=current?state.versions.filter(v=>v.material_id&&v.material_id!==current.material_id).map(v=>v.material_id!):[];
    return structuredClone(state);
  };
  const reply=(route:Route,status:number,value:unknown)=>route.fulfill({status,json:value});
  await page.route('**/api/v1/**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const body=method==='POST'||method==='PATCH'?request.postDataJSON():undefined;
    if(method!=='GET')mutations.push({method,path,body});
    if(path===`${base}/prospectus-versions`&&method==='GET'){
      reads++;
      if(flags.clearTrackingBeforeVersionReply&&state.versions.some(v=>v.version_id===newVersion.version_id)){
        flags.clearTrackingBeforeVersionReply=false;
        await page.evaluate(()=>{
          const prefix='bondbuddy:upload-recovery:v1:synthetic-owner:synthetic-prospectus-project:prospectus-version:';
          for(const key of Object.keys(localStorage))if(key.startsWith(prefix))localStorage.removeItem(key);
        });
      }
      return reply(route,200,projection());
    }
    if(path===`${base}/materials/uploads`&&method==='POST'){
      const input=body as Upload;declarations.push(input);
      const id=`upload-${sessions.size+1}`;sessions.set(id,{input,received:false});
      return reply(route,201,{upload_id:id,state:'uploading',upload_url:`${base}/materials/uploads/${id}/bytes`,
        expires_at:'2099-01-01T00:00:00Z',max_bytes:100*1024*1024});
    }
    const upload=path.match(/\/materials\/uploads\/([^/]+)\/(bytes|complete)$/);
    if(upload){
      const session=sessions.get(upload[1]);
      if(!session)return reply(route,404,{code:'NOT_FOUND'});
      if(upload[2]==='bytes'&&method==='PUT'){
        puts++;expect(request.postDataBuffer()).toEqual(bytes);session.received=true;
        return route.fulfill({status:204});
      }
      if(upload[2]==='complete'&&method==='POST'){
        completions++;
        expect(body).toEqual({sha256:session.input.sha256,byte_size:session.input.byte_size});
        if(!session.received)return reply(route,422,{code:'MATERIAL_UNREADABLE'});
        if(flags.failCompleteOnce){flags.failCompleteOnce=false;return reply(route,503,{code:'DATA_UNAVAILABLE'});}
        if(!session.material){
          session.material={material_id:newVersion.material_id!,material_version:1,upload_id:upload[1],role:'historical',
            filename:session.input.filename,media_type:session.input.media_type,byte_size:session.input.byte_size,
            sha256:session.input.sha256,state:'persisted',persisted_at:now,error:null};
          if(!state.versions.some(v=>v.version_id===newVersion.version_id))state.versions.unshift({...newVersion,
            sequence:Math.max(0,...state.versions.map(v=>v.sequence))+1,filename:session.input.filename});
        }
        if(flags.dropCompleteOnce){flags.dropCompleteOnce=false;return route.abort('connectionreset');}
        return reply(route,200,session.material);
      }
    }
    if(path===`${base}/prospectus-versions/current`&&method==='POST'){
      const input=body as Selection;selections.push(input);
      const old=receipts.get(input.request_id);
      if(old){expect(input).toEqual(old.input);return reply(route,200,old.response);}
      if(flags.conflictSelectionOnce){
        flags.conflictSelectionOnce=false;
        const external=version('version-external',3,'另一页面采用的合成募集书.docx');
        state.versions.unshift(external);state.current_version_id=external.version_id;state.selection_revision++;
        return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
      }
      if(input.expected_selection_revision!==state.selection_revision)return reply(route,409,{code:'INPUT_REVISION_CONFLICT'});
      expect(state.versions.some(v=>v.version_id===input.version_id)).toBe(true);
      state.current_version_id=input.version_id;state.selection_revision++;appliedSelections++;
      const response=projection();receipts.set(input.request_id,{input:structuredClone(input),response});
      if(flags.dropSelectionOnce){flags.dropSelectionOnce=false;return route.abort('connectionreset');}
      return reply(route,200,response);
    }
    return reply(route,404,{code:'NOT_FOUND'});
  });
  const origin=process.env.BB_E2E_BASE_URL??'http://127.0.0.1:5173';
  await page.route(new URL('/',origin).href,route=>route.fulfill({contentType:'text/html',
    body:'<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><main id="fixture-host" data-changes="0" data-before-calls="0"></main></body></html>'}));
  await page.goto('/');
  await page.evaluate(async({id,failChanged,holdBeforeChange})=>{
    const panelPath='/src/prospectus-panel.ts',apiPath='/src/api.ts';
    const {ProspectusPanel}=await import(panelPath),{ApiClient}=await import(apiPath);
    const host=document.querySelector<HTMLElement>('#fixture-host')!;
    const panel=new ProspectusPanel(new ApiClient(()=>{host.dataset.sessionLost='true';}),id,host,
      async()=>{host.dataset.beforeCalls=String(Number(host.dataset.beforeCalls)+1);
        if(holdBeforeChange)await new Promise<void>(resolve=>Object.assign(window,{syntheticReleaseBeforeChange:resolve}));return true;},
      async()=>{host.dataset.changes=String(Number(host.dataset.changes)+1);if(failChanged)throw new Error('Synthetic following read failed');},()=>{},'update','synthetic-owner');
    Object.assign(window,{syntheticProspectusPanel:panel});
    await panel.refresh();
  },{id:projectId,failChanged:options.failChanged,holdBeforeChange:options.holdBeforeChange});
  return {state,mutations,selections,declarations,
    counts:()=>({puts,completions,reads,appliedSelections}),
    changes:()=>page.locator('#fixture-host').getAttribute('data-changes'),
    unconfirmed:()=>page.evaluate(()=>(window as unknown as {syntheticProspectusPanel:{hasUnconfirmed:boolean}}).syntheticProspectusPanel.hasUnconfirmed)};
}

async function openContainingDetails(page:Page,selector:string){
  const details=page.locator(selector).locator('xpath=ancestor::details[1]');
  if(await details.count()&&!await details.evaluate(el=>(el as HTMLDetailsElement).open))await details.locator(':scope > summary').click();
}
async function upload(page:Page){
  await page.locator('#prospectus-version-file').setInputFiles({name:filename,mimeType:mime,buffer:bytes});
  await openContainingDetails(page,'#save-prospectus-version');
  await page.locator('#save-prospectus-version').click();
}
async function chooseNew(page:Page){
  await openContainingDetails(page,`[data-use-version="${newVersion.version_id}"]`);
  await page.locator(`[data-use-version="${newVersion.version_id}"]`).click();
  await expect(page.locator('dialog[open]')).toBeVisible();
}
const savedStatus=(page:Page)=>expect(page.locator('#prospectus-status')).toContainText(/已保存.*尚未采用|已保存.*未.*采用/);

test('upload saves a new version without adopting it or rebuilding its parent',async({page})=>{
  const f=await fixture(page);
  await upload(page);await savedStatus(page);
  expect(f.state.current_version_id).toBe(oldVersion.version_id);expect(f.state.selection_revision).toBe(7);
  expect(f.state.versions.map(v=>v.version_id)).toEqual([newVersion.version_id,oldVersion.version_id]);
  expect(f.selections).toHaveLength(0);expect(await f.changes()).toBe('0');
  expect(await f.unconfirmed()).toBe(false);
  expect(f.mutations.some(m=>m.path===`${base}/prospectus-versions`)).toBe(false);
  expect(f.counts().puts).toBe(1);expect(f.counts().reads).toBeGreaterThan(1);
  await openContainingDetails(page,`[data-use-version="${newVersion.version_id}"]`);
  await expect(page.locator(`[data-use-version="${newVersion.version_id}"]`)).toHaveText('采用此版');
  await expect(page.locator('.prospectus-panel header')).toContainText(oldVersion.filename);
});

test('the first saved upload also remains unadopted until an explicit decision',async({page})=>{
  const f=await fixture(page,{current:false});
  await upload(page);await savedStatus(page);
  expect(f.state.current_version_id).toBeNull();expect(f.state.selection_revision).toBe(0);
  expect(f.selections).toHaveLength(0);expect(await f.changes()).toBe('0');
  await chooseNew(page);
  expect(f.selections).toHaveLength(0);
  await page.locator('#confirm-prospectus-selection').click();
  await expect.poll(f.changes).toBe('1');expect(f.state.current_version_id).toBe(newVersion.version_id);
});

test('a later adoption shows its target and effect, can be cancelled, and only submits on confirmation',async({page})=>{
  const f=await fixture(page,{candidate:true});
  await chooseNew(page);
  const dialog=page.locator('dialog[open]');
  await expect(dialog).toContainText(filename);await expect(dialog).toContainText('V2');
  await expect(dialog).toContainText(/旧.*保留|保留.*旧/);
  await expect(dialog).toContainText(/关联文件.*重新核对|重新核对.*关联文件/);
  await expect(dialog).toContainText(/不会.*付费|不启动付费|不.*自动.*付费|不.*自动.*更新/);
  expect(f.selections).toHaveLength(0);
  await page.locator('#cancel-prospectus-selection').click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);expect(f.selections).toHaveLength(0);
  await chooseNew(page);await page.locator('#confirm-prospectus-selection').click();
  await expect.poll(f.changes).toBe('1');await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(f.selections).toHaveLength(1);expect(f.selections[0]).toMatchObject({version_id:newVersion.version_id,expected_selection_revision:7});
  expect(f.selections[0].request_id).toBeTruthy();expect(f.state.selection_revision).toBe(8);
  expect(f.mutations.every(m=>m.path===`${base}/prospectus-versions/current`)).toBe(true);
});

test('a temporary completion failure retries the saved upload session without retransmitting bytes',async({page})=>{
  const f=await fixture(page,{failCompleteOnce:true});
  await upload(page);await expect(page.locator('#save-prospectus-version')).toBeEnabled();
  await expect(page.locator('#prospectus-status')).toContainText(/未.*确认|稍后|重试|暂时/);
  expect(f.counts()).toMatchObject({puts:1,completions:1});expect(f.state.current_version_id).toBe(oldVersion.version_id);
  await page.locator('#save-prospectus-version').click();await savedStatus(page);
  expect(f.counts().puts).toBe(1);expect(f.declarations).toHaveLength(1);expect(f.selections).toHaveLength(0);
});

test('a lost completion receipt reconciles the same session without a second byte transfer',async({page})=>{
  const f=await fixture(page,{dropCompleteOnce:true});
  await upload(page);await expect(page.locator('#save-prospectus-version')).toBeEnabled();
  expect(f.state.versions.some(v=>v.version_id===newVersion.version_id)).toBe(true);
  expect(await f.unconfirmed()).toBe(true);
  await page.locator('#save-prospectus-version').click();await savedStatus(page);
  expect(f.counts().puts).toBe(1);expect(f.counts().completions).toBe(2);expect(f.declarations).toHaveLength(1);
  expect(f.state.current_version_id).toBe(oldVersion.version_id);expect(f.selections).toHaveLength(0);expect(await f.changes()).toBe('0');
  expect(await f.unconfirmed()).toBe(false);
});

test('an uncertain adoption retries the identical selection envelope instead of adopting twice',async({page})=>{
  const f=await fixture(page,{candidate:true,dropSelectionOnce:true});
  await chooseNew(page);await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('#confirm-prospectus-selection')).toBeEnabled();
  await expect(page.locator('dialog[open]')).toBeVisible();expect(await f.changes()).toBe('0');
  expect(await f.unconfirmed()).toBe(true);
  expect(f.selections).toHaveLength(1);expect(f.counts().appliedSelections).toBe(1);
  await page.locator('#confirm-prospectus-selection').click();await expect.poll(f.changes).toBe('1');
  expect(f.selections).toHaveLength(2);expect(f.selections[1]).toEqual(f.selections[0]);
  expect(f.state.selection_revision).toBe(8);expect(f.counts().appliedSelections).toBe(1);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await f.unconfirmed()).toBe(false);
});

test('a selection conflict refreshes the actual current version while keeping the candidate saved',async({page})=>{
  const f=await fixture(page,{candidate:true,conflictSelectionOnce:true});
  await chooseNew(page);await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('#prospectus-status')).toContainText(/保留/);
  await expect(page.locator('.prospectus-panel header')).toContainText('另一页面采用的合成募集书.docx');
  expect(f.state.current_version_id).toBe('version-external');expect(f.selections).toHaveLength(1);
  expect(f.state.versions.some(v=>v.version_id===newVersion.version_id)).toBe(true);
  expect(await f.changes()).toBe('0');expect(f.counts().reads).toBeGreaterThan(1);
  await openContainingDetails(page,`[data-use-version="${newVersion.version_id}"]`);
  await expect(page.locator(`[data-use-version="${newVersion.version_id}"]`)).toBeEnabled();
});

test('saving a file neither invents source declarations nor claims automatic identification',async({page})=>{
  const f=await fixture(page);await upload(page);await savedStatus(page);
  expect(Object.keys(f.declarations[0]).sort()).toEqual(['byte_size','filename','media_type','role','sha256']);
  expect(f.declarations[0]).toMatchObject({filename,media_type:mime,role:'historical',sha256:hash(bytes),byte_size:bytes.length});
  expect(f.mutations.every(m=>m.path.includes('/materials/uploads'))).toBe(true);
  await expect(page.locator('[data-source-field], [data-source-material]')).toHaveCount(0);
  await expect(page.locator('#fixture-host')).not.toContainText(/已自动识别|自动识别完成/);
  expect(await f.changes()).toBe('0');expect(f.selections).toHaveLength(0);
});

test('an acknowledged adoption remains adopted when its following parent refresh fails',async({page})=>{
  const f=await fixture(page,{candidate:true,failChanged:true});
  await chooseNew(page);await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('#prospectus-status')).toContainText(/已采用.*页面刷新尚未完成/);
  await expect(page.locator('.prospectus-panel header')).toContainText(filename);
  await expect(page.locator('dialog[open], #retry-prospectus-selection')).toHaveCount(0);
  expect(f.selections).toHaveLength(1);expect(f.state.selection_revision).toBe(8);expect(await f.changes()).toBe('1');
});

test('disposing during the preceding draft save removes the dialog and cannot start an adoption',async({page})=>{
  const f=await fixture(page,{candidate:true,holdBeforeChange:true});
  await chooseNew(page);await page.locator('#confirm-prospectus-selection').click();
  await expect(page.locator('#confirm-prospectus-selection')).toBeDisabled();
  await page.evaluate(()=>{
    const fixtureWindow=window as unknown as {syntheticProspectusPanel:{dispose():void};syntheticReleaseBeforeChange():void};
    fixtureWindow.syntheticProspectusPanel.dispose();fixtureWindow.syntheticReleaseBeforeChange();
  });
  await expect.poll(()=>page.evaluate(()=>(window as unknown as {syntheticProspectusPanel:{busy:boolean}}).syntheticProspectusPanel.busy)).toBe(false);
  await expect(page.locator('dialog')).toHaveCount(0);
  expect(f.selections).toHaveLength(0);expect(f.state.current_version_id).toBe(oldVersion.version_id);expect(await f.changes()).toBe('0');
});

test('a background version refresh keeps a selected file ready for its explicit upload',async({page})=>{
  const f=await fixture(page);
  await openContainingDetails(page,'#save-prospectus-version');
  await page.locator('#prospectus-version-file').setInputFiles({name:filename,mimeType:mime,buffer:bytes});
  await page.evaluate(async()=>{await (window as unknown as {syntheticProspectusPanel:{refresh():Promise<void>}}).syntheticProspectusPanel.refresh();});
  await expect(page.locator('#prospectus-version-file')).toBeVisible();
  expect(await page.locator('#prospectus-version-file').evaluate((input:HTMLInputElement)=>input.files?.[0]?.name)).toBe(filename);
  expect(f.mutations).toHaveLength(0);
  await page.locator('#save-prospectus-version').click();await savedStatus(page);
  expect(f.counts().puts).toBe(1);expect(f.state.current_version_id).toBe(oldVersion.version_id);
});

test('another page clearing a confirmed upload does not misreport the saved prospectus version',async({page})=>{
  const f=await fixture(page,{clearTrackingBeforeVersionReply:true});
  await upload(page);await savedStatus(page);
  expect(await f.unconfirmed()).toBe(false);expect(f.declarations).toHaveLength(1);
  expect(f.counts()).toMatchObject({puts:1,completions:1});expect(f.selections).toHaveLength(0);
  await expect(page.locator('#prospectus-status')).not.toContainText('版本记录暂未读取');
  expect(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('bondbuddy:upload-recovery:')))).toEqual([]);
});
