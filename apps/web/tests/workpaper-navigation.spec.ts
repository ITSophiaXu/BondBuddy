import {test,expect,type Page} from '@playwright/test';
import {BILLING_WIRE_VERSION,M4_DOCUMENT_FIXED_PRICE,emptyFileGenerationPreparation,type FileGenerationWorkspace,type WorkpaperCatalogue} from '@bondbuddy/contracts';
import {fixture,href,ids,sha,now} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

// Production router and shared components; HTTP and project data are synthetic.
async function setup(page:Page){
 const transport=await fixture(page);
 const catalogue:WorkpaperCatalogue={catalogue_id:'split-cat',filename:'合成底稿目录.xlsx',sha256:sha,created_at:now,warnings:[],entries:['1','2'].map(code=>({id:'item-'+code,code,title:'核查记录'+code,folder:'',sheet:'尽职调查文件',row:Number(code),instructions:'',kind:'file',path:code+'.docx'}))};
 const preparation={...emptyFileGenerationPreparation(),document_types:['workpaper','annual'] as const,workpaper_template_mode:'automatic' as const,catalogue_id:catalogue.catalogue_id,item_ids:['item-1','item-2'],target_year:'2026',requirements:'原编制要求'};
 const data:FileGenerationWorkspace={revision:1,preparation:{...preparation,document_types:[...preparation.document_types],document_templates:{annual:{private_template:{template_id:'template-annual',template_version:1,sha256:sha}}}},sets:[],builtin:{name:'光大证券模板',version:'synthetic-v1',available:true},batches:[]};
 const quotes:FileGenerationWorkspace['preparation'][]=[];
 await page.route('**/api/v1/projects/*/file-generation**',async route=>{
  const request=route.request(),path=new URL(request.url()).pathname,body=request.postData()?fixtureRequest(request):undefined;
  const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
  if(request.method()==='GET'&&path.endsWith('/file-generation'))return reply(data);
  if(path.endsWith('/preparation')){expect(body.expected_revision).toBe(data.revision);data.revision++;data.preparation=structuredClone(body.preparation);return reply({revision:data.revision,preparation:data.preparation});}
  if(path.endsWith('/quote')){quotes.push(structuredClone(data.preparation));const count=data.preparation.document_types.includes('workpaper')?data.preparation.item_ids.length:data.preparation.document_types.length;return reply({count,points:count*4500,price_version:body.price_version,omitted:[]});}
  if(path.endsWith('/progress'))return reply({revision:sha,active:false});
  return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
 });
 await page.route('**/api/v1/projects/*/workpapers**',async route=>{
  const path=new URL(route.request().url()).pathname;
  if(path.endsWith('/batches/old-batch'))return route.fulfill({json:fixtureBody(route,{batch_id:'old-batch',topic_id:'old-topic',catalogue_id:catalogue.catalogue_id,revision:1,state:'complete',start_mode:'direct',source:transport.workspaces.get(ids.api)!.source,total_points:0,charged_points:0,created_at:now,error:null,items:[]})});
  return route.fulfill({json:fixtureBody(route,path.endsWith('/catalogues/'+catalogue.catalogue_id)?catalogue:path.endsWith('/checks')?{checks:[]}:{catalogues:[catalogue],batches:[],assessments:[]})});
 });
 const open=async(kind:'generate'|'workpapers')=>{await page.goto('/'+href({step:'prepare'}).replace('#generate','#'+kind));await expect(page.locator(`.sidebar a[href="#${kind}"]`)).toHaveAttribute('aria-current','page');await expect(page.locator('#fg-confirm')).toBeVisible();};
 return {data,quotes,transport,open};
}

for(const width of [1440,390])test('parallel navigation entries reuse existing controls at '+width,async({page},info)=>{
 await page.setViewportSize({width,height:960});const s=await setup(page);await s.open('workpapers');
 await expect(page.getByRole('heading',{name:'尽调底稿包',exact:true})).toBeVisible();
 await expect(page.locator('.sidebar a[href="#workpapers"]')).toHaveAttribute('aria-current','page');
 await expect(page.locator('.sidebar a[href="#generate"]')).not.toHaveAttribute('aria-current');
 await expect(page.locator('#fg-template-setup')).toBeVisible();await expect(page.locator('.fg-file-choices')).toBeHidden();
 await expect(page.locator('#fg-requirements')).toHaveValue('原编制要求');
 await page.screenshot({path:info.outputPath('workpapers-'+width+'.png'),fullPage:true});
 await page.locator('#fg-save').click();await expect.poll(()=>s.data.preparation.document_types).toEqual(['workpaper']);
 await s.open('generate');await expect(page.locator('.fg-file-choices')).toBeVisible();await expect(page.locator('[data-fg-type="workpaper"]')).toHaveCount(0);await expect(page.locator('#fg-template-setup')).toBeHidden();
 await expect(page.locator('[data-fg-type="annual"]')).toBeChecked();
 await page.locator('#fg-save').click();await expect.poll(()=>s.data.preparation.document_types).toEqual(['annual']);
 expect(s.data.preparation.item_ids).toEqual(['item-1','item-2']);expect(s.data.preparation.requirements).toBe('原编制要求');
 await page.reload();await expect(page.locator('[data-fg-type="annual"]')).toBeChecked();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await page.screenshot({path:info.outputPath('documents-'+width+'.png'),fullPage:true});
 if(width===390){await page.getByRole('button',{name:'打开菜单',exact:true}).click();}
 await page.locator('.sidebar a[href="#workpapers"]').click();await expect(page.locator('#continue-review')).toHaveText('打开尽调底稿包');
 expect(s.quotes).toEqual([]);
});

test('quotes contain only the current entry while preserving the original catalogue and templates',async({page})=>{
 const s=await setup(page);await s.open('generate');await page.locator('#fg-confirm').click();await expect(page.locator('#fg-submit')).toBeVisible();
 expect(s.quotes[0].document_types).toEqual(['annual']);expect(s.quotes[0].progressive).toBeUndefined();
 await page.getByRole('button',{name:'关闭',exact:true}).click();
 await s.open('workpapers');await page.locator('#fg-confirm').click();await expect(page.locator('#fg-submit')).toBeVisible();
 expect(s.quotes[1].document_types).toEqual(['workpaper']);expect(s.quotes[1].item_ids).toEqual(['item-1','item-2']);expect(s.quotes[1].document_templates.annual).toEqual(s.quotes[0].document_templates.annual);
});

test('old result bookmarks, project context and prepare-again stay in the workpaper entry',async({page})=>{
 await setup(page);await page.goto('/'+href({step:'workpapers',view:'results',batch:'old-batch'},ids.api,ids.navigation));
 await expect(page).toHaveURL(/#workpapers\?/);await expect(page).toHaveURL(/batch=old-batch/);
 await expect(page.locator('.sidebar a[href="#workpapers"]')).toHaveAttribute('aria-current','page');
 await expect(page.locator('.project-context a')).toHaveAttribute('href','#/projects/'+ids.navigation+'/files');
 await expect(page.locator('[data-wp-batch-id="old-batch"]')).toBeVisible();
 await page.locator('#wp-prepare-again').click();await expect(page).toHaveURL(/#workpapers\?.*step=prepare/);await expect(page.locator('#fg-template-setup')).toBeVisible();
});

test('switching entries and refreshing preserves the adjusted chapter order',async({page})=>{
 const s=await setup(page);await s.open('workpapers');
 await page.locator('[data-chapter-move="chapter-2"][data-direction="-1"]').click();
 await expect.poll(()=>s.data.preparation.progressive?.chapter_order).toEqual(['chapter-2','chapter-1']);
 await s.open('generate');await page.locator('#fg-save').click();
 await expect.poll(()=>s.data.preparation.document_types).toEqual(['annual']);expect(s.data.preparation.progressive).toBeUndefined();
 await page.reload();await expect(page.locator('[data-fg-type="annual"]')).toBeChecked();
 await s.open('workpapers');await expect(page.locator('.wpg-select-chapter').first()).toHaveAttribute('data-chapter-id','chapter-2');
 await page.locator('#fg-confirm').click();await expect(page.locator('#fg-submit')).toBeVisible();
 expect(s.quotes[0].progressive?.chapter_order).toEqual(['chapter-2','chapter-1']);
});

for(const entry of ['generate','workpapers'] as const)test('pre-split mixed submission is recovered unchanged from '+entry,async({page})=>{
 const s=await setup(page);await s.open(entry);
 const original={request_id:'original-mixed-request',expected_revision:1,source_version_id:'original-source',source_selection_revision:1,expected_points:'13500',price_version:M4_DOCUMENT_FIXED_PRICE.version};
 await page.evaluate(({key,preparation,pending,wire})=>localStorage.setItem(key,JSON.stringify({revision:1,preparation,dirty:false,pending,pending_wire:wire})),{key:`bb-file-generation-v2:${ids.owner}:${ids.api}`,preparation:s.data.preparation,pending:original,wire:BILLING_WIRE_VERSION});
 let saves=0;const submissions:unknown[]=[];
 await page.route('**/file-generation/preparation',route=>{saves++;return route.fallback();});
 await page.route('**/file-generation/batches',route=>{submissions.push(route.request().postDataJSON());return route.fulfill({json:fixtureBody(route,{batch_id:'original-batch',created_at:now,points:13500,workpapers:null,documents:{batch_id:'original-documents',state:'queued',items:[{document_type:'annual',run_id:null,state:'queued',error:null}]}})});});
 await page.reload();await expect(page.locator('.fg-recovery')).toContainText('尽职调查底稿包、年度报告');
 await expect(page.locator('#fg-controls')).toHaveJSProperty('inert',true);
 await page.locator('#fg-resolve').click();await expect(page.locator('.fg-status')).toContainText('已提交');
 expect(submissions).toEqual([original]);expect(saves).toBe(0);expect(s.quotes).toEqual([]);
});
