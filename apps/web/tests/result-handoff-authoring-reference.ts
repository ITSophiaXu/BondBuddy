import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/result-handoff-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exactly the sealed R25 route entry and artifact component; surrounding app remains current. */
export async function installAuthoringHandoffReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed=JSON.parse(sealedText),originals=new Map<string,string>(),loads=new Map<string,number>();
  for(const file of ['main.ts','artifact-page.ts']){
    const relative='apps/web/src/'+file,source=await readFile(join(directory,file),'utf8');
    expect(hash(source)).toBe(provenance.sources.find((item:{path:string})=>item.path===relative)?.sha256);
    expect(hash(source)).toBe(sealed.source_before.find((item:{path:string})=>item.path===relative)?.sha256);
    originals.set(file,source);loads.set(file,0);
    // main.ts is an entry module and includes side-effect CSS outside apps/web.
    // Rewrite those paths as well as normal relative TS and contract imports.
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`)
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote)
      .replace(/(['"])\.\.\/\.\.\/\.\.\/product-prototype\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/@fs/'+root.replaceAll('\\','/')+'/product-prototype/'+name+quote);
    await page.route(`**/src/${file}*`,intercepted=>{loads.set(file,loads.get(file)!+1);return intercepted.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    const sources=[];for(const[file,source]of originals){const after=await readFile(join(directory,file),'utf8');expect(after).toBe(source);expect(loads.get(file)).toBeGreaterThan(0);sources.push({path:'apps/web/src/'+file,sha256:hash(source),sha256_after:hash(after),loads:loads.get(file),immutable:true});}
    return {...provenance,sources};
  };
}

export async function captureAuthoringHandoff(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const panel=page.locator('#execution-delivery .artifact-download-panel');await panel.scrollIntoViewIfNeeded();await expect(panel).toBeInViewport();
  const state=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,hash:location.hash,
    inputRevision:document.querySelector<HTMLElement>('#execution-progress .task-progress')?.dataset.inputRevision,
    contextText:document.querySelector<HTMLElement>('[data-artifact-result-context]')?.innerText??null,
    contextVisible:!!document.querySelector<HTMLElement>('[data-artifact-result-context]')?.getClientRects().length,
    recordTime:document.querySelector('[data-artifact-result-context] time')?.getAttribute('datetime')??null,
    currentProspectus:document.querySelector('.prospectus-panel header p')?.textContent??null,
    downloadText:document.querySelector<HTMLElement>('#execution-delivery .artifact-download-panel')?.innerText??null}));
  expect(state.width).toBe(1440);expect(state.scrollWidth).toBeLessThanOrEqual(1441);
  await panel.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...state,audit},null,2));return state;
}
