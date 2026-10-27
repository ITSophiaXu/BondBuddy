# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: run-supplement-production-real-main.spec.ts >> real desktop review: saved Word work → browser B1 quote/consent/adoption → real successor worker → private new Word
- Location: tests\run-supplement-production-real-main.spec.ts:25:56

# Error details

```
Error: Traceback (most recent call last):
  File "<string>", line 1, in <module>
  File "C:\Users\lezhai\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\Lib\encodings\cp1252.py", line 19, in encode
    return codecs.charmap_encode(input,self.errors,encoding_table)[0]
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
UnicodeEncodeError: 'charmap' codec can't encode characters in position 113-116: character maps to <undefined>


expect(received).toBe(expected) // Object.is equality

Expected: 0
Received: 1
```

# Test source

```ts
  36  |       ...(url.pathname.includes('/supplement-')&&request.method()!=='GET'?{body:request.postDataJSON()}: {})});});
  37  |     const original=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
  38  |     expect(original).toMatchObject({state:'queued',channel:'production',test_grant_id:null});expect(original.reservation_id).toBeTruthy();
  39  |     await page.goto(r.baseURL+r.route);await expect(control(page,r,'pause')).toBeVisible({timeout:15000});
  40  |     let atWord=false,workerError:unknown;const release=new Promise<void>(resolve=>{releaseOriginal=resolve;});
  41  |     worker=executeWhenAvailable(r,async stage=>{if(stage==='word_promoted'){atWord=true;await release;}});void worker.catch(error=>{workerError=error;});
  42  |     await expect.poll(()=>{if(workerError)throw workerError;return atWord;},{timeout:90000}).toBe(true);
  43  |     const pauseResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/pause');
  44  |     await control(page,r,'pause').click();const pause=await pauseResponse;expect(pause.status()).toBe(200);expect(pause.request().headers()['x-bb-csrf']).toBe(r.csrf);
  45  |     releaseOriginal();expect(await worker).toBe('paused');worker=undefined;
  46  |     const host=await ready(page,r),before=await r.evidence();
  47  |     await writeFile(join(r.artifactRoot,'before-evidence.json'),JSON.stringify(before,null,2));
  48  |     const oldArtifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows;
  49  |     expect(oldArtifacts.length).toBeGreaterThan(0);expect(await r.calls()).toHaveLength(1);
  50  |     const oldObjects=new Map([...r.objects].map(([key,bytes])=>[key,digest(bytes)]));
  51  |     const supplement=Buffer.from(`SYNTHETIC ${kind} desktop evidence, adopted only after explicit B1 consent.`);
  52  |     await host.locator('[data-supplement-intent]').selectOption('');await host.locator('[data-supplement-role]').selectOption('audit');
  53  |     const uploadResponse=page.waitForResponse(response=>response.request().method()==='POST'&&/\/materials\/uploads\/[^/]+\/complete$/.test(new URL(response.url()).pathname));
  54  |     await host.locator('[data-supplement-file]').setInputFiles({name:`synthetic-${kind}-browser-evidence.txt`,mimeType:'text/plain',buffer:supplement});
  55  |     const uploaded=await uploadResponse;expect(uploaded.status()).toBe(200);const material=await uploaded.json();expect(material.sha256).toBe(digest(supplement));
  56  |     const savedResponse=page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===protocol+'/supplement-draft');
  57  |     await expect(action(host,'save')).toBeEnabled();await action(host,'save').click();const savedHttp=await savedResponse;expect(savedHttp.status()).toBe(200);const saved=await savedHttp.json();
  58  |     expect(saved.saved_work.status).toBe('captured');expect(saved.saved_work.result_count).toBeGreaterThan(0);expect(saved.input_preview.status).toBe('prepared');
  59  |     expect(saved.changes.some((change:any)=>change.material.material_id===material.material_id)).toBe(true);
  60  |     const quoteResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-quotes');
  61  |     await expect(action(host,'quote')).toBeEnabled();await action(host,'quote').click();const quoteHttp=await quoteResponse;expect(quoteHttp.status()).toBe(200);const quote=await quoteHttp.json();
  62  |     expect(quote.quote.total_points).toBe(4500);expect(quote.quote.items).toHaveLength(1);expect(quote.quote.items[0].needs_redo).toBe(true);
  63  |     expect(quoteHttp.request().postDataJSON()).toMatchObject({supplement_revision:saved.revision,saved_request_id:saved.request_id,candidate_input_hash:saved.input_preview.candidate_input_hash});
  64  |     await expect(action(host,'adopt')).toHaveText('确认追加 4500 积分并继续');
  65  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_adoptions WHERE run_id=$1',[r.runId])).rows[0].n).toBe(0);
  66  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_credit_reservations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(1);
  67  |     await page.screenshot({path:join(r.artifactRoot,'b1-quote-full.png'),fullPage:true});
  68  |     const confirmedBefore=(await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n;
  69  |     await page.reload();const restored=await ready(page,r);await expect(action(restored,'adopt')).toBeEnabled();
  70  |     expect((await r.pool.query('SELECT count(*)::int n FROM bb_run_supplement_quote_confirmations WHERE run_id=$1',[r.runId])).rows[0].n).toBe(confirmedBefore);
  71  |     expect(await r.calls()).toHaveLength(1);
  72  |     const adoptResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/supplement-adoptions');
  73  |     await action(restored,'adopt').click();const adoptionHttp=await adoptResponse;expect(adoptionHttp.status()).toBe(200);const adoption=(await adoptionHttp.json()).adoption;
  74  |     expect(adoption).toMatchObject({run_id:r.runId,execution_version:2,assignment_kind:'rework',additional_points:4500});expect(adoption.reservation_id).not.toBe(original.reservation_id);
  75  |     const adoptRequest=adoptionHttp.request().postDataJSON();expect(Object.keys(adoptRequest).sort()).toEqual(['confirmation_id','quote_hash','quote_id','request_id']);
  76  |     expect(adoptionHttp.request().headers()['x-bb-csrf']).toBe(r.csrf);
  77  |     expect((await r.pool.query('SELECT state FROM bb_credit_reservations WHERE id=$1',[original.reservation_id])).rows[0].state).toBe('settled');
  78  |     await expect(restored.locator('[data-supplement-adoption]')).toContainText('补料已采用');
  79  |     await page.screenshot({path:join(r.artifactRoot,'adopted-before-worker.png'),fullPage:true});
  80  |     let atSuccessorResult=false,successorError:unknown;const releaseV2=new Promise<void>(resolve=>{releaseSuccessor=resolve;});
  81  |     worker=executeWhenAvailable(r,async stage=>{if(stage==='model_generation'){atSuccessorResult=true;await releaseV2;}});void worker.catch(error=>{successorError=error;});
  82  |     await expect.poll(()=>{if(successorError)throw successorError;return atSuccessorResult;},{timeout:90000}).toBe(true);
  83  |     await expect(control(page,r,'pause')).toBeVisible({timeout:15000});
  84  |     const pauseV2Response=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/pause');
  85  |     await control(page,r,'pause').click();expect((await pauseV2Response).status()).toBe(200);releaseSuccessor();expect(await worker).toBe('paused');worker=undefined;
  86  |     expect(await r.calls()).toHaveLength(2);
  87  |     const headBeforeResume=(await r.pool.query('SELECT execution_version,input_revision,input_hash FROM bb_run_execution_heads WHERE run_id=$1',[r.runId])).rows;
  88  |     const scope=`${encodeURIComponent(r.owner)}:${encodeURIComponent(r.projectId)}:${encodeURIComponent(r.runId)}`;
  89  |     const localKeys=[`bondbuddy:run-supplement:v1:${scope}`,`bondbuddy:run-supplement-adoption:v1:${scope}`];
  90  |     await page.evaluate(keys=>{for(const key of keys)localStorage.removeItem(key);},localKeys);
  91  |     const draftReadsBeforeRecovery=network.filter(row=>row.method==='GET'&&row.path.startsWith(protocol+'/supplement-draft')).length;
  92  |     const currentResponse=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===protocol+'/supplement-adoptions/current');
  93  |     await page.reload();const currentHttp=await currentResponse;expect(currentHttp.status()).toBe(200);expect((await currentHttp.json()).adoption).toEqual(adoption);
  94  |     await expect(panel(page,r).locator('[data-supplement-adoption]')).toContainText('补料已采用');
  95  |     await expect(control(page,r,'resume')).toHaveText('继续当前任务');
  96  |     expect(await page.evaluate(keys=>keys.map(key=>localStorage.getItem(key)),localKeys)).toEqual([null,null]);
  97  |     const countsBeforeResume=(await r.pool.query(`SELECT
  98  |       (SELECT count(*)::int FROM bb_run_supplement_quotes WHERE run_id=$1) AS quotes,
  99  |       (SELECT count(*)::int FROM bb_run_supplement_quote_confirmations WHERE run_id=$1) AS confirmations,
  100 |       (SELECT count(*)::int FROM bb_run_supplement_adoptions WHERE run_id=$1) AS adoptions,
  101 |       (SELECT count(*)::int FROM bb_credit_reservations WHERE run_id=$1) AS fees`,[r.runId])).rows[0];
  102 |     const resumeResponse=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname===protocol+'/resume');
  103 |     await control(page,r,'resume').click();expect((await resumeResponse).status()).toBe(200);await expect(page.locator('.run-supplement-resume-dialog')).toHaveCount(0);
  104 |     expect(network.filter(row=>row.method==='GET'&&row.path.startsWith(protocol+'/supplement-draft')).length).toBe(draftReadsBeforeRecovery);
  105 |     expect((await r.pool.query('SELECT execution_version,input_revision,input_hash FROM bb_run_execution_heads WHERE run_id=$1',[r.runId])).rows).toEqual(headBeforeResume);
  106 |     expect(await executeWhenAvailable(r)).toBe('succeeded');
  107 |     expect((await r.pool.query(`SELECT
  108 |       (SELECT count(*)::int FROM bb_run_supplement_quotes WHERE run_id=$1) AS quotes,
  109 |       (SELECT count(*)::int FROM bb_run_supplement_quote_confirmations WHERE run_id=$1) AS confirmations,
  110 |       (SELECT count(*)::int FROM bb_run_supplement_adoptions WHERE run_id=$1) AS adoptions,
  111 |       (SELECT count(*)::int FROM bb_credit_reservations WHERE run_id=$1) AS fees`,[r.runId])).rows[0]).toEqual(countsBeforeResume);
  112 |     const completed=(await r.pool.query('SELECT * FROM bb_runs WHERE id=$1',[r.runId])).rows[0];
  113 |     expect(completed).toMatchObject({state:'succeeded',input_revision:original.input_revision,input_hash:original.input_hash,reservation_id:original.reservation_id,billing_mode:original.billing_mode});
  114 |     const calls=await r.calls();expect(calls).toHaveLength(2);expect(calls[1].input_hash).toBe(adoption.input_hash);expect(calls[1].continuation).toBeTruthy();expect(calls[1].materials).toContain(material.material_id);
  115 |     const attempts=(await r.pool.query(`SELECT a.id,a.status,b.execution_version,b.input_hash FROM bb_model_call_attempts a
  116 |       JOIN bb_model_call_execution_bindings b ON b.attempt_id=a.id WHERE a.job_id=$1 ORDER BY b.execution_version`,[r.jobId])).rows;
  117 |     expect(attempts.map(row=>[row.execution_version,row.status])).toEqual([[1,'completed'],[2,'completed']]);
  118 |     const artifacts=(await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=2 ORDER BY id',[r.runId])).rows;
  119 |     expect(artifacts.length).toBeGreaterThan(0);for(const artifact of artifacts){expect(artifact.input_hash.trim()).toBe(adoption.input_hash);expect(oldArtifacts.some(old=>old.id===artifact.id)).toBe(false);}
  120 |     expect((await r.pool.query('SELECT * FROM bb_artifact_versions WHERE run_id=$1 AND execution_version=1 ORDER BY id',[r.runId])).rows).toEqual(oldArtifacts);
  121 |     for(const [key,hash] of oldObjects)expect(digest(await r.blobs.get(key)),key).toBe(hash);
  122 |     const fee=(await r.pool.query('SELECT * FROM bb_credit_reservations WHERE id=$1',[adoption.reservation_id])).rows[0];expect(fee.state).toBe('settled');expect(Number(fee.charged_points)).toBe(4500);
  123 |     // Reopen the real current task route; UI downloads choose persisted execution2 artifacts.
  124 |     await page.goto(r.baseURL+r.route);
  125 |     if(r.surface==='m3')await page.getByRole('button',{name:'查看复核结果',exact:true}).click();
  126 |     const button=r.surface==='m1'?page.locator('[data-artifact-file="0"]'):
  127 |       r.surface==='m3'?page.locator('[data-review-action="download"]').filter({hasText:'复核报告'}).first():page.locator('[data-m4-action="download"]').filter({hasText:'正文 Word'}).first();
  128 |     await expect(button).toBeVisible({timeout:20000});
  129 |     const bytesResponse=page.waitForResponse(response=>response.request().method()==='GET'&&
  130 |       /^\/api\/v1\/(?:m4\/)?artifacts\/[^/]+\/(?:download|versions\/\d+\/bytes)$/.test(new URL(response.url()).pathname));
  131 |     const downloadEvent=page.waitForEvent('download');await button.click();const download=await downloadEvent;const downloadedPath=join(r.artifactRoot,'browser-downloaded-successor.docx');await download.saveAs(downloadedPath);
  132 |     const deliveredHttp=await bytesResponse;expect(deliveredHttp.status()).toBe(200);
  133 |     const artifactId=new URL(deliveredHttp.url()).pathname.match(/\/artifacts\/([^/]+)\//)![1];
  134 |     const downloaded=await readFile(downloadedPath),downloadedHash=digest(downloaded),artifact=artifacts.find(row=>row.id===artifactId);expect(artifact).toBeTruthy();expect(artifact.sha256.trim()).toBe(downloadedHash);
  135 |     const wordCheck=spawnSync(r.python,['-c','from docx import Document; import sys,json; d=Document(sys.argv[1]); print(json.dumps({"paragraphs":len(d.paragraphs),"text":"\\n".join(p.text for p in d.paragraphs)},ensure_ascii=False))',downloadedPath],{encoding:'utf8'});
> 136 |     expect(wordCheck.status,wordCheck.stderr).toBe(0);expect(JSON.parse(wordCheck.stdout).paragraphs).toBeGreaterThan(0);
      |                                               ^ Error: Traceback (most recent call last):
  137 |     const descriptor=await r.request('GET',`/api/v1/artifacts/${artifact.id}`);expect(descriptor.sha256).toBe(downloadedHash);expect(descriptor.delivery_status).toBe('available');
  138 |     expect((await fetch(r.baseURL+descriptor.download_url)).status).toBe(401);
  139 |     const privateBytes=await fetch(r.baseURL+descriptor.download_url,{headers:r.headers});expect(privateBytes.status).toBe(200);expect(digest(Buffer.from(await privateBytes.arrayBuffer()))).toBe(downloadedHash);
  140 |     const foreign=uid(),foreignAccess=uid();await r.pool.query('INSERT INTO bb_users(id,username) VALUES($1,$2)',[foreign,'foreign_'+uid().replaceAll('-','').slice(0,16)]);
  141 |     await r.pool.query(`INSERT INTO bb_auth_sessions(id,user_id,access_hash,refresh_hash,csrf_hash,access_expires_at,refresh_expires_at)
  142 |       VALUES($1,$2,$3,$4,$5,now()+interval '1 hour',now()+interval '1 day')`,[uid(),foreign,digest(foreignAccess),digest(uid()),digest(uid())]);
  143 |     expect((await fetch(r.baseURL+descriptor.download_url,{headers:{cookie:`bb_session=${foreignAccess}`}})).status).toBe(404);
  144 |     const terminalReceipt=await r.request('GET',protocol+'/supplement-adoptions?request_id='+encodeURIComponent(adoptRequest.request_id));expect(terminalReceipt.adoption).toEqual(adoption);expect(await r.calls()).toHaveLength(2);
  145 |     expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  146 |     await page.screenshot({path:join(r.artifactRoot,'successor-word-downloaded-full.png'),fullPage:true});
  147 |     await writeFile(join(r.artifactRoot,'assertions.json'),JSON.stringify({synthetic_provider:true,synthetic_credit_lot:true,real_browser_http_pg_worker:true,
  148 |       cloned_database:r.cloneName,original,uploaded_material:material,saved,quote,adoption,adopt_request:adoptRequest,attempts,downloaded_artifact:artifact,
  149 |       downloaded_sha256:downloadedHash,browser_byte_route:new URL(deliveredHttp.url()).pathname,word_check:JSON.parse(wordCheck.stdout),
  150 |       resumed_without_local_journal:true,head_before_resume:headBeforeResume,counts_before_resume:countsBeforeResume,before,after:await r.evidence(),network},null,2));
  151 |   }finally{
  152 |     releaseOriginal();releaseSuccessor();if(worker)await worker.catch(()=>undefined);
  153 |     await page.screenshot({path:join(r.artifactRoot,'end-state-full.png'),fullPage:true}).catch(()=>undefined);
  154 |     await page.goto('about:blank').catch(()=>undefined);
  155 |     await writeFile(join(r.artifactRoot,'after-evidence.json'),JSON.stringify(await r.evidence(),null,2));
  156 |     await r.request('POST',protocol+'/cancel',{reason:'Private browser fixture cleanup'}).catch(()=>undefined);
  157 |     await writeFile(join(r.artifactRoot,'network.json'),JSON.stringify(network,null,2));await r.close();
  158 |   }
  159 | });
  160 | 
```