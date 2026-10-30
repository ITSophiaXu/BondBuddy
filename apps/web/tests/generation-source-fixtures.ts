import {fixtureBody} from './billing-fixture-wire';
import {fixtureRequest} from './billing-fixture-wire';
import {test,expect,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import type {ProspectusVersions} from '@bondbuddy/contracts';
import {fixture,href,ids,now,sha,file,batches} from './generation-entry-fixtures';

// Real page/controller with synthetic HTTP, no real model, storage or billing calls.
export async function sourceFixture(page:Page,current:boolean){
  const state=await fixture(page),workspace=state.workspaces.get(ids.api)!;
  const sourceProject=current?ids.source:ids.api;
  const versions:ProspectusVersions={project_id:sourceProject,selection_revision:current?7:0,current_version_id:current?'source-v3':null,inactive_material_ids:[],versions:current?[{
    version_id:'source-v3',sequence:3,filename:'募集说明书_V3.docx',origin:'upload',sha256:sha,created_at:now,material_id:'source-material',material_version:1,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null,
  }]:[]};
  if(!current)workspace.source=null;
  const selections:any[]=[],receipts=new Map<string,ProspectusVersions>();
  const control={dropSelection:false,conflict:false};
  await page.route('**/api/v1/projects/*/prospectus-versions**',async route=>{
    for(const material of state.materials.values())if(material.role==='historical'&&!versions.versions.some(v=>v.material_id===material.material_id))versions.versions.unshift({
      version_id:'new-source',sequence:4,origin:'upload',filename:material.filename,sha256:material.sha256,created_at:now,material_id:material.material_id,material_version:material.material_version,artifact_id:null,artifact_version:null,revision_artifact_id:null,run_id:null,
    });
    if(route.request().method()==='POST'){
      const body=fixtureRequest(route.request());selections.push(body);
      if(control.conflict){control.conflict=false;return route.fulfill({status:409,json:fixtureBody(route,{code:'INPUT_REVISION_CONFLICT'})});}
      if(!receipts.has(body.request_id)){
        expect(body.expected_selection_revision).toBe(versions.selection_revision);versions.current_version_id=body.version_id;versions.selection_revision++;
        const v=versions.versions.find(v=>v.version_id===body.version_id)!;
        workspace.source={project_id:sourceProject,version_id:v.version_id,sequence:v.sequence,filename:v.filename,selection_revision:versions.selection_revision,
          asset:{kind:'material',pin:{source_project_id:sourceProject,material_id:v.material_id!,material_version:v.material_version!,sha256:v.sha256}}};
        receipts.set(body.request_id,structuredClone(versions));
      }
      if(control.dropSelection){control.dropSelection=false;return route.abort('connectionreset');}
      return route.fulfill({json:fixtureBody(route,receipts.get(body.request_id))});
    }
    return route.fulfill({json:fixtureBody(route,versions)});
  });
  await page.route('**/project-files/source',async route=>{
    const body=fixtureRequest(route.request()),source=workspace.source!;
    expect(body).toEqual({source_version_id:source.version_id,expected_selection_revision:source.selection_revision});
    for(const draft of Object.values(workspace.workspace.drafts))draft.project_file={project_id:ids.api,source_version_id:source.version_id,source_selection_revision:source.selection_revision};
    state.calls.push({method:'POST',path:`/projects/${ids.api}/project-files/source`,body});
    return route.fulfill({json:fixtureBody(route,workspace)});
  });
  await page.route('**/workpapers',route=>route.fulfill({json:fixtureBody(route,{catalogues:[],batches:[],assessments:[]})}));
  return {state,versions,selections,control};
}
