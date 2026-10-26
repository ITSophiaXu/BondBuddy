import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';
const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/authoring-next-layout-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Only sealed R27 execution TS/CSS are replaced; main/artifact remain shared and verified. */
export async function installAuthoringNextReference(page:Page){
 const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8')),sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
 const sealed=JSON.parse(sealedText),originals=new Map<string,string>(),loads=new Map<string,number>(),shared:{path:string;sha256:string}[]=[];
 for(const file of ['project-execution.ts','project-execution.css','main.ts','artifact-page.ts']){
  const relative='apps/web/src/'+file,source=await readFile(join(directory,file),'utf8'),sha256=hash(source);expect(sha256).toBe(provenance.sources.find((item:{path:string})=>item.path===relative)?.sha256);expect(sha256).toBe(sealed.source_before.find((item:{path:string})=>item.path===relative)?.sha256);expect(sha256).toBe(sealed.source_after.find((item:{path:string})=>item.path===relative)?.sha256);
  if(file==='main.ts'||file==='artifact-page.ts'){expect(await readFile(join(root,relative),'utf8')).toBe(source);shared.push({path:relative,sha256});continue;}
  originals.set(file,source);loads.set(file,0);
  const body=file.endsWith('.css')?'const css='+JSON.stringify(source)+';const style=document.createElement("style");style.dataset.authoringNextReference="";style.textContent=css;document.head.append(style);export default css;':ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
   .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
   .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
   .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
  await page.route('**/src/'+file+'*',route=>{loads.set(file,loads.get(file)!+1);return route.fulfill({contentType:'text/javascript',body});});
 }
 return async()=>{const sources=[];for(const[file,source]of originals){const after=await readFile(join(directory,file),'utf8');expect(after).toBe(source);expect(loads.get(file),file+' actual sealed module load').toBeGreaterThan(0);sources.push({path:'apps/web/src/'+file,sha256:hash(source),sha256_after:hash(after),loads:loads.get(file),immutable:true});}for(const item of shared)expect(hash(await readFile(join(root,item.path),'utf8'))).toBe(item.sha256);return {...provenance,replaced_components:sources,shared_dependencies:shared.map(item=>({...item,shared_unchanged:true}))};};
}
export async function captureAuthoringNext(page:Page,directory:string,name:string,audit:unknown,atGuide=true){
 await mkdir(directory,{recursive:true});if(atGuide)await page.locator('[data-authoring-preparation-guide]').scrollIntoViewIfNeeded();
 const state=await page.evaluate(()=>{const rect=(selector:string)=>{const element=document.querySelector<HTMLElement>(selector);if(!element||!element.checkVisibility()||!element.getClientRects().length)return null;const bounds=element.getBoundingClientRect();return {top:bounds.top,bottom:bounds.bottom,height:bounds.height,width:bounds.width};};const previous=document.querySelector<HTMLDetailsElement>('#previous-execution'),summary=document.querySelector<HTMLElement>('#previous-execution-summary');return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,hash:location.hash,activeId:(document.activeElement as HTMLElement|null)?.id??'',guideFocused:document.activeElement===document.querySelector('[data-authoring-preparation-guide]'),basis:document.querySelector<HTMLSelectElement>('[data-next-basis-choice]')?.value,
  previousPresent:!!previous,previousOpen:previous?.open??null,previousSummaryVisible:!!summary&&!summary.hidden,previousState:document.querySelector('[data-previous-execution-state]')?.textContent??null,
  guide:rect('[data-authoring-preparation-guide]'),materials:rect('#materials-title'),previous:rect('#previous-execution'),delivery:rect('#artifact-downloads'),notes:rect('#execution-delivery .authoring-summary'),notesTail:rect('#execution-delivery .authoring-summary p:last-child'),notesParagraphs:document.querySelectorAll('#execution-delivery .authoring-summary p').length,
  downloadContext:document.querySelector<HTMLElement>('[data-artifact-result-context]')?.innerText??null,materialText:document.querySelector('#material-editing')?.textContent??null,
  nextSummary:document.querySelector<HTMLElement>('[data-next-authoring-summary]')?.innerText??null};});
 expect(state.width).toBe(1440);expect(state.height).toBe(960);expect(state.scrollWidth).toBeLessThanOrEqual(1441);await page.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...state,audit},null,2));return state;
}
