import {test,expect} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fixture,install,route,word} from './integrity-delivery-fixtures';
import {fixture as fileFixture,open as openFiles,collection} from './project-file-status-fixtures';

test.skip(!process.env.BB_UX_COMPARE,'Optional fixed baseline/current comparison, synthetic HTTP only.');
test('capture matching result and version scenes',async({page})=>{
  const dir=process.env.BB_UX_COMPARE!;await mkdir(dir,{recursive:true});await page.setViewportSize({width:1366,height:768});
  const s=fixture();await install(page,s);await page.goto(route());
  await page.locator('.integrity-workbar').scrollIntoViewIfNeeded();await page.screenshot({path:join(dir,'integrity-toolbar.png')});
  let release!:()=>void,requested=false;const gate=new Promise<void>(resolve=>release=resolve),id=word(s).artifact_id;
  await page.route(`**/api/v1/artifacts/${id}`,async route=>{requested=true;await gate;return route.fallback();});
  await page.locator(`[data-integrity-download="${id}"]`).click();await expect.poll(()=>requested).toBe(true);
  await page.screenshot({path:join(dir,'integrity-download.png')});
  const downloaded=page.waitForEvent('download');release();await downloaded;
});
test('capture matching file V1 and current prospectus V2 history',async({page})=>{
  const s=fileFixture();s.source.sequence=2;s.collectionProjection=collection(s);s.collectionProjection.items.find(f=>f.current)!.display_version=1;
  await openFiles(page,s);await page.setViewportSize({width:1366,height:768});
  const row=page.locator('.collection-file').filter({hasText:s.source.filename});await row.scrollIntoViewIfNeeded();
  await page.screenshot({path:join(process.env.BB_UX_COMPARE!,'file-version-row.png')});
  await row.getByRole('button',{name:/版本记录/}).click();await page.screenshot({path:join(process.env.BB_UX_COMPARE!,'file-version-history.png')});
});
test('capture signed-out help with recovery disabled',async({page})=>{
  await page.setViewportSize({width:1366,height:768});await page.route('**/api/v1/**',r=>new URL(r.request().url()).pathname.endsWith('/auth/recovery/info')?r.fulfill({json:{enabled:false,support_contact:null,link_minutes:30}}):r.fulfill({status:401,json:{code:'UNAUTHENTICATED'}}));
  await page.goto('/');await expect(page.getByRole('heading',{name:'登录工作区'})).toBeVisible();
  await page.screenshot({path:join(process.env.BB_UX_COMPARE!,'login.png')});
  // Direct route only sets up the disabled state; entry discovery has its own test.
  await page.goto('/#/recover');await expect(page.locator('#recovery-public-body')).toContainText('人工找回尚未开放');
  await page.screenshot({path:join(process.env.BB_UX_COMPARE!,'recovery-disabled.png')});
});
