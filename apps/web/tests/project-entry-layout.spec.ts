import {test, expect, type Page} from '@playwright/test';
import {mkdir, writeFile} from 'node:fs/promises';
import {relative, resolve} from 'node:path';

// Real routes and browser layout; owner-scoped synthetic HTTP, no backend/model calls.
const entries = [
  {hash:'#generate', title:'文件生成', action:'打开文件生成'},
  {hash:'#review', title:'复核募集书', action:'下一步：材料与要求'},
  {hash:'#integrity', title:'诚信核查', action:'下一步：名单与网站范围'},
  {hash:'#qa', title:'项目问答', action:'下一步：确认项目资料'},
  {hash:'#/update', title:'更新募集书', action:'进入更新募集书'},
];
const projects=Array.from({length:40},(_,i)=>({project_id:`synthetic-entry-${i+1}`,name:`示例项目 ${i+1}`,
  issuer_name:'示例城市建设投资集团有限公司',kind:'update',market:'sse',offering:'private',updated_at:'2026-10-28T00:00:00Z',
  has_prospectus:i%3!==0,archived_at:null}));
async function setup(page:Page, hash:string){
  const state={queries:[] as string[],opens:[] as string[],fail:false,hold:false,openSuccess:false,release:undefined as (()=>void)|undefined,errors:[] as string[]};
  page.on('pageerror',e=>state.errors.push(e.message));
  await page.route('**/api/v1/**',async route=>{
    const url=new URL(route.request().url()),path=url.pathname.replace('/api/v1','');
    const reply=(body:unknown,status=200)=>route.fulfill({status,json:body});
    if(path==='/me')return reply({user_id:'entry-layout-owner',session_status:'active'});
    if(path==='/account')return reply({user_id:'entry-layout-owner',username:'示例账号',status:'active'});
    if(path==='/credits/balance')return reply({enabled:true,available:1000,frozen:0});
    if(path==='/projects'){
      const q=url.searchParams.get('q')??'';state.queries.push(q);
      if(state.fail)return reply({code:'INTERNAL_ERROR',message:'synthetic read failure',correlation_id:'entry-read'},500);
      const items=projects.filter(p=>p.name.includes(q));const start=url.searchParams.has('cursor')?20:0;
      return reply({items:items.slice(start,start+20),page:{next_cursor:items.length>start+20?'page-2':null,has_more:items.length>start+20}});
    }
    if(path.endsWith('/review-entry')||path.endsWith('/update-workspace')){
      state.opens.push(path);if(state.hold)await new Promise<void>(r=>state.release=r);
      if(state.openSuccess)return reply({project_id:path.split('/')[2],update_project_id:path.split('/')[2]});
      return reply({code:'INTERNAL_ERROR',message:'synthetic open failure',correlation_id:'entry-open'},500);
    }
    if(path.includes('/assistant/')&&path.endsWith('/conversations'))return reply({items:[],page:{next_cursor:null,has_more:false}});
    return reply({code:'RESOURCE_NOT_FOUND',message:'Synthetic unused endpoint',correlation_id:'entry-unused'},404);
  });
  await page.goto('/'+hash);
  if(hash==='#/update')await page.locator('details > summary').click();
  await expect(page.locator('.update-project-option')).toHaveCount(20);
  return state;
}
async function visibleAction(page:Page,action:string){
  const button=page.getByRole('button',{name:action,exact:true});
  await expect(button).toBeInViewport({ratio:1});
  expect(await button.evaluate(el=>{
    const r=el.getBoundingClientRect();return el.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2));
  })).toBe(true);
  await expect(page.getByPlaceholder('搜索项目名称或发行人')).toBeInViewport({ratio:1});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
}

for(const size of [{width:1440,height:960},{width:390,height:844},{width:320,height:640}])for(const entry of entries){
  test(`project selector keeps actions visible: ${entry.title} ${size.width}`,async({page})=>{
    await page.setViewportSize(size);const state=await setup(page,entry.hash);
    await visibleAction(page,entry.action);await expect(page.getByRole('button',{name:entry.action,exact:true})).toBeDisabled();
    await page.locator('.update-project-option input').first().check();
    await expect(page.getByRole('button',{name:entry.action,exact:true})).toBeEnabled();
    await expect(page.locator('#project-entry-selection')).toHaveText('已选：示例项目 1');
    await page.getByRole('region',{name:'可选择的项目'}).evaluate(el=>el.scrollTop=el.scrollHeight);
    await visibleAction(page,entry.action);await page.getByRole('button',{name:'加载更多项目',exact:true}).click();
    await expect(page.locator('.update-project-option')).toHaveCount(40);
    await expect(page.locator('.update-project-option input').first()).toBeChecked();
    await visibleAction(page,entry.action);
    await page.locator('.update-project-option input').last().check();
    await expect(page.locator('#project-entry-selection')).toHaveText('已选：示例项目 40');
    await visibleAction(page,entry.action);
    await page.getByPlaceholder('搜索项目名称或发行人').fill('示例项目 2');await page.getByRole('button',{name:'搜索',exact:true}).click();
    await expect(page.locator('.update-project-option')).toHaveCount(11);
    await expect(page.getByRole('button',{name:entry.action,exact:true})).toBeDisabled();
    await expect(page.locator('#project-entry-selection')).toHaveText('请选择一个项目');
    await expect.poll(()=>page.locator('.project-picker-scroll').evaluate(el=>el.scrollTop)).toBe(0);
    await visibleAction(page,entry.action);expect(state.errors).toEqual([]);
    if(process.env.BB_ENTRY_EVIDENCE){
      await page.getByPlaceholder('搜索项目名称或发行人').fill('');await page.getByRole('button',{name:'搜索',exact:true}).click();
      await expect(page.locator('.update-project-option')).toHaveCount(20);await page.locator('.update-project-option input').first().check();
      await expect(page.getByRole('button',{name:entry.action,exact:true})).toBeEnabled();
      await expect(page.getByRole('button',{name:entry.action,exact:true})).toHaveCSS('opacity','1');
      await mkdir(process.env.BB_ENTRY_EVIDENCE,{recursive:true});
      await page.screenshot({path:`${process.env.BB_ENTRY_EVIDENCE}/${entry.hash.replace(/[#/]/g,'')}-${size.width}.png`});
      if(process.env.BB_ENTRY_PROTOTYPE&&entry.hash==='#generate'&&size.width===1440){
        const markup=await page.locator('#app').innerHTML();
        const dock=await page.locator('.ba-dock').evaluate(el=>el.outerHTML);
        const styles=(await page.locator('style[data-vite-dev-id]').evaluateAll(nodes=>nodes.map(el=>el.getAttribute('data-vite-dev-id')!)))
          .map(path=>relative(resolve('../../product-prototype/public'),path).replaceAll('\\','/'));
        await writeFile('../../product-prototype/public/project-entry.html','<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>BondBuddy · 项目选择设计预览</title>'+styles.map(s=>`<link rel="stylesheet" href="${s}">`).join('')+'</head><body><div id="app">'+markup+'</div><aside class="bb-assistant" hidden></aside>'+dock+'<script src="project-entry-preview.js"></script></body></html>\n');
      }
    }
  });
}

test('empty and failed search leave feedback, create and action visible; keyboard selection works after retry',async({page})=>{
  await page.setViewportSize({width:320,height:640});const state=await setup(page,'#generate');
  await visibleAction(page,'打开文件生成');
  await page.getByPlaceholder('搜索项目名称或发行人').fill('没有此项目');await page.getByRole('button',{name:'搜索',exact:true}).click();
  await expect(page.locator('#review-entry-status')).toContainText('暂无匹配项目');await visibleAction(page,'打开文件生成');
  await expect(page.getByRole('button',{name:'＋ 新建项目',exact:true})).toBeInViewport({ratio:1});
  state.fail=true;await page.getByRole('button',{name:'搜索',exact:true}).click();await expect(page.locator('#review-entry-status')).not.toBeEmpty();
  await expect(page.getByRole('button',{name:'打开文件生成'})).toBeDisabled();await visibleAction(page,'打开文件生成');
  state.fail=false;await page.getByPlaceholder('搜索项目名称或发行人').fill('');await page.getByRole('button',{name:'搜索',exact:true}).click();
  await expect(page.locator('.update-project-option')).toHaveCount(20);
  await page.locator('.update-project-option input').first().focus();await page.keyboard.press('Space');await page.keyboard.press('ArrowDown');
  await expect(page.locator('#project-entry-selection')).toHaveText('已选：示例项目 2');await visibleAction(page,'打开文件生成');
});

for(const entry of [entries[1],entries[4]])test(`opening failure stays beside retry action: ${entry.title}`,async({page})=>{
  await page.setViewportSize({width:390,height:844});const state=await setup(page,entry.hash);state.hold=true;
  await page.locator('.update-project-option input').first().check();await page.getByRole('button',{name:entry.action,exact:true}).click();
  await expect.poll(()=>state.opens.length).toBe(1);await expect(page.locator('.project-picker-footer > button')).toBeDisabled();
  state.release!();await expect(page.locator('.project-picker-selection [role=alert]')).not.toBeEmpty();
  await expect(page.locator('.project-picker-selection [role=alert]')).toBeInViewport({ratio:1});
  await visibleAction(page,entry.action);await expect(page.getByRole('button',{name:entry.action,exact:true})).toBeEnabled();
});

test('long names, smaller laptop and expanded assistant keep the primary action clear',async({page})=>{
  await page.setViewportSize({width:1024,height:768});await setup(page,'#review');
  await page.locator('.update-project-option strong').first().evaluate(el=>el.textContent='示例超长项目名称'.repeat(12));
  await page.locator('.update-project-option input').first().check();await visibleAction(page,entries[1].action);
  await page.locator('.ba-dock').click();await expect(page.locator('.bb-assistant')).toHaveClass(/ba-open/);
  await visibleAction(page,entries[1].action);
});

for(const entry of entries)test(`primary action passes the selected project into its workspace: ${entry.title}`,async({page})=>{
    const state=await setup(page,entry.hash);state.openSuccess=true;
    await page.locator('.update-project-option input').nth(3).check();
    await page.getByRole('button',{name:entry.action,exact:true}).click();
    await expect.poll(()=>page.evaluate(()=>location.hash)).toContain('synthetic-entry-4');
    if(entry.hash==='#review'||entry.hash==='#/update')expect(state.opens).toHaveLength(1);
});

for(const width of [1440,390])test('review context stays above the selector during slow entry '+width,async({page})=>{
  await page.setViewportSize({width,height:960});
  const state=await setup(page,'#review');state.hold=true;
  await page.goto('/#review?project=synthetic-entry-1&from=projects&return_project=synthetic-entry-1');
  await expect(page.locator('#continue-review')).toHaveText('正在打开…');
  const context=await page.locator('.project-context').boundingBox(),entry=await page.locator('.project-entry-page').boundingBox();
  if(process.env.BB_ENTRY_EVIDENCE){await mkdir(process.env.BB_ENTRY_EVIDENCE,{recursive:true});await page.screenshot({path:`${process.env.BB_ENTRY_EVIDENCE}/review-context-${width}.png`});}
  expect(context).not.toBeNull();expect(entry).not.toBeNull();
  expect(entry!.y).toBeGreaterThanOrEqual(context!.y+context!.height-1);
  expect(Math.abs(entry!.x-context!.x)).toBeLessThan(2);
  expect(Math.abs(entry!.width-context!.width)).toBeLessThan(2);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
  state.release?.();
});

test('interactive project selector reference matches the implemented desktop and phone layout',async({page})=>{
  const root=process.cwd().replaceAll('\\','/').replace(/\/apps\/web$/,'');
  for(const width of [1440,390]){
    await page.setViewportSize({width,height:width===1440?960:844});
    await page.goto(`/@fs/${root}/product-prototype/public/project-entry.html`);
    await visibleAction(page,'打开文件生成');
    await expect(page.locator('.update-project-option')).toHaveCount(20);
    await page.locator('.update-project-option input').nth(1).check();
    await expect(page.locator('#project-entry-selection')).toHaveText('已选：示例项目 2');
    await page.getByRole('button',{name:'加载更多项目'}).click();await expect(page.locator('.update-project-option')).toHaveCount(40);
    await visibleAction(page,'打开文件生成');
    await page.locator('.project-picker-scroll').evaluate(el=>el.scrollTop=0);
    await page.locator('.update-project-option input').first().check();
    if(process.env.BB_ENTRY_EVIDENCE)await page.screenshot({path:`${process.env.BB_ENTRY_EVIDENCE}/prototype-${width}.png`});
  }
});
