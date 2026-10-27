// Full desktop through real HTTP/PG/production worker and private Word download.
// Original inputs/credit lots/provider output are synthetic; no supplier or real payment is claimed.
import {expect,test,type Locator,type Page} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {digest,uid} from '../../api/dist/data.js';
import {startProductionSupplementBrowser,type ProductionBrowser} from './run-supplement-production-real-harness';
import {captureWallet,assertPausedWallet,assertWalletUnchanged,assertAdoptedWallet,writeFiveStageWallet} from './run-supplement-production-wallet';

const action=(host:Locator,name:string)=>host.locator(`[data-supplement-action="${name}"]`);
const panel=(page:Page,r:ProductionBrowser)=>page.locator(`[data-run-supplement="${r.runId}"]`);
const control=(page:Page,r:ProductionBrowser,name:'pause'|'resume')=>r.surface==='m1'?page.locator(`#${name}-run`):
  r.surface==='m3'?page.locator(`#review-making-panel [data-review-action="${name}"]`):page.locator(`[data-m4-action="${name}"][data-run="${r.runId}"]`);
async function ready(page:Page,r:ProductionBrowser){
  const host=panel(page,r);await expect(host).toBeVisible({timeout:15000});
  const first=host.locator('summary').first();if(await first.count()&&await first.locator('..').evaluate(e=>e.tagName==='DETAILS'&&!(e as HTMLDetailsElement).open))await first.click();
  await expect(host.locator('[data-supplement-file]')).toBeVisible();return host;
}
async function executeWhenAvailable(r:ProductionBrowser,afterStage?:Parameters<typeof r.execute>[0]){
  const deadline=Date.now()+10000;
  for(;;){const outcome=await r.execute(afterStage);if(outcome!=='idle')return outcome;
    expect(Date.now(),'Queued claim can briefly lose to authenticated browser polling locks').toBeLessThan(deadline);await new Promise(resolve=>setTimeout(resolve,30));}
}
function readWord(python:string,path:string){
  const result=spawnSync(python,['-c','from docx import Document; import sys,json; d=Document(sys.argv[1]); print(json.dumps({"paragraphs":len(d.paragraphs),"text":"\\n".join(p.text for p in d.paragraphs)},ensure_ascii=True))',path],{encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);const parsed=JSON.parse(result.stdout) as {paragraphs:number;text:string};
  expect(parsed.paragraphs).toBeGreaterThan(0);return parsed;
}

for(const kind of ['authoring','review','m4'] as const)test(`real desktop ${kind}: saved Word work → browser B1 quote/consent/adoption → real successor worker → private new Word`,async({page,context})=>{
  test.setTimeout(240000);const r=await startProductionSupplementBrowser(kind);
  const materialMarker=`SYNTHETIC_${kind.toUpperCase()}_${uid().replaceAll('-','')}_ADOPTED`;
  let businessEvidenceComplete=false;
  const network:Array<{method:string;path:string;status:number;body?:unknown}>=[];
  let releaseOriginal:()=>void=()=>{},releaseSuccessor:()=>void=()=>{},worker:Promise<unknown>|undefined;
  const protocol=`/api/v1/runs/${r.runId}`;
  try{
    await page.setViewportSize({width:1440,height:960});
    await context.addCookies([{name:'bb_session',value:r.access,url:r.baseURL,httpOnly:true,sameSite:'Lax'},{name:'bb_csrf',value:r.csrf,url:r.baseURL,sameSite:'Lax'}]);
    // Egress guard only: no API, worker result, page shell or browser response is mocked.
    await context.route('**/*',async route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol)&&url.origin!==r.baseURL)throw Error(`Unexpected external request: ${url.origin}`);await route.continue();});
    page.on('response',response=>{const request=response.request(),url=new URL(response.url());if(url.pathname.startsWith('/api/v1/'))network.push({method:request.method(),path:url.pathname+url.search,status:response.status(),
      ...(url.pathname.includes('/supplement-')&&request.method()!=='GET'?{body:request.postDataJSON()}: {})});});
    const original=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
    expect(original).toMatchObject({state:'queued',channel:'production',test_grant_id:null});expect(original.reservation_id).toBeTruthy();
    await page.goto(r.baseURL+r.route);await expect(control(page,r,'pause')).toBeVisible({timeout:15000});
    let atWord=false,workerError:unknown;const release=new Promise<void>(resolve=>{releaseOriginal=resolve;});
    worker=executeWhenAvailable(r,async stage=>{if(stage==='word_promoted'){atWord=true;await release;}});void worker.catch(error=>{workerError=error;});
    await expect.poll(()=>{if(workerError)throw workerError;return atWord;},{timeout:90000}).toBe(true);
    const walletBeforePause=await captureWallet(r,'before_pause');
    const pauseResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/pause');
    await control(page,r,'pause').click();const pause=await pauseResponse;expect(pause.status()).toBe(200);expect(pause.request().headers()['x-bb-csrf']).toBe(r.csrf);
    releaseOriginal();expect(await worker).toBe('paused');worker=undefined;
    const host=await ready(page,r),before=await r.evidence();
    const walletPaused=await captureWallet(r,'paused');assertPausedWallet(walletBeforePause,walletPaused,original.reservation_id);
    await writeFile(join(r.artifactRoot,'before-evidence.json'),JSON.stringify(before,null,2));
    const oldArtifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows;
    expect(oldArtifacts.length).toBeGreaterThan(0);expect(await r.calls()).toHaveLength(1);
    const originalWordEvidence:Array<{artifact_id:string;sha256:string;read_method:'persisted_private_blob';word_check:{paragraphs:number;text:string}}>=[];
    for(const artifact of oldArtifacts.filter(row=>row.media_type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document')){
      // V1 is still paused and correctly unavailable through public delivery.
      // Inspect its exact persisted private object without changing that boundary.
      const bytes=await r.blobs.get(artifact.object_key);expect(digest(bytes)).toBe(artifact.sha256.trim());
      const path=join(r.artifactRoot,`original-${originalWordEvidence.length+1}.docx`);await writeFile(path,bytes);const word=readWord(r.python,path);
      expect(word.text).not.toContain(materialMarker);originalWordEvidence.push({artifact_id:artifact.id,sha256:digest(bytes),read_method:'persisted_private_blob',word_check:word});
    }
    expect(originalWordEvidence.length).toBeGreaterThan(0);expect((await r.calls())[0].reflected_material_marker).toBeNull();
    const oldObjects=new Map([...r.objects].map(([key,bytes])=>[key,digest(bytes)]));
    const supplement=Buffer.from(`${materialMarker}\nSynthetic ${kind} desktop evidence, adopted only after explicit B1 consent.`);
    await host.locator('[data-supplement-intent]').selectOption('');await host.locator('[data-supplement-role]').selectOption('audit');
    const uploadResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname));
    await host.locator('[data-supplement-file]').setInputFiles({name:`synthetic-${kind}-browser-evidence.txt`,mimeType:'text/plain',buffer:supplement});
    const uploaded=await uploadResponse;expect(uploaded.status()).toBe(200);const material=await uploaded.json();expect(material.sha256).toBe(digest(supplement));
    const savedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===protocol+'/supplement-draft');
    await expect(action(host,'save')).toBeEnabled();await action(host,'save').click();const savedHttp=await savedResponse;expect(savedHttp.status()).toBe(200);const saved=await savedHttp.json();
    expect(saved.saved_work.status).toBe('captured');expect(saved.saved_work.result_count).toBeGreaterThan(0);expect(saved.input_preview.status).toBe('prepared');
    expect(saved.changes.some((change:any)=>change.material.material_id===material.material_id)).toBe(true);
    const walletSaved=await captureWallet(r,'supplement_saved');assertWalletUnchanged(walletPaused,walletSaved);
    const quoteResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-quotes');
    await expect(action(host,'quote')).toBeEnabled();await action(host,'quote').click();const quoteHttp=await quoteResponse;expect(quoteHttp.status()).toBe(200);const quote=await quoteHttp.json();
    expect(quote.quote.total_points).toBe(4500);expect(quote.quote.items).toHaveLength(1);expect(quote.quote.items[0].needs_redo).toBe(true);
    expect(quoteHttp.request().postDataJSON()).toMatchObject({supplement_revision:saved.revision,saved_request_id:saved.request_id,candidate_input_hash:saved.input_preview.candidate_input_hash});
    await expect(action(host,'adopt')).toHaveText('确认追加 4500 积分并继续');
    expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_adoptions WHERE run_id=$1',[r.runId])).rows[0].n).toBe(0);
    expect((await r.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(1);
    await page.screenshot({path:join(r.artifactRoot,'b1-quote-full.png'),fullPage:true});
    const confirmedBefore=(await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n;
    await page.reload();const restored=await ready(page,r);await expect(action(restored,'adopt')).toBeEnabled();
    expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(confirmedBefore);
    expect(await r.calls()).toHaveLength(1);
    const walletBeforeConsent=await captureWallet(r,'before_adoption_consent');assertWalletUnchanged(walletPaused,walletBeforeConsent);
    const adoptResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-adoptions');
    await action(restored,'adopt').click();const adoptionHttp=await adoptResponse;expect(adoptionHttp.status()).toBe(200);const adoption=(await adoptionHttp.json()).adoption;
    expect(adoption).toMatchObject({run_id:r.runId,execution_version:2,assignment_kind:'rework',additional_points:4500});expect(adoption.reservation_id).not.toBe(original.reservation_id);
    const adoptRequest=adoptionHttp.request().postDataJSON();expect(Object.keys(adoptRequest).sort()).toEqual(['confirmation_id','quote_hash','quote_id','request_id']);
    expect(adoptionHttp.request().headers()['x-bb-csrf']).toBe(r.csrf);
    expect((await r.pool.query('SELECT state FROM bb_credit_reservations WHERE id=$1',[original.reservation_id])).rows[0].state).toBe('settled');
    const walletAdopted=await captureWallet(r,'adopted');assertAdoptedWallet(walletBeforeConsent,walletAdopted,original.reservation_id,adoption.reservation_id);
    await expect(restored.locator('[data-supplement-adoption]')).toContainText('补料已采用');
    await page.screenshot({path:join(r.artifactRoot,'adopted-before-worker.png'),fullPage:true});
    let atSuccessorResult=false,successorError:unknown;const releaseV2=new Promise<void>(resolve=>{releaseSuccessor=resolve;});
    worker=executeWhenAvailable(r,async stage=>{if(stage==='model_generation'){atSuccessorResult=true;await releaseV2;}});void worker.catch(error=>{successorError=error;});
    await expect.poll(()=>{if(successorError)throw successorError;return atSuccessorResult;},{timeout:90000}).toBe(true);
    await expect(control(page,r,'pause')).toBeVisible({timeout:15000});
    const pauseV2Response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/pause');
    await control(page,r,'pause').click();expect((await pauseV2Response).status()).toBe(200);releaseSuccessor();expect(await worker).toBe('paused');worker=undefined;
    expect(await r.calls()).toHaveLength(2);
    const headBeforeResume=(await r.pool.query('SELECT execution_version,input_revision,input_hash FROM bb_run_execution_heads WHERE run_id=$1',[r.runId])).rows;
    const scope=`${encodeURIComponent(r.owner)}:${encodeURIComponent(r.projectId)}:${encodeURIComponent(r.runId)}`;
    const localKeys=[`bondbuddy:run-supplement:v1:${scope}`,`bondbuddy:run-supplement-adoption:v1:${scope}`];
    await page.evaluate(keys=>{for(const key of keys)localStorage.removeItem(key);},localKeys);
    const draftReadsBeforeRecovery=network.filter(row=>row.method==='GET'&&row.path.startsWith(protocol+'/supplement-draft')).length;
    const currentResponse=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===protocol+'/supplement-adoptions/current');
    await page.reload();const currentHttp=await currentResponse;expect(currentHttp.status()).toBe(200);expect((await currentHttp.json()).adoption).toEqual(adoption);
    await expect(panel(page,r).locator('[data-supplement-adoption]')).toContainText('补料已采用');
    await expect(control(page,r,'resume')).toHaveText('继续当前任务');
    expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),localKeys)).toEqual([null,null]);
    const countsBeforeResume=(await r.pool.query(`SELECT
      (SELECT count(*)::int FROM bb_run_supplement_quotes WHERE run_id=$1) AS quotes,
      (SELECT count(*)::int FROM bb_run_supplement_quote_confirmations WHERE run_id=$1) AS confirmations,
      (SELECT count(*)::int FROM bb_run_supplement_adoptions WHERE run_id=$1) AS adoptions,
      (SELECT count(*)::int FROM bb_credit_reservations WHERE run_id=$1) AS fees`,[r.runId])).rows[0];
    const resumeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/resume');
    await control(page,r,'resume').click();expect((await resumeResponse).status()).toBe(200);await expect(page.locator('.run-supplement-resume-dialog')).toHaveCount(0);
    expect(network.filter(row=>row.method==='GET'&&row.path.startsWith(protocol+'/supplement-draft')).length).toBe(draftReadsBeforeRecovery);
    expect((await r.pool.query('SELECT execution_version,input_revision,input_hash FROM bb_run_execution_heads WHERE run_id=$1',[r.runId])).rows).toEqual(headBeforeResume);
    expect(await executeWhenAvailable(r)).toBe('succeeded');
    expect((await r.pool.query(`SELECT
      (SELECT count(*)::int FROM bb_run_supplement_quotes WHERE run_id=$1) AS quotes,
      (SELECT count(*)::int FROM bb_run_supplement_quote_confirmations WHERE run_id=$1) AS confirmations,
      (SELECT count(*)::int FROM bb_run_supplement_adoptions WHERE run_id=$1) AS adoptions,
      (SELECT count(*)::int FROM bb_credit_reservations WHERE run_id=$1) AS fees`,[r.runId])).rows[0]).toEqual(countsBeforeResume);
    const completed=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
    expect(completed).toMatchObject({state:'succeeded',input_revision:original.input_revision,input_hash:original.input_hash,reservation_id:original.reservation_id,billing_mode:original.billing_mode});
    const walletSucceeded=await captureWallet(r,'succeeded');
    const calls=await r.calls();expect(calls).toHaveLength(2);expect(calls[1].input_hash).toBe(adoption.input_hash);expect(calls[1].continuation).toBeTruthy();expect(calls[1].materials).toContain(material.material_id);
    expect(calls[1].reflected_material_marker).toBe(materialMarker);
    expect(calls[1].reflected_material_reads).toContainEqual(expect.objectContaining({material_id:material.material_id,sha256:material.sha256,marker:materialMarker}));
    const attempts=(await r.pool.query(`SELECT a.id,a.status,b.execution_version,b.input_hash FROM bb_model_call_attempts a
      JOIN bb_model_call_execution_bindings b ON b.attempt_id=a.id WHERE a.job_id=$1 ORDER BY b.execution_version`,[r.jobId])).rows;
    expect(attempts.map(row=>[row.execution_version,row.status])).toEqual([[1,'completed'],[2,'completed']]);
    const artifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=2 ORDER BY id',[r.runId])).rows;
    expect(artifacts.length).toBeGreaterThan(0);for(const artifact of artifacts){expect(artifact.input_hash.trim()).toBe(adoption.input_hash);expect(oldArtifacts.some(old=>old.id===artifact.id)).toBe(false);}
    expect((await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows).toEqual(oldArtifacts);
    for(const [key,hash] of oldObjects)expect(digest(await r.blobs.get(key)),key).toBe(hash);
    const fee=(await r.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[adoption.reservation_id])).rows[0];expect(fee.state).toBe('settled');expect(Number(fee.charged_points)).toBe(4500);
    const walletChecks=await writeFiveStageWallet(r,{before_pause:walletBeforePause,paused:walletPaused,supplement_saved:walletSaved,
      before_adoption_consent:walletBeforeConsent,succeeded:walletSucceeded},walletAdopted,original.reservation_id,adoption.reservation_id);
    // Reopen the real current task route; UI downloads choose persisted execution2 artifacts.
    await page.goto(r.baseURL+r.route);
    if(r.surface==='m3')await page.getByRole('button',{name:'查看复核结果',exact:true}).click();
    const button=r.surface==='m1'?page.locator('[data-artifact-file="0"]'):
      r.surface==='m3'?page.locator('[data-review-action="download"]').filter({hasText:'复核报告'}).first():page.locator('[data-m4-action="download"]').filter({hasText:'正文 Word'}).first();
    await expect(button).toBeVisible({timeout:20000});
    const bytesResponse=page.waitForResponse(response=>response.request().method()==='GET'&&
      /^\/api\/v1\/(?:m4\/)?artifacts\/[^/]+\/(?:download|versions\/\d+\/bytes)$/.test(new URL(response.url()).pathname));
    const downloadEvent=page.waitForEvent('download');await button.click();const download=await downloadEvent;const downloadedPath=join(r.artifactRoot,'browser-downloaded-successor.docx');await download.saveAs(downloadedPath);
    const deliveredHttp=await bytesResponse;expect(deliveredHttp.status()).toBe(200);
    const artifactId=new URL(deliveredHttp.url()).pathname.match(/\/artifacts\/([^/]+)\//)![1];
    const downloaded=await readFile(downloadedPath),downloadedHash=digest(downloaded),artifact=artifacts.find(row=>row.id===artifactId);expect(artifact).toBeTruthy();expect(artifact.sha256.trim()).toBe(downloadedHash);
    const wordCheck=readWord(r.python,downloadedPath);expect(wordCheck.text).toContain(materialMarker);
    expect(originalWordEvidence.some(row=>row.sha256===downloadedHash)).toBe(false);
    const descriptor=await r.request('GET',`/api/v1/artifacts/${artifact.id}`);expect(descriptor.sha256).toBe(downloadedHash);expect(descriptor.delivery_status).toBe('available');
    const unauthenticated=await fetch(r.baseURL+descriptor.download_url);expect(unauthenticated.status).toBe(401);await unauthenticated.arrayBuffer();
    const privateBytes=await fetch(r.baseURL+descriptor.download_url,{headers:r.headers});expect(privateBytes.status).toBe(200);expect(digest(Buffer.from(await privateBytes.arrayBuffer()))).toBe(downloadedHash);
    const foreign=uid(),foreignAccess=uid();await r.pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[foreign,'foreign_'+uid().replaceAll('-','').slice(0,16)]);
    await r.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
      VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),foreign,digest(foreignAccess),digest(uid()),digest(uid())]);
    const forbidden=await fetch(r.baseURL+descriptor.download_url,{headers:{cookie:`bb_session=${foreignAccess}`}});expect(forbidden.status).toBe(404);await forbidden.arrayBuffer();
    const terminalReceipt=await r.request('GET',protocol+'/supplement-adoptions?request_id='+encodeURIComponent(adoptRequest.request_id));expect(terminalReceipt.adoption).toEqual(adoption);expect(await r.calls()).toHaveLength(2);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:join(r.artifactRoot,'successor-word-downloaded-full.png'),fullPage:true});
    await writeFile(join(r.artifactRoot,'assertions.json'),JSON.stringify({synthetic_provider:true,synthetic_credit_lot:true,real_browser_http_pg_worker:true,
      cloned_database:r.cloneName,original,uploaded_material:material,saved,quote,adoption,adopt_request:adoptRequest,attempts,downloaded_artifact:artifact,
      downloaded_sha256:downloadedHash,browser_byte_route:new URL(deliveredHttp.url()).pathname,word_check:wordCheck,
      original_word_evidence:originalWordEvidence,adopted_material_marker:materialMarker,marker_read_from_uploaded_bytes:true,wallet_checks:walletChecks,
      resumed_without_local_journal:true,head_before_resume:headBeforeResume,counts_before_resume:countsBeforeResume,before,after:await r.evidence(),network},null,2));
    businessEvidenceComplete=true;
  }finally{
    releaseOriginal();releaseSuccessor();if(worker)await worker.catch(()=>undefined);
    await page.screenshot({path:join(r.artifactRoot,'end-state-full.png'),fullPage:true}).catch(()=>undefined);
    await page.goto('about:blank').catch(()=>undefined);
    await writeFile(join(r.artifactRoot,'after-evidence.json'),JSON.stringify(await r.evidence(),null,2));
    await r.request('POST',protocol+'/cancel',{reason:'Private browser fixture cleanup'}).catch(()=>undefined);
    await writeFile(join(r.artifactRoot,'network.json'),JSON.stringify(network,null,2));
    const browserAtBlank=page.url()==='about:blank';
    const browserTeardown=[{phase:'before_context_close',at:new Date().toISOString(),business_evidence_complete:businessEvidenceComplete,browser_at_blank:browserAtBlank}];
    await writeFile(join(r.artifactRoot,'owned-browser-teardown.json'),JSON.stringify(browserTeardown,null,2));
    await context.close();browserTeardown.push({phase:'after_context_close',at:new Date().toISOString(),business_evidence_complete:businessEvidenceComplete,browser_at_blank:browserAtBlank});
    await writeFile(join(r.artifactRoot,'owned-browser-teardown.json'),JSON.stringify(browserTeardown,null,2));
    await r.close({business_evidence_complete:businessEvidenceComplete,browser_at_blank:browserAtBlank,browser_context_closed:true});
  }
});
