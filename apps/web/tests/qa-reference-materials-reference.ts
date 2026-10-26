import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/qa-reference-materials-reference-source');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Source={path:string;sha256:string;bytes?:number};
/** Accurate sealed R37 QA component and eight unchanged dependencies, inside the current surrounding app. */
export async function installQaReferenceMaterialsReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const freezeRaw=await readFile(join(root,'ux-evidence',provenance.sealed_freeze),'utf8');expect(hash(freezeRaw)).toBe(provenance.sealed_freeze_sha256);
  const freeze=JSON.parse(freezeRaw),originals=new Map<string,string>(),loads=new Map<string,number>(),shared:Source[]=[],currentOnlyLoads:string[]=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(/\/src\/qa-reference-materials\.(?:ts|css)$/.test(path))currentOnlyLoads.push(path);});
  for(const source of provenance.sources as Source[]){
    const text=await readFile(join(directory,source.path),'utf8');expect(hash(text)).toBe(source.sha256);expect(freeze.source_snapshot.find((item:Source)=>item.path===source.path)?.sha256).toBe(source.sha256);originals.set(source.path,text);
    if(source.path!=='apps/web/src/project-qa-workspace.ts'){expect(hash(await readFile(join(root,source.path)))).toBe(source.sha256);shared.push(source);continue;}
    loads.set(source.path,0);
    const body=ts.transpileModule(text,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_match,quote:string,specifier:string)=>{let target=resolve(dirname(join(root,source.path)),specifier).replaceAll('\\','/');if(!target.endsWith('.css'))target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';const prefix=join(root,'apps/web/src').replaceAll('\\','/')+'/';return quote+(target.startsWith(prefix)?'/src/'+target.slice(prefix.length):'/@fs/'+target)+quote;});
    await page.route('**/src/'+basename(source.path)+'*',intercepted=>{loads.set(source.path,loads.get(source.path)!+1);return intercepted.fulfill({contentType:'text/javascript',body});});
  }
  expect(originals.size).toBe(9);expect(shared).toHaveLength(8);expect([...loads.keys()]).toEqual(['apps/web/src/project-qa-workspace.ts']);
  return async()=>{const replaced:unknown[]=[];for(const[path,text]of originals){const after=await readFile(join(directory,path),'utf8');expect(after).toBe(text);if(loads.has(path)){expect(loads.get(path)).toBeGreaterThan(0);replaced.push({path,sha256:hash(text),sha256_after:hash(after),loads:loads.get(path),immutable:true});}}for(const source of shared)expect(hash(await readFile(join(root,source.path)))).toBe(source.sha256);expect(currentOnlyLoads).toEqual([]);return {...provenance,replaced_components:replaced,shared_dependencies:shared,current_only_module_requests:currentOnlyLoads,surrounding_application:'Exact sealed R37 ProjectQaWorkspace inside the current surrounding application, not the entire historical application or an approved prototype.'};};
}
export async function captureQaReferenceMaterials(page:Page,output:string,name:string,audit:Record<string,unknown>){
  await mkdir(output,{recursive:true});const facts=await page.evaluate(()=>{
    const measure=(node:HTMLElement|null)=>{if(!node)return null;const box=node.getBoundingClientRect(),style=getComputedStyle(node);return {box:box.toJSON(),scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth,overflowY:style.overflowY};};
    const panel=document.querySelector<HTMLElement>('[data-qa-reference-panel]')??document.querySelector<HTMLElement>('.qa-materials');
    const list=document.querySelector<HTMLElement>('[data-qa-reference-list]');
    return {width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,panel:measure(panel),summary:measure(panel?.querySelector<HTMLElement>(':scope > summary')??null),list:measure(list),text:panel?.innerText,
      search:(document.querySelector('#qa-reference-search') as HTMLInputElement|null)?.value??null,selected:[...document.querySelectorAll<HTMLInputElement>('input[data-material-key]:checked')].map(node=>node.dataset.materialKey),
      details:[...document.querySelectorAll<HTMLDetailsElement>('[data-qa-reference-detail]')].map(node=>({key:node.dataset.materialKey,open:node.open,box:measure(node)})),
      recovery:[...document.querySelectorAll<HTMLElement>('.qa-recovery')].map(node=>({text:node.innerText,box:measure(node)})),
      focus:document.activeElement instanceof HTMLElement?{tag:document.activeElement.tagName,id:document.activeElement.id,key:document.activeElement.dataset.materialKey??document.activeElement.closest<HTMLElement>('[data-material-key]')?.dataset.materialKey??null}:null};
  });expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);if(facts.panel)expect(facts.panel.scrollWidth).toBeLessThanOrEqual(facts.panel.clientWidth+1);
  await page.screenshot({path:join(output,name+'.png')});const bytes=await readFile(join(output,name+'.png'));await writeFile(join(output,name+'.json'),JSON.stringify({...facts,audit,png_sha256:hash(bytes),png_bytes:bytes.length},null,2));return {...facts,png_sha256:hash(bytes),png_bytes:bytes.length};
}
