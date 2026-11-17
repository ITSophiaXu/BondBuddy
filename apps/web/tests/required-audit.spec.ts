import {expect, test} from '@playwright/test';
import {fixture, install, projectId, sourceDeclaration, expectNoExecution, assertFixture, material, now, sha256} from './authoring-source-guide-fixtures';
import {AUDIT_REPORT_REQUIRED_MESSAGE} from '@bondbuddy/contracts';

test.afterEach(async ({page}) => { await assertFixture(page); });

for (const supplementary of [false,true]) test('audit is required even with complete source information: supplementary='+supplementary, async ({page}) => {
  const s=fixture(), audit=s.materials.find(m=>m.role==='audit')!;
  s.materials=s.materials.filter(m=>m.role!=='audit');
  if(supplementary)for(const role of ['financial','interimFinancial','notes'] as const)s.materials.push(material(role,1,role,role+'.pdf'));
  s.project.update_details!.source_prospectuses=s.materials.filter(m=>['historical','reference'].includes(m.role)).map(m=>sourceDeclaration(m));
  await install(page,s);
  await page.goto('/#/projects/'+projectId+'?step=materials');
  await expect(page.locator('[data-material-role="audit"] .material-role-heading > div > strong')).toHaveText('审计报告（可含报表及附注）（必填）');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toHaveText(AUDIT_REPORT_REQUIRED_MESSAGE);
  await page.locator('#execute-input').dispatchEvent('click');
  expectNoExecution(s);expect(s.locked).toEqual([]);expect(s.quotes).toEqual([]);
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    if(process.env.BB_AUDIT_EVIDENCE)await page.screenshot({path:process.env.BB_AUDIT_EVIDENCE+'/audit-required-'+width+'.png',fullPage:true});
  }
  s.materials.push(audit);
  await page.reload();
  await expect(page.locator('#execute-input')).toBeEnabled();
  s.materials=s.materials.filter(m=>m.role!=='audit');
  await page.reload();
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toHaveText(AUDIT_REPORT_REQUIRED_MESSAGE);
  expectNoExecution(s);
});

test('a previous generated result does not replace the required audit',async({page})=>{
  const s=fixture();s.materials=s.materials.filter(m=>m.role==='financial');s.project.update_details!.source_prospectuses=[];
  s.prospectusVersions={project_id:projectId,current_version_id:'generated',selection_revision:3,inactive_material_ids:[],versions:[{
    version_id:'generated',sequence:1,origin:'generated',filename:'合成上一轮募集书.docx',sha256:sha256('result'),created_at:now,
    material_id:null,material_version:null,artifact_id:'artifact',artifact_version:1,revision_artifact_id:null,run_id:'previous-run'}]};
  await install(page,s);await page.goto('/#/projects/'+projectId+'?step=materials');
  await expect(page.locator('#execute-input')).toBeDisabled();
  await expect(page.locator('#start-disabled-reason')).toHaveText(AUDIT_REPORT_REQUIRED_MESSAGE);
  await page.locator('#execute-input').dispatchEvent('click');expectNoExecution(s);expect(s.locked).toEqual([]);
});
