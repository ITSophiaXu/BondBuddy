import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/consistency-reading-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exact sealed R32 FileConsistency in the unchanged surrounding application. */
export async function installConsistencyReadingReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed=JSON.parse(sealedText),originals=new Map<string,string>(),shared:{path:string;sha256:string}[]=[];let loads=0;
  for(const file of ['file-consistency.ts','main.ts','file-workspace.css','consistency-selection.css','consistency-originals.css']){
    const relative='apps/web/src/'+file,source=await readFile(join(directory,file),'utf8'),sha256=hash(source);
    expect(sha256).toBe(provenance.sources.find((entry:{path:string})=>entry.path===relative)?.sha256);
    expect(sha256).toBe(sealed.source_before.find((entry:{path:string})=>entry.path===relative)?.sha256);
    expect(sha256).toBe(sealed.source_after.find((entry:{path:string})=>entry.path===relative)?.sha256);
    originals.set(file,source);
    if(file!=='file-consistency.ts'){expect(await readFile(join(root,relative),'utf8')).toBe(source);shared.push({path:relative,sha256});continue;}
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
    await page.route('**/src/file-consistency.ts*',route=>{loads++;return route.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    for(const[file,source]of originals)expect(await readFile(join(directory,file),'utf8')).toBe(source);
    for(const entry of shared)expect(hash(await readFile(join(root,entry.path),'utf8'))).toBe(entry.sha256);
    expect(loads,'The browser loaded the exact R32 component').toBeGreaterThan(0);
    const source=originals.get('file-consistency.ts')!;
    return {...provenance,replaced_components:[{path:'apps/web/src/file-consistency.ts',sha256:hash(source),sha256_after:hash(await readFile(join(directory,'file-consistency.ts'),'utf8')),loads,immutable:true}],
      shared_dependencies:shared.map(entry=>({...entry,shared_unchanged:true}))};
  };
}

/** Saved viewport facts, exact DOM selection and synthetic traffic; no live acceptance claim. */
export async function captureConsistencyReading(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const state=await page.evaluate(()=>{
    const rect=(selector:string)=>{const e=document.querySelector<HTMLElement>(selector);if(!e||!e.checkVisibility()||!e.getClientRects().length)return null;const r=e.getBoundingClientRect();return{top:r.top,bottom:r.bottom,height:r.height,width:r.width};};
    const text=(selector:string)=>document.querySelector<HTMLElement>(selector)?.innerText??null;
    return {width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,hash:location.hash,
      filter:document.querySelector<HTMLSelectElement>('#fc-filter')?.value,history:document.querySelector<HTMLSelectElement>('#fc-history')?.value,
      focused:{tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement|null)?.id,version:(document.activeElement as HTMLElement|null)?.dataset.fcSelect},
      reading:{focus:{tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement|null)?.id,row:(document.activeElement as HTMLElement|null)?.closest<HTMLElement>('[data-fc-result-version]')?.dataset.fcResultVersion,summary:document.activeElement?.tagName==='SUMMARY',finding:(document.activeElement as HTMLElement|null)?.closest<HTMLElement>('[data-fc-finding-id]')?.dataset.fcFindingId},details:[...document.querySelectorAll<HTMLDetailsElement>('[data-fc-detail]')].map(d=>({version:d.dataset.fcDetail,open:d.open})),visibleFindings:[...document.querySelectorAll<HTMLElement>('.fc-finding')].filter(f=>{const r=f.getBoundingClientRect();return f.checkVisibility()&&!f.closest('details:not([open])')&&r.height>0&&r.bottom>0&&r.top<innerHeight;}).map(f=>({version:f.closest<HTMLElement>('[data-fc-result-version]')?.dataset.fcResultVersion,top:f.getBoundingClientRect().top,text:f.textContent?.slice(0,120)})),coverage:[...document.querySelectorAll<HTMLElement>('[data-fc-coverage]')].map(e=>({version:e.dataset.fcCoverage,visible:e.checkVisibility()&&!e.closest('details:not([open])'),text:e.innerText}))},
      summary:text('.fc-summary'),topSelection:text('[data-fc-selection]'),bottomSelection:text('#fc-selection'),
      facets:[...document.querySelectorAll<HTMLElement>('.fc-summary [data-fc-filter]')].map(e=>({filter:e.dataset.fcFilter,pressed:e.getAttribute('aria-pressed'),text:e.innerText})),
      rows:[...document.querySelectorAll<HTMLElement>('[data-fc-result-version]')].map(e=>({version:e.dataset.fcResultVersion,filename:e.querySelector('strong')?.textContent,
        checked:e.querySelector<HTMLInputElement>('[data-fc-select]')?.checked,disabled:e.querySelector<HTMLInputElement>('[data-fc-select]')?.disabled,
        manualNext:e.querySelector('.fc-manual-next')?.textContent??null,text:e.textContent})),
      rects:{summary:rect('.fc-summary'),topSelection:rect('.fc-selection-toolbar'),topAccept:rect('#fc-accept-top'),firstFile:rect('[data-fc-result-version]'),bottomAccept:rect('#fc-accept'),dialog:rect('dialog.fc-confirm[open]')},
      confirmation:text('dialog.fc-confirm[open]'),confirmationFiles:[...document.querySelectorAll(document.querySelector('dialog.fc-confirm[open] .fc-confirm-filename')?'dialog.fc-confirm[open] .fc-confirm-filename':'dialog.fc-confirm[open] li')].map(e=>e.textContent)};
  });
  expect(state.width).toBe(1440);expect(state.height).toBe(960);expect(state.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...state,audit},null,2));return state;
}
