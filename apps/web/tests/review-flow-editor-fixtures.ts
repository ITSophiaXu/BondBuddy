import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import type {ReviewExportRequest} from '@bondbuddy/contracts';
import {fixture as followupFixture,install as installFollowup,projectId,owner,runId,marker} from './review-followup-fixtures';
import {docx} from './word-roundtrip-fixtures';
export {assertFixture,mutations,projectId,owner,runId,marker,title} from './review-followup-fixtures';

// Real workspace controls with schema-checked synthetic public HTTP receipts.
// Minimal OOXML proves only the pinned fixture bytes, not Word layout or workers.
export const savedManual='已保存的人工核对口径：现金流为 130 万元。';
export const secondId=(version:number)=>'flow-terms-'+version;
export const secondTitle=(version:number)=>'V'+version+' 募集条款核验';
export const cacheKey=(run=runId(1),user=owner,project=projectId)=>'bb-review-editor:'+user+':'+project+':'+run;
export function fixture(options:{manualBaseline?:boolean}={}){
  const state=followupFixture(),wordBytes=new Map<string,Buffer>();
  for(const [id,editor]of state.editors){
    const version=Number(id.slice(id.lastIndexOf('-')+1)),first=editor.snapshot.issues[0];
    if(version===2)first.category='发行安排';
    if(options.manualBaseline&&version===1){first.decision='manual';first.manual_text=savedManual;}
    const original='合成成果 V'+version+' 的募集期限为 '+version+' 年。';
    editor.snapshot.paragraphs.push({id:'terms-p'+version,text:original});
    editor.snapshot.issues.push({...structuredClone(first),id:secondId(version),paragraph_id:'terms-p'+version,
      category:version===1?'募集条款':'信息披露',title:secondTitle(version),original,
      replacement:'合成建议 V'+version+' 募集期限为 '+(version+1)+' 年。',reason:'请核验本轮募集期限。',
      evidence:'本轮合成条款材料。',missing:'',uncertain:false,limitation:'',decision:'suggested',manual_text:'',applied:true});
    editor.sha256=createHash('sha256').update(JSON.stringify(editor.snapshot)).digest('hex');
    // Every edition and artifact has distinct bytes, metadata and version pins.
    for(const artifact of state.history.find(entry=>entry.run.run_id===id)!.artifacts){
      const text='合成已保存成果 '+id+' '+artifact.kind+'。'+editor.snapshot.issues.map(issue=>issue.decision==='manual'?issue.manual_text:issue.decision==='suggested'&&!issue.uncertain?issue.replacement:issue.original).join('');
      const bytes=docx(text),sha256=createHash('sha256').update(bytes).digest('hex');wordBytes.set(artifact.artifact_id,bytes);
      state.metadata.get(artifact.artifact_id)!.sha256=sha256;
      const registered=state.catalog.versions.find(item=>item.artifact_id===artifact.artifact_id);if(registered)registered.sha256=sha256;
    }
  }
  return Object.assign(state,{wordBytes});
}
export type State=ReturnType<typeof fixture>;
export const decisions=(state:State,run=runId(1))=>state.editors.get(run)!.snapshot.issues.map(({id,decision,manual_text})=>({id,decision,manual_text}));
export function pending(state:State,requestId='flow-pending-baseline'):ReviewExportRequest{return {request_id:requestId,source_run_id:runId(1),expected_editor_sha256:state.editors.get(runId(1))!.sha256,decisions:decisions(state)};}
export function cacheBody(state:State,values=decisions(state),envelope?:ReviewExportRequest){return JSON.stringify({version:'review-editor-cache-v1',owner,project:projectId,run:runId(1),value:{sha256:state.editors.get(runId(1))!.sha256,decisions:values,...(envelope?{pending:envelope}:{})}});}
export async function install(page:Page,state=fixture()){
  await installFollowup(page,state);
  await page.route('**/api/v1/artifacts/*/download',async route=>{
    const url=new URL(route.request().url()),artifactId=url.pathname.split('/').at(-2)!,bytes=state.wordBytes.get(artifactId);
    if(!bytes)return route.fallback();
    state.calls.push({method:route.request().method(),path:url.pathname.slice('/api/v1'.length),search:url.search});
    return route.fulfill({status:200,contentType:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',body:bytes});
  });
  return state;
}
export async function setup(page:Page,state=fixture(),run=runId(1)){await install(page,state);await page.goto('/#/projects/'+projectId+'/review?tab=results&run='+run);return state;}
export async function editor(page:Page,version=1){const host=page.locator('#review-results-panel');await expect(host.locator('[data-editor-history]')).toHaveValue(runId(version));await expect(host.locator('[data-editor-document]')).toContainText(marker(version));return host;}
