import {test,expect} from '@playwright/test';
import {readFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
const root=resolve(fileURLToPath(new URL('../../..',import.meta.url)));
const target=resolve(root,'apps/web/test-evidence/pdf-quality-warning');
const prototype=readFileSync(resolve(root,'product-prototype/public/pdf-quality-warning.html'),'utf8');
for(const width of [1440,390]) test(`PDF quality hint matches prototype at ${width}px`,async({page})=>{
 await page.setViewportSize({width,height:900});await page.goto('/');
 await page.setContent(prototype);mkdirSync(target,{recursive:true});
 await page.screenshot({path:resolve(target,`prototype-${width}.png`),fullPage:true});
 const expected=await page.locator('#status').innerText();
 await page.evaluate(async()=>{
  const modulePath='/src/material-processing.ts'; const {MaterialProcessing}=await import(modulePath);
  const material={material_id:'material',material_version:1,sha256:'a'.repeat(64),filename:'合成审计报告.pdf',media_type:'application/pdf',role:'audit',byte_size:1024,state:'persisted',upload_id:'upload',persisted_at:'2026-11-18T00:00:00Z',error:null};
  const job={job_id:'job',job_type:'parse',subtype:'material_parse',project_id:'project',material_id:'material',material_version:1,material_sha256:material.sha256,parser_version:'test',state:'running',stage:'pdf_quality',completed_stages:[],attempts:1,max_attempts:3,error_code:null,outcome:null,parse_status:null,profile_version:null,pending_capabilities:[],updated_at:material.persisted_at,pdf_quality:{version:'pdf-raster-quality-1',status:'partial',page_count:107,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]}};
  const controller=new MaterialProcessing({material:async()=>material,materialParseJob:async()=>job},'project',()=>{});
  controller.sync([material]);await new Promise(r=>setTimeout(r,10));
  document.getElementById('status')!.innerHTML=controller.render(material);controller.dispose();
 });
 await page.addStyleTag({content:readFileSync(resolve(root,'apps/web/src/material-processing.css'),'utf8')});
 expect((await page.locator('#status').innerText()).replace(/\s/g,'')).toBe(expected.replace(/\s/g,''));
 await expect(page.getByText('第 7 页扫描图片清晰度可能不足',{exact:false})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.screenshot({path:resolve(target,`implementation-${width}.png`),fullPage:true});
});

