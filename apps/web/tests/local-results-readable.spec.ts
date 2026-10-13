import {test,expect,type APIResponse} from '@playwright/test';
import type {Dto} from '../src/api';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {login} from './live-helpers';

test.skip(process.env.BB_E2E_LOCAL_RESULTS!=='1','Read-only verification against existing local completed projects.');
test('existing local results open at downloads and preserve both real Word files',async({page})=>{
  test.setTimeout(90000);
  if(process.env.BB_E2E_BASE_URL!=='http://localhost:5178')throw Error('Dedicated local test URL required');
  const username=process.env.BB_RESULTS_USER,password=process.env.BB_RESULTS_PASSWORD,output=process.env.BB_RESULTS_LOCAL_EVIDENCE;
  if(!username||!password||!output)throw Error('Local test credentials and evidence directory required');
  await mkdir(output,{recursive:true});const errors:string[]=[],mutations:string[]=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('request',r=>{if(r.method()!=='GET'&&r.url().includes('/api/v1/')&&!r.url().includes('/auth/'))mutations.push(r.method()+' '+new URL(r.url()).pathname);});
  await login(page,{username,password});
  const projects:any[]=[];let cursor:string|null=null;
  do{
    const response:APIResponse=await page.request.get('/api/v1/projects?limit=100'+(cursor?'&cursor='+encodeURIComponent(cursor):''));expect(response.ok()).toBe(true);
    const result:Dto<'ProjectListResponse'>=await response.json();projects.push(...result.items);cursor=result.page.has_more?result.page.next_cursor:null;
  }while(cursor);
  const completed=projects.filter(p=>p.kind==='update'&&p.latest_run?.state==='succeeded'&&p.latest_artifact);
  const candidates=await Promise.all(completed.map(async p=>({project:p,artifact:await(await page.request.get('/api/v1/artifacts/'+p.latest_artifact.artifact_id)).json()})));
  const target=candidates.find(c=>(c.artifact.word_delivery?.authoring_summary?.join('').length??0)>500)??candidates[0];
  expect(target).toBeTruthy();const screenshots=[],summaryWidths=[];
  for(const width of [1920,1440,390]){
    await page.setViewportSize({width,height:width===1920?1080:width===1440?960:844});
    await page.goto('/#/projects/'+target.project.project_id);await page.reload();
    const clean=page.getByRole('button',{name:'下载清洁版',exact:true});await expect(clean).toBeInViewport();
    await expect(page.locator('.artifact-files .button').first()).toHaveText('下载清洁版');
    await expect(page.locator('.artifact-provenance,.artifact-filename')).toHaveCount(0);
    await expect(page.locator('#execution-delivery')).not.toContainText('WPS/Word 兼容范围以实际验收记录为准');
    if(target.artifact.word_delivery?.authoring_summary?.length){await expect(page.locator('.authoring-summary')).toBeVisible();await expect(page.locator('.authoring-summary')).not.toContainText('**');}
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    expect(new Set(await page.evaluate(()=>['#project-materials-details>summary','#artifact-downloads','#artifact-summary'].map(s=>getComputedStyle(document.querySelector(s)!).fontSize))).size).toBe(1);
    const shot=`real-results-${width}.png`;await page.screenshot({path:join(output,shot)});screenshots.push(shot);
    if(target.artifact.word_delivery?.authoring_summary?.length){
      const dimensions=await page.locator('.authoring-summary').evaluate(el=>{
        const parent=el.parentElement!,style=getComputedStyle(parent);
        return {contentWidth:parent.clientWidth-parseFloat(style.paddingLeft)-parseFloat(style.paddingRight),summaryWidth:el.getBoundingClientRect().width};
      });
      expect(Math.abs(dimensions.contentWidth-dimensions.summaryWidth)).toBeLessThanOrEqual(1);
      summaryWidths.push({viewport:width,...dimensions});
      await page.locator('section[aria-labelledby="authoring-summary-title"]').screenshot({path:join(output,`real-authoring-summary-${width}.png`)});
    }
  }
  const files=[];
  for(const [variant,label] of [['clean','清洁版'],['revision','修订版']] as const){
    const metadata=await(await page.request.get('/api/v1/artifacts/'+target.artifact.word_delivery[variant+'_artifact_id'])).json();
    const wait=page.waitForEvent('download');await page.getByRole('button',{name:'下载'+label,exact:true}).click();
    const download=await wait;expect(await download.failure()).toBeNull();const stream=await download.createReadStream(),chunks:Buffer[]=[];
    for await(const chunk of stream!)chunks.push(Buffer.from(chunk));const bytes=Buffer.concat(chunks);
    expect(bytes.length).toBeGreaterThan(1000);expect(createHash('sha256').update(bytes).digest('hex')).toBe(metadata.sha256);
    expect(download.suggestedFilename()).toBe(metadata.filename);files.push({variant,bytes:bytes.length,hashMatches:true});
  }
  const review=projects.find(p=>p.kind==='review'&&p.latest_run);
  if(review){await page.goto(`/#/projects/${review.project_id}/review?tab=making`);await expect(page.locator('#review-making-panel .review-live-workspace')).toBeVisible();await expect(page.locator('.review-fixed-input')).toHaveCount(0);await expect(page.locator('#review-making-panel')).not.toContainText('SHA-256');await page.screenshot({path:join(output,'real-review-progress.png')});}
  expect(errors).toEqual([]);expect(mutations).toEqual([]);
  await writeFile(join(output,'verification.json'),JSON.stringify({checkedAt:new Date().toISOString(),baseURL:process.env.BB_E2E_BASE_URL,projectId:target.project.project_id,files,screenshots,summaryWidths,reviewChecked:!!review,mutations,errors,apiMocked:false,newModelCalls:0,userAccepted:false},null,2));
});
