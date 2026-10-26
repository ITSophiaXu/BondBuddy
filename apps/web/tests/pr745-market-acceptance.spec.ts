import {test,expect} from '@playwright/test';
import {M4_DOCUMENT_TYPES} from '@bondbuddy/contracts';
import {fixture,open,ids} from './material-prior-result-fixtures';

for(const type of M4_DOCUMENT_TYPES)test(`project file continuation retains NAFMII / MTN for ${type}`,async({page})=>{
 const s=fixture();s.workspace.active_run=null;s.workspace.tasks=[];s.workspace.artifacts=[];
 s.workspace.view={...s.workspace.view,selected_document_type:type,open_tabs:[],active_tab:null,workspace_tab:'input'};
 const draft=s.workspace.drafts[type];draft.fields.market='nafmii';draft.fields.offering='mtn';
 draft.project_file={project_id:ids.sourceProject,source_version_id:'fixed-source-v2',source_selection_revision:2};
 await open(page,s,{runId:null});
 await expect(page.locator('#m4-market')).toHaveValue('nafmii');await expect(page.locator('#m4-offering')).toHaveValue('mtn');
 await expect(page.locator('#m4-market option[value=nafmii]')).toContainText('交易商协会');
 expect(s.calls.filter(c=>c.path.endsWith('/execute')||c.path.endsWith('/quote'))).toEqual([]);
});
