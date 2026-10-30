import {expect,type Page,type Locator} from '@playwright/test';
import {mkdir} from 'node:fs/promises';
export async function hold(page:Page){await page.evaluate(async()=>{
 const {ApiClient}=await import(String('/src/api.ts')),put=ApiClient.prototype.uploadBytes,complete=ApiClient.prototype.completeUpload;
 ApiClient.prototype.uploadBytes=async function(url:string,file:File,progress:(loaded:number,total:number)=>void,signal:AbortSignal){progress(file.size*.4,file.size);await new Promise<void>(resolve=>(window as any).releaseBytes=resolve);return put.call(this,url,file,progress,signal);};
 ApiClient.prototype.completeUpload=async function(...args:any[]){await new Promise<void>(resolve=>(window as any).releaseSave=resolve);return complete.apply(this,args as any);};
});}
export async function check(page:Page,bar:Locator,name:string,width:number){
 await expect(bar).toHaveAttribute('value','40');
 await expect(bar).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
 await mkdir('test-evidence/all-upload-progress',{recursive:true});await bar.scrollIntoViewIfNeeded();
 await page.screenshot({path:'test-evidence/all-upload-progress/'+name+'-'+width+'.png'});
 await page.evaluate(()=>(window as any).releaseBytes());
 await expect(bar).not.toHaveAttribute('value');
 await expect.poll(()=>page.evaluate(()=>typeof (window as any).releaseSave)).toBe('function');
 await page.evaluate(()=>(window as any).releaseSave());
}
