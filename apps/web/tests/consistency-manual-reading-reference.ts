import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/consistency-manual-reading-reference-source');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Source={path:string;bytes:number;sha256:string};

/** Only exact sealed R38 FileConsistency is replaced; seven dependencies stay shared. */
export async function installConsistencyManualReadingReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const parent=await readFile(join(root,provenance.parent_seal.path));expect(parent.length).toBe(provenance.parent_seal.bytes);expect(hash(parent)).toBe(provenance.parent_seal.sha256);expect(JSON.parse(parent.toString()).round).toBe('R38');
  const originals=new Map<string,Buffer>(),shared:Source[]=[],forbiddenRequests:string[]=[];let loads=0;
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/src/consistency-manual-reading.css')forbiddenRequests.push(path);});
  for(const source of provenance.sources as Source[]){
    const bytes=await readFile(join(directory,source.path));expect(bytes.length).toBe(source.bytes);expect(hash(bytes)).toBe(source.sha256);originals.set(source.path,bytes);
    if(source.path!=='apps/web/src/file-consistency.ts'){const current=await readFile(join(root,source.path));expect(current.equals(bytes),'Exact unchanged shared dependency '+source.path).toBe(true);shared.push(source);continue;}
    const body=ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_match,quote:string,specifier:string)=>{let target=resolve(dirname(join(root,source.path)),specifier).replaceAll('\\','/');if(!target.endsWith('.css'))target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';const prefix=join(root,'apps/web/src').replaceAll('\\','/')+'/';return quote+(target.startsWith(prefix)?'/src/'+target.slice(prefix.length):'/@fs/'+target)+quote;});
    await page.route('**/src/'+basename(source.path)+'*',intercepted=>{loads++;return intercepted.fulfill({contentType:'text/javascript',body});});
  }
  expect(originals.size).toBe(8);expect(shared).toHaveLength(7);expect(provenance.component_replaced).toBe('apps/web/src/file-consistency.ts');
  return async()=>{
    for(const[path,bytes]of originals)expect((await readFile(join(directory,path))).equals(bytes)).toBe(true);
    for(const source of shared)expect(hash(await readFile(join(root,source.path)))).toBe(source.sha256);
    expect(loads,'Native main route loaded the exact R38 component').toBeGreaterThan(0);expect(forbiddenRequests).toEqual([]);
    const bytes=originals.get('apps/web/src/file-consistency.ts')!;
    return {...provenance,replaced_components:[{path:'apps/web/src/file-consistency.ts',bytes:bytes.length,sha256:hash(bytes),loads,immutable:true}],
      shared_dependencies:shared.map(source=>({...source,shared_unchanged:true})),forbidden_requests:forbiddenRequests,
      limits:'Exact R38 component in the current surrounding app. Synthetic HTTP/OOXML/mock receipts; no real service, Word/WPS, ledger or overall UX acceptance claim.'};
  };
}

/** Save the actual 1440x960 viewport and actual page scroll, never a fabricated full-page view. */
export async function captureConsistencyManualReading(page:Page,output:string,name:string,audit:Record<string,unknown>){
  await mkdir(output,{recursive:true});
  const facts=await page.evaluate(()=>{
    const box=(node:Element|null)=>{if(!(node instanceof HTMLElement))return null;const r=node.getBoundingClientRect(),style=getComputedStyle(node);return {top:r.top,bottom:r.bottom,left:r.left,width:r.width,height:r.height,visible:node.checkVisibility()&&r.bottom>0&&r.top<innerHeight,whiteSpace:style.whiteSpace,overflowY:style.overflowY,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight};};
    const active=document.activeElement as HTMLElement|null;
    return {width:innerWidth,height:innerHeight,scrollY,scrollWidth:document.documentElement.scrollWidth,hash:location.hash,
      focus:active?{tag:active.tagName,id:active.id,mode:active.dataset.fcManualMode,origin:active.dataset.fcManualOrigin,target:active.dataset.fcManualTarget,
        version:active.closest<HTMLElement>('[data-fc-result-version]')?.dataset.fcResultVersion,finding:active.closest<HTMLElement>('[data-fc-finding-id]')?.dataset.fcFindingId,box:box(active)}:null,
      filter:document.querySelector<HTMLSelectElement>('#fc-filter')?.value,history:document.querySelector<HTMLSelectElement>('#fc-history')?.value,
      summary:document.querySelector('#fc-selection')?.textContent,dialogs:document.querySelectorAll('dialog[open]').length,
      rows:[...document.querySelectorAll<HTMLElement>('[data-fc-result-version]')].map(row=>({version:row.dataset.fcResultVersion,box:box(row),
        selected:row.querySelector<HTMLInputElement>('[data-fc-select]')?.checked,detailOpen:row.querySelector<HTMLDetailsElement>('[data-fc-detail]')?.open,
        originalDownload:row.querySelector('[data-fc-original]')?.getAttribute('data-fc-original'),returnHref:row.querySelector('.fc-manual-next a')?.getAttribute('href'),
        findings:[...row.querySelectorAll<HTMLElement>('[data-fc-finding-id]')].map(item=>({id:item.dataset.fcFindingId,manual:item.hasAttribute('data-fc-manual-item'),position:item.querySelector('[data-fc-manual-position]')?.textContent,box:box(item),text:item.innerText,
          paragraphs:[...item.querySelectorAll('p')].map(p=>({text:p.textContent,box:box(p)}))})),
        controls:[...row.querySelectorAll<HTMLButtonElement>('button[data-fc-manual-mode]')].map(button=>({mode:button.dataset.fcManualMode,origin:button.dataset.fcManualOrigin,target:button.dataset.fcManualTarget,token:button.dataset.fcManualNav,disabled:button.disabled,text:button.innerText,box:box(button)}))}))};
  });
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  const path=join(output,name+'.png');await page.screenshot({path});const png=await readFile(path);
  await writeFile(join(output,name+'.json'),JSON.stringify({...facts,audit,png_bytes:png.length,png_sha256:hash(png)},null,2)+'\n');return facts;
}
