import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/consistency-originals-reference-source');
const hash=(source:string)=>createHash('sha256').update(source).digest('hex');
/** Two exact sealed R29 components, with current app routing and unchanged CSS. */
export async function installConsistencyOriginalsReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed=JSON.parse(sealedText),originals=new Map<string,string>(),loads=new Map<string,number>(),shared:{path:string;sha256:string}[]=[];let excludedLoads=0;
  for(const entry of provenance.sources as {path:string;sha256:string}[]){
    const file=basename(entry.path),source=await readFile(join(directory,file),'utf8');expect(hash(source)).toBe(entry.sha256);
    expect(sealed.source_before.find((v:{path:string})=>v.path===entry.path)?.sha256).toBe(entry.sha256);expect(sealed.source_after.find((v:{path:string})=>v.path===entry.path)?.sha256).toBe(entry.sha256);originals.set(entry.path,source);
    if(!['file-consistency.ts','project-files.ts'].includes(file)){expect(await readFile(join(root,entry.path),'utf8')).toBe(source);shared.push(entry);continue;}
    loads.set(entry.path,0);
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
    await page.route('**/src/'+file+'*',route=>{loads.set(entry.path,loads.get(entry.path)!+1);return route.fulfill({contentType:'text/javascript',body});});
  }
  await page.route('**/src/consistency-originals.css*',route=>{excludedLoads++;return route.fulfill({contentType:'text/javascript',body:'export default "";'});});
  return async()=>{
    const replaced=[];
    for(const[path,source]of originals){const after=await readFile(join(directory,basename(path)),'utf8');expect(after).toBe(source);if(loads.has(path)){expect(loads.get(path)).toBeGreaterThan(0);replaced.push({path,sha256:hash(source),sha256_after:hash(after),loads:loads.get(path),immutable:true});}}
    for(const entry of shared)expect(hash(await readFile(join(root,entry.path),'utf8'))).toBe(entry.sha256);
    return {...provenance,replaced_components:replaced,shared_dependencies:shared.map(v=>({...v,shared_unchanged:true})),excluded_stylesheets:[{path:'apps/web/src/consistency-originals.css',loads:excludedLoads,disabled:true,policy:'empty JavaScript CSS module if requested'}]};
  };
}
export async function captureConsistencyOriginals(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const facts=await page.evaluate(()=>{
    const rect=(selector:string)=>{const e=document.querySelector<HTMLElement>(selector);if(!e||!e.checkVisibility())return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,width:r.width,height:r.height};};
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,hash:location.hash,
      text:document.body.innerText,focus:{tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement)?.id,family:(document.activeElement as HTMLElement)?.dataset.fileFamily},
      originalButtons:[...document.querySelectorAll<HTMLElement>('[data-fc-original]')].map(e=>({version:e.dataset.fcOriginal,text:e.innerText})),
      sourceButtons:document.querySelectorAll('[data-fc-source-download]').length,context:document.querySelector('#pw-file-context')?.textContent??null,
      families:[...document.querySelectorAll<HTMLElement>('[data-file-family]')].map(e=>({family:e.dataset.fileFamily,version:e.dataset.fileVersion,text:e.textContent})),
      rects:{source:rect('.pf-source-strip'),manual:rect('.fc-manual-next'),result:rect('[data-fc-result-version]'),context:rect('#pw-file-context'),target:rect('[data-file-family="word-roundtrip-init-family"]')},
      dialogs:document.querySelectorAll('dialog[open]').length};
  });
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...facts,audit},null,2));return facts;
}
