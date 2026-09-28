// Reference-only browser captures of the unchanged prototype, using synthetic API data.
// Never runs the prototype backend, real authentication, billing or model calls.
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '@playwright/test';

const root=resolve(import.meta.dirname,'../../../product-prototype/public');
const output=process.env.BB_UX_EVIDENCE_DIR ?? tmpdir();
const prefix=process.env.BB_UX_EVIDENCE_PREFIX ?? 'bb361';
await mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{
  const path=resolve(root,`.${new URL(req.url,'http://localhost').pathname === '/' ? '/index.html' : new URL(req.url,'http://localhost').pathname}`);
  if(!path.startsWith(`${root}/`)){res.writeHead(404).end();return;}
  try { const bytes=await readFile(path);res.setHeader('Content-Type',({'.html':'text/html','.css':'text/css','.js':'text/javascript','.svg':'image/svg+xml'})[extname(path)]??'application/octet-stream');res.end(bytes); }
  catch {res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const browser=await chromium.launch();
try {
  const page=await browser.newPage({viewport:{width:1440,height:960}});
  await page.route('**/api/**',route=>{
    const path=new URL(route.request().url()).pathname;
    const fixtures={
      '/api/auth/session':{user:{id:'synthetic',phoneMasked:'合成账号'}},
      '/api/tasks':{jobs:[]},'/api/connectors':{connectors:[]},
      '/api/health':{authoringVersion:2,projectInputVersion:3,oneClickExecution:true},
      '/api/billing':{creditVersion:1,wallet:{available:0}},
      '/api/projects':{job:{id:'synthetic-preview'}},
      '/api/tasks/synthetic-preview':{job:{id:'synthetic-preview',files:[]}}
    };
    return route.fulfill({contentType:'application/json',body:JSON.stringify(fixtures[path]??{})});
  });
  const base=`http://127.0.0.1:${server.address().port}`;
  const capture=async name=>{
    await page.evaluate(()=>{document.activeElement?.blur();scrollTo(0,0);});
    await page.screenshot({path:join(output,`${prefix}-reference-${name}.png`),fullPage:true});
  };
  await page.goto(`${base}/#dashboard`);await page.getByRole('heading',{name:'工作台',exact:true}).waitFor();await capture('dashboard');
  await page.goto(`${base}/#update`);await page.getByRole('heading',{name:'更新募集说明书',exact:true}).waitFor();
  await page.getByLabel('项目名称').fill('合成设计验收 · 募集书更新');await page.getByLabel('发行人全称').fill('合成发行人有限公司');await page.locator('[name=authoringMode][value=historical]').check();
  if(prefix==='bb370'){await page.locator('#year').selectOption('2026');await page.getByRole('radio',{name:'6月末',exact:true}).check();}
  await capture('create');
  if(prefix==='bb370'){await page.setViewportSize({width:390,height:844});await capture('create-mobile');await page.setViewportSize({width:1440,height:960});}
  await page.getByRole('button',{name:'创建项目，继续提供材料'}).click();await page.getByRole('heading',{name:'提供项目材料',exact:true}).waitFor();await capture('materials');
  if(prefix==='bb370'){await page.setViewportSize({width:390,height:844});await capture('materials-mobile');}
} finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
