import {test,expect} from '@playwright/test';
import {qaUploadFixture,installQaUpload11th,qaUploadUrl,qaUploadFile,projectId} from './qa-upload-11th-fixtures';

test('QA accepts parse metadata enrichment without reuploading the saved source',async({page})=>{
 const state=qaUploadFixture();state.lostPut=false;state.completeUnavailable=false;state.parseEnrichment=true;
 await installQaUpload11th(page,state);await page.goto(qaUploadUrl);
 await page.locator('#qa-upload').setInputFiles(qaUploadFile('原问题清单.doc'));
 await expect.poll(()=>state.qa.accepted.size).toBe(1);
 expect(state.uploads.size).toBe(1);expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
 expect(state.qa.prepares).toHaveLength(1);
 await expect(page.locator('[data-qa-upload-id]')).toHaveCount(0);
});

test('busy project preserves the exact free prepare request across navigation and retry',async({page})=>{
 const state=qaUploadFixture();state.lostPut=false;state.completeUnavailable=false;
 await installQaUpload11th(page,state);let blocked=true;const attempts:unknown[]=[];
 await page.route(`**/api/v1/projects/${projectId}/qa/prepare`,async route=>{
  attempts.push(route.request().postDataJSON());
  if(blocked)return route.fulfill({status:409,json:{code:'PROJECT_RUN_ACTIVE',message:'Synthetic busy project',retryable:false,correlation_id:'pr745-busy',field_errors:[]}});
  return route.fallback();
 });
 await page.goto(qaUploadUrl);await page.locator('#qa-upload').setInputFiles(qaUploadFile('忙碌期间的问题清单.doc'));
 await expect(page.locator('#qa-retry-pending')).toBeVisible();
 await expect(page.locator('[data-qa-selection]')).toHaveCount(0);
 await page.getByRole('link',{name:'任务进度与结果',exact:true}).click();
 await expect(page.locator('#qa-retry-pending')).toHaveCount(0);
 await page.goto(qaUploadUrl);await expect(page.locator('#qa-retry-pending')).toBeVisible();
 expect(attempts).toHaveLength(1);blocked=false;
 await page.locator('#qa-retry-pending').click();await expect.poll(()=>state.qa.accepted.size).toBe(1);
 expect(attempts).toEqual([attempts[0],attempts[0]]);expect(state.uploads.size).toBe(1);
 expect(state.calls.filter(c=>c.method==='PUT')).toHaveLength(1);
});
