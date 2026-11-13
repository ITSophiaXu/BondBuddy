import {test, expect, type Page} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import * as authoring from './authoring-next-layout-fixtures';
import * as qa from './project-qa-continuation-fixtures';
import * as review from './review-flow-reader-fixtures';
import * as files from './project-file-status-fixtures';
import * as integrity from './integrity-delivery-fixtures';

const directory=process.env.BB_UX_AUDIT_DIR;
async function open(page:Page,scene:string){
  if(scene==='authoring'){await authoring.open(page);await authoring.prepare(page);}
  else if(scene==='review'){await review.open(page);}
  else if(scene==='files'){await files.open(page);}
  else if(scene==='integrity'){await integrity.install(page);await page.goto(integrity.route());await expect(page.locator('.integrity-workbar')).toBeVisible();}
  else {await qa.install(page,qa.fixture());await page.goto('/#qa?project='+qa.projectId+(scene==='qa-result'?'&run='+qa.answerId:''));await expect(page.locator('.qa-page')).toBeVisible();}
}
for(const scene of ['authoring','review','files','integrity','qa-prepare','qa-result','assistant']){
  for(const width of [1440,1024,390,320])test(`${scene} layout scan ${width}`,async({page})=>{
    await open(page,scene);await page.setViewportSize({width,height:900});
    if(scene==='assistant'){await page.getByRole('button',{name:'打开 BondBuddy',exact:true}).click();await expect(page.locator('#ba-panel')).toBeVisible();}
    await page.evaluate(()=>document.fonts.ready);
    const data=await page.evaluate(()=>{
      const visible=(e:Element)=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.visibility!=='hidden'&&s.display!=='none'&&r.width>0&&r.height>0;};
      const describe=(e:Element)=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return {tag:e.tagName,id:e.id,classes:e.className,text:(e.textContent||e.getAttribute('aria-label')||'').trim().slice(0,100),x:r.x,y:r.y,w:r.width,h:r.height,display:s.display,gap:s.gap,padding:s.padding,margin:s.margin};};
      const controls=[...document.querySelectorAll('button,a.btn,a.button,label.btn,label.button,select,input:not([type=hidden]),textarea,summary')].filter(visible);
      return {viewport:innerWidth,scrollWidth:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('main *,#ba-panel *')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.right>innerWidth+1||r.left< -1;}).slice(0,40).map(describe),small:controls.filter(e=>{const r=e.getBoundingClientRect();return r.height<40&&r.width>20;}).map(describe),controls:controls.map(describe)};
    });
    if(directory){
      await mkdir(directory,{recursive:true});await writeFile(join(directory,`${scene}-${width}.json`),JSON.stringify(data,null,2));
      await page.screenshot({path:join(directory,`${scene}-${width}.png`),fullPage:true});
    }
    expect(data.scrollWidth,`${scene} should remain inside the viewport`).toBeLessThanOrEqual(width);
  });
}
