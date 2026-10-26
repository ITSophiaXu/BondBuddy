import {expect,test,type Page} from '@playwright/test';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {Value} from '@sinclair/typebox/value';
import {ProjectFileVersionSchema} from '@bondbuddy/contracts';
import {assertNoBusiness,fixture,ids,install,ready} from './project-file-return-fixtures';
import {captureProjectFileStatus,installProjectFileStatusReference} from './project-file-status-reference';

const reference=process.env.BB_PROJECT_FILE_STATUS_REFERENCE==='1';
async function listTop(page:Page){await page.locator('.collection-file-panel').evaluate(e=>e.scrollIntoView({block:'start',behavior:'instant'}));await page.evaluate(()=>scrollBy(0,-24));}
async function requestedGroup(page:Page,key:string){
  if(reference){await page.evaluate(value=>{const query=new URLSearchParams(location.hash.split('?')[1]);query.set('file_status',value);history.replaceState(null,'',location.pathname+location.search+location.hash.split('?')[0]+'?'+query);},key);}
  else {await page.locator('[data-file-status="'+key+'"]').click();await expect(page.locator('[data-file-status="'+key+'"]')).toHaveAttribute('aria-pressed','true');}
}

test('component comparison: exact R33 and current next-action file groups at 1440',async({page})=>{
  await page.setViewportSize({width:1440,height:960});
  const provenance=reference?await installProjectFileStatusReference(page):undefined;
  const s=fixture(),states=['unchecked','stale','updated','conflict','manual','checking','consistent'] as const;
  s.rootProject.name='合成项目文件核对工作台';
  s.registry.filter(v=>v.latest).forEach((v,index)=>{const status=states[index%states.length];v.consistency={status,count:status==='conflict'?2:0,check_run_id:status==='unchecked'?null:'status-visual-check-'+v.document_type};expect(Value.Check(ProjectFileVersionSchema,v)).toBe(true);});
  const browserErrors:string[]=[];page.on('pageerror',e=>browserErrors.push(e.message));
  await install(page,s);let failRegistry=false;
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length);
    if(req.method()==='GET'&&path==='/projects/'+ids.root+'/project-files'&&failRegistry){
      s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
      return route.fulfill({status:503,json:{code:'DATA_UNAVAILABLE',message:'Synthetic registry outage',retryable:true,correlation_id:'status-visual-outage',field_errors:[]}});
    }
    return route.fallback();
  });
  await page.goto('/#/projects/'+ids.root+'/files');await ready(page);
  const directory=process.env.BB_PROJECT_FILE_STATUS_EVIDENCE_DIR,prefix=reference?'reference':'implementation';
  const capture=async(name:string)=>{
    await listTop(page);assertNoBusiness(s);expect(browserErrors).toEqual([]);
    if(!reference&&name==='review-files'){
      const info=page.locator('#file-list>.collection-file .collection-file-info').first(),actions=page.locator('#file-list>.collection-file .pw-file-actions').first();
      const textBox=(await info.boundingBox())!,titleBox=(await info.locator('strong').boundingBox())!,actionBox=(await actions.boundingBox())!;
      expect(textBox.width,'normal document names retain readable width').toBeGreaterThanOrEqual(240);
      expect(titleBox.height,'this ordinary legal filename fits at most two lines').toBeLessThanOrEqual(44);
      expect(actionBox.y,'actions do not squeeze or overlap the filename').toBeGreaterThanOrEqual(textBox.y+textBox.height-1);
    }
    if(directory)await captureProjectFileStatus(page,directory,prefix+'-'+name+'-1440',{synthetic:true,scope:'Exact sealed R33 ProjectFiles component or current component, same surrounding application; public-schema synthetic HTTP.',requested_group:name,registry_failure:failRegistry,http:structuredClone(s.calls),business_writes:s.calls.filter(c=>c.method!=='GET'),unexpected:s.unexpected,browser_errors:browserErrors});
  };
  await capture('all-files');
  await requestedGroup(page,'review');await capture('review-files');
  await page.locator('#file-search').fill('没有这份文件_合成空态');await capture('filtered-empty');
  await page.locator('#file-search').fill('');failRegistry=true;
  const registryReads=()=>s.calls.filter(c=>c.method==='GET'&&c.path==='/projects/'+ids.root+'/project-files').length,before=registryReads();
  await page.locator('#refresh-files').click();await expect.poll(registryReads).toBeGreaterThan(before);await expect(page.locator('#refresh-files')).toBeEnabled();
  await expect(page.locator('#file-list>.collection-file').first()).toBeVisible();await capture('registry-unavailable');
  if(provenance&&directory){await mkdir(directory,{recursive:true});await writeFile(join(directory,'reference-provenance-1440.json'),JSON.stringify(await provenance(),null,2));}
  assertNoBusiness(s);
});
