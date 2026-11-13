import {test,expect,type Page} from '@playwright/test';
import {emptyFileGenerationPreparation,type FileGenerationWorkspace} from '@bondbuddy/contracts';
import {fixture,href} from './generation-entry-fixtures';
import {fixtureBody,fixtureRequest} from './billing-fixture-wire';

async function setup(page:Page){
  const transport=await fixture(page),writes:string[]=[];
  const data:FileGenerationWorkspace={revision:1,preparation:{...emptyFileGenerationPreparation(),document_types:[]},sets:[],builtin:{name:'合成模板',version:'synthetic-v1',available:true},batches:[]};
  await page.route('**/api/v1/projects/*/file-generation**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname;
    if(request.method()==='GET'&&path.endsWith('/file-generation'))return route.fulfill({json:fixtureBody(route,data)});
    if(path.endsWith('/preparation')){const body=fixtureRequest(request);data.revision++;data.preparation=body.preparation;return route.fulfill({json:fixtureBody(route,{revision:data.revision,preparation:data.preparation})});}
    if(request.method()!=='GET')writes.push(path);
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  await page.goto('/'+href({step:'prepare'}));await expect(page.locator('.fg-file-choices')).toBeVisible();return {transport,writes};
}

for(const width of [1440,390,320])test(`assistant launcher avoids file generation footer while scrolling at ${width}px`,async({page},info)=>{
  await page.setViewportSize({width,height:900});const state=await setup(page),button=page.locator('#fg-confirm'),dock=page.locator('[data-assistant-dock]');
  const measurements:unknown[]=[];let checked=0;
  for(const selected of [false,true]){
    if(selected){await page.locator('[data-fg-type=legal]').check();await expect(button).toBeEnabled();}
    for(const y of [0,450,1000,100000]){
      await page.evaluate(y=>window.scrollTo(0,y),y);
      await expect.poll(()=>page.evaluate(()=>{
        const action=document.querySelector<HTMLElement>('#fg-confirm')!,dock=document.querySelector<HTMLElement>('[data-assistant-dock]')!;
        const a=action.getBoundingClientRect(),d=dock.getBoundingClientRect();return a.bottom<=d.top||a.top>=d.bottom||a.right<=d.left||a.left>=d.right;
      })).toBe(true);
      const box=(await button.boundingBox())!;
      if(box.y>=0&&box.y+box.height<=900){
        expect(await button.evaluate(el=>{const r=el.getBoundingClientRect();return [r.x+r.width/2,r.right-6].every(x=>el.contains(document.elementFromPoint(x,r.y+r.height/2)));})).toBe(true);
        if(selected){await button.click({trial:true});await button.click({trial:true,position:{x:box.width-6,y:box.height/2}});}
        checked++;
      }
      measurements.push({selected,requestedScroll:y,scroll:await page.evaluate(()=>scrollY),action:box,dock:await dock.boundingBox()});
      if(y===0||y===1000)await page.screenshot({path:info.outputPath(`dock-${width}-${selected?'selected':'empty'}-${y}.png`)});
    }
  }
  expect(checked).toBeGreaterThanOrEqual(2);
  await page.evaluate(()=>window.scrollTo(0,0));await dock.click();await expect(page.locator('#ba-panel')).toBeVisible();
  await page.getByRole('button',{name:'收起助手',exact:true}).click();await expect(dock).toBeVisible();
  await expect.poll(()=>page.evaluate(()=>{const a=document.querySelector('#fg-confirm')!.getBoundingClientRect(),d=document.querySelector('[data-assistant-dock]')!.getBoundingClientRect();return a.bottom<=d.top||a.top>=d.bottom||a.right<=d.left||a.left>=d.right;})).toBe(true);
  expect(state.writes).toEqual([]);expect(state.transport.errors).toEqual([]);
  await info.attach('dock-positions',{body:JSON.stringify(measurements,null,2),contentType:'application/json'});
});
