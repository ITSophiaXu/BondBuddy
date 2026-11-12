import {readFileSync} from 'node:fs';
import {basename} from 'node:path';
import {sha256} from './support.mjs';

export function qaProspectusFixture(path){
 const bytes=readFileSync(path);
 if(!bytes.length)throw Error('Empty QA prospectus fixture');
 return {filename:basename(path),byte_size:bytes.length,sha256:sha256(bytes)};
}

export function matchingQaProspectus(workspace,material,expected,projectId){
 const source=workspace?.prospectus,pin=source?.asset?.pin;
 if(!source||source.project_id!==projectId||!source.version_id||!Number.isSafeInteger(source.selection_revision)||source.selection_revision<0||!Number.isSafeInteger(source.sequence)||source.sequence<1||source.asset?.kind!=='material'||pin?.source_project_id!==projectId||!pin.material_id||!Number.isSafeInteger(pin.material_version)||pin.material_version<1||pin.sha256!==expected.sha256||source.filename!==expected.filename)return null;
 if(!material||material.material_id!==pin.material_id||material.material_version!==pin.material_version||material.filename!==expected.filename||material.sha256!==expected.sha256||material.byte_size!==expected.byte_size||typeof material.persisted_at!=='string'||!Number.isFinite(Date.parse(material.persisted_at)))return null;
 return {project_id:source.project_id,version_id:source.version_id,selection_revision:source.selection_revision,sequence:source.sequence,material_id:pin.material_id,material_version:pin.material_version,...expected,persisted_at:material.persisted_at};
}

/** QA uploads adopt themselves and close their modal. Success is the persisted
 * current source plus the visible round selection, never the modal's lifetime.
 * Read the material independently so this also works with a queued upload receipt.
 */
export async function confirmQaProspectus(page,{projectURL,expected},{timeoutMs=600000,pollMs=1000}={}){
 const projectId=new URLSearchParams(new URL(projectURL).hash.split('?')[1]).get('project');
 if(!projectId||!expected?.filename||!Number.isSafeInteger(expected.byte_size)||expected.byte_size<1||!/^[a-f0-9]{64}$/.test(expected.sha256??''))throw Error('Invalid QA prospectus identity');
 const base='/api/v1/projects/'+encodeURIComponent(projectId),deadline=Date.now()+timeoutMs;
 const readback=async()=>{
  do{
   const response=await page.request.get(base+'/qa',{headers:{'x-bb-qa-history':'answer-sequence-v1'},timeout:Math.max(1,deadline-Date.now())});
   if(response.status()!==200)throw Error('Cannot read QA prospectus: HTTP '+response.status());
   const workspace=await response.json(),pin=workspace.prospectus?.asset?.pin;
   if(workspace.prospectus?.asset?.kind==='material'&&pin?.source_project_id===projectId&&pin.material_id&&Number.isSafeInteger(pin.material_version)&&pin.material_version>0){
    const saved=await page.request.get(base+'/materials/'+encodeURIComponent(pin.material_id)+'?version='+pin.material_version,{timeout:Math.max(1,deadline-Date.now())});
    if(saved.status()!==200&&saved.status()!==202)throw Error('Cannot read persisted QA material: HTTP '+saved.status());
    const source=saved.status()===200?matchingQaProspectus(workspace,await saved.json(),expected,projectId):null;
    const text=await page.locator('.qa-project-materials').innerText({timeout:Math.max(1,deadline-Date.now())});
    if(source&&text.includes('募集说明书已就绪')&&text.includes(expected.filename)&&text.includes('已纳入本轮材料'))return source;
   }
   if(Date.now()>=deadline)break;
   await page.waitForTimeout(Math.min(pollMs,Math.max(1,deadline-Date.now())));
  }while(Date.now()<deadline);
  throw Error('QA prospectus was not adopted with the persisted fixture and selected round material');
 };
 const initial=await readback();
 const dialog=page.locator('dialog[open]').filter({has:page.locator('#qa-prospectus-panel')});
 if(await dialog.count())await dialog.getByRole('button',{name:'关闭',exact:true}).click();
 await page.locator('#qa-refresh-materials').click();
 const refreshed=await readback();
 if(JSON.stringify(refreshed)!==JSON.stringify(initial))throw Error('QA prospectus changed after material refresh');
 await page.reload();
 const reloaded=await readback();
 if(JSON.stringify(reloaded)!==JSON.stringify(initial))throw Error('QA prospectus changed after page reload');
 return reloaded;
}
