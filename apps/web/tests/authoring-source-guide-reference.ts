import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/authoring-source-guide-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exact R23 preparation components, with the current surrounding application. */
export async function installAuthoringSourceGuideReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');
  expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed=JSON.parse(sealedText),originals=new Map<string,string>(),loads=new Map<string,number>();
  for(const file of ['project-execution.ts','source-prospectus.ts']){
    const relative='apps/web/src/'+file,source=await readFile(join(directory,relative),'utf8');
    expect(hash(source)).toBe(provenance.sources.find((item:{path:string})=>item.path===relative)?.sha256);
    expect(hash(source)).toBe(sealed.source_before.find((item:{path:string})=>item.path===relative)?.sha256);
    originals.set(file,source);loads.set(file,0);
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`)
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
    await page.route(`**/src/${file}*`,intercepted=>{loads.set(file,loads.get(file)!+1);return intercepted.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    const sources=[];
    for(const[file,source]of originals){const after=await readFile(join(directory,'apps/web/src',file),'utf8');expect(after).toBe(source);expect(loads.get(file)).toBeGreaterThan(0);sources.push({path:'apps/web/src/'+file,sha256:hash(source),sha256_after:hash(after),loads:loads.get(file),immutable:true});}
    return {...provenance,sources};
  };
}

/** Local screenshots and observed state only; no service or business mutation. */
export async function captureAuthoringPreparation(page:Page,directory:string,name:string,audit:unknown,fullPage=false){
  await mkdir(directory,{recursive:true});
  const state=await page.evaluate(()=>{
    const focused=document.activeElement as HTMLElement|null;
    return {width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,documentHeight:document.documentElement.scrollHeight,hash:location.hash,text:document.body.innerText,
      focused:focused?{tag:focused.tagName,id:focused.id,field:focused.dataset.sourceField??null,material:focused.closest<HTMLElement>('[data-source-material]')?.dataset.sourceMaterial??null}:null,
      details:[...document.querySelectorAll<HTMLDetailsElement>('#project-materials-details, .material-subtypes')].map(node=>({id:node.id,summary:node.querySelector('summary')?.textContent,open:node.open})),
      sourceGuideCount:document.querySelectorAll('#complete-source-information').length,sourceGuideVisible:!!document.querySelector<HTMLElement>('#complete-source-information')?.getClientRects().length,
      repeatedContinueCount:document.querySelectorAll('#prepare-next-version').length,basis:document.querySelector<HTMLSelectElement>('[data-next-basis-choice]')?.value??null};
  });
  expect(state.width).toBe(1440);expect(state.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(directory,name+'.png'),fullPage});
  await writeFile(join(directory,name+'.json'),JSON.stringify({...state,audit},null,2));return state;
}
