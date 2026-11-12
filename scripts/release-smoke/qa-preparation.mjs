export function qaPreparationURL(projectURL,runId){
 const url=new URL(projectURL),params=new URLSearchParams(url.hash.split('?')[1]);
 params.set('run',runId);url.hash='#qa?'+params;return url.href;
}

export function qaPreparationResponse(response,projectId,hash){
 try{
  if(response.request().method()!=='POST'||new URL(response.url()).pathname!=='/api/v1/projects/'+encodeURIComponent(projectId)+'/qa/prepare')return false;
  const input=response.request().postDataJSON();
  return !!input?.request_id&&input.source?.kind==='material'&&input.source.pin?.source_project_id===projectId&&input.source.pin.sha256===hash;
 }catch{return false;}
}

/** Record acceptance before waiting for recognition. Resume follows the original
 * prepare run; it must not upload another question list just because prepared=false.
 */
export async function retainQaPreparation(page,{entry,expected,upload,save}){
 const projectId=new URLSearchParams(new URL(entry.projectURL).hash.split('?')[1]).get('project');
 if(!projectId||!/^[a-f0-9]{64}$/.test(expected.sha256??''))throw Error('Invalid QA preparation source');
 const resumed=!!entry.preparationId;
 if(!entry.preparationId){
  if(entry.preparationReceipt)throw Error('QA preparation receipt is unresolved; retain the original request, do not upload again');
  const received=page.waitForResponse(r=>qaPreparationResponse(r,projectId,expected.sha256),{timeout:600000}).then(async response=>{
   const request=response.request().postDataJSON();
   entry.preparationReceipt={request_id:request.request_id,source:request.source,http_status:response.status(),received_at:new Date().toISOString()};save();
   if(response.status()!==200)throw Error('Question preparation failed: HTTP '+response.status());
   const receipt=await response.json();
   if(typeof receipt?.run_id!=='string'||!receipt.run_id)throw Error('Question preparation returned no run ID; do not upload again');
   entry.preparationId=receipt.run_id;save();
  });
  received.catch(()=>{});
  await upload();await received;
 }
 if(resumed)await page.goto(qaPreparationURL(entry.projectURL,entry.preparationId));
 else await page.waitForURL(url=>new URLSearchParams(url.hash.split('?')[1]).get('run')===entry.preparationId,{timeout:60000});
 const response=await page.request.get('/api/v1/projects/'+encodeURIComponent(projectId)+'/qa?run_id='+encodeURIComponent(entry.preparationId),{headers:{'x-bb-qa-history':'answer-sequence-v1'}});
 if(response.status()!==200)throw Error('Cannot read original QA preparation: HTTP '+response.status());
 const workspace=await response.json(),run=workspace.runs?.find(r=>r.run_id===entry.preparationId),pin=run?.manifest?.source?.asset?.pin;
 if(!run||run.operation!=='prepare'||run.manifest?.source?.asset?.kind!=='material'||pin?.source_project_id!==projectId||pin.sha256!==expected.sha256||run.manifest.source.filename!==expected.filename)throw Error('Original QA preparation does not match the question fixture');
 const accepted=entry.preparationReceipt?.source?.pin;
 if(accepted&&(accepted.material_id!==pin.material_id||accepted.material_version!==pin.material_version||accepted.sha256!==pin.sha256))throw Error('Original QA preparation source changed');
 entry.preparationState=run.state;entry.preparationStage=run.stage;save();
 if(!['preparing','queued','running','validating','delivering','settlement_pending','succeeded'].includes(run.state))throw Error('Original QA preparation did not succeed: '+run.state+'/'+run.stage);
 return run;
}
