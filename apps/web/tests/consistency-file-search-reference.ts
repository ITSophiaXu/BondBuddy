import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/consistency-file-search-reference-source');
const hash=(value:string|Buffer)=>createHash('sha256').update(value).digest('hex');
type Source={path:string;bytes:number;sha256:string};

/** Exact sealed R40 FileConsistency; eight dependencies remain shared with the current app. */
export async function installConsistencyFileSearchReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const parent=await readFile(join(root,provenance.parent_seal.path));
  expect(parent.length).toBe(provenance.parent_seal.bytes);expect(hash(parent)).toBe(provenance.parent_seal.sha256);expect(JSON.parse(parent.toString('utf8')).round).toBe('R40');
  const originals=new Map<string,Buffer>(),shared:Source[]=[],forbiddenRequests:string[]=[];let loads=0;
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path.endsWith('/consistency-file-search.css'))forbiddenRequests.push(path);});
  for(const source of provenance.sources as Source[]){
    const bytes=await readFile(join(directory,source.path));expect(bytes.length).toBe(source.bytes);expect(hash(bytes)).toBe(source.sha256);originals.set(source.path,bytes);
    if(source.path!=='apps/web/src/file-consistency.ts'){
      const current=await readFile(join(root,source.path));expect(current.equals(bytes),'Exact unchanged shared dependency '+source.path).toBe(true);shared.push(source);continue;
    }
    const body=ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_match,quote:string,specifier:string)=>{let target=resolve(dirname(join(root,source.path)),specifier).replaceAll('\\','/');if(!target.endsWith('.css'))target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';const prefix=join(root,'apps/web/src').replaceAll('\\','/')+'/';return quote+(target.startsWith(prefix)?'/src/'+target.slice(prefix.length):'/@fs/'+target)+quote;});
    await page.route('**/src/'+basename(source.path)+'*',intercepted=>{loads++;return intercepted.fulfill({contentType:'text/javascript',body});});
  }
  expect(originals.size).toBe(9);expect(shared).toHaveLength(8);expect(provenance.component_replaced).toBe('apps/web/src/file-consistency.ts');
  expect(shared.some(source=>source.path==='apps/web/src/user-facing-error.ts')).toBe(true);
  return async()=>{
    for(const[path,bytes]of originals)expect((await readFile(join(directory,path))).equals(bytes)).toBe(true);
    for(const source of shared)expect(hash(await readFile(join(root,source.path)))).toBe(source.sha256);
    expect(loads,'Native main route loaded the exact R40 component').toBeGreaterThan(0);expect(forbiddenRequests,'R40 component must not request the new filename-search stylesheet').toEqual([]);
    const bytes=originals.get('apps/web/src/file-consistency.ts')!;
    return {...provenance,replaced_components:[{path:'apps/web/src/file-consistency.ts',bytes:bytes.length,sha256:hash(bytes),loads,immutable:true}],
      shared_dependencies:shared.map(source=>({...source,shared_unchanged:true})),forbidden_requests:forbiddenRequests,
      limits:'Exact R40 component in the current surrounding app. Synthetic HTTP/OOXML/mock receipts; no entire historical app, real service, Word/WPS, ledger or overall UX acceptance claim.'};
  };
}

/** Capture the actual desktop viewport, scroll, filename query and DOM selection without changing them. */
export async function captureConsistencyFileSearch(page:Page,output:string,name:string,audit:Record<string,unknown>){
  await mkdir(output,{recursive:true});
  const facts=await page.evaluate(()=>{
    const box=(node:Element|null)=>{
      if(!(node instanceof HTMLElement))return null;
      const rect=node.getBoundingClientRect(),style=getComputedStyle(node),displayed=node.checkVisibility()&&rect.height>0&&rect.width>0;
      return {top:rect.top,bottom:rect.bottom,left:rect.left,right:rect.right,width:rect.width,height:rect.height,displayed,
        visible:displayed&&rect.bottom>0&&rect.top<innerHeight&&rect.right>0&&rect.left<innerWidth,
        whiteSpace:style.whiteSpace,overflowX:style.overflowX,overflowY:style.overflowY,scrollTop:node.scrollTop,scrollHeight:node.scrollHeight,clientHeight:node.clientHeight,scrollWidth:node.scrollWidth,clientWidth:node.clientWidth};
    };
    const text=(selector:string)=>document.querySelector<HTMLElement>(selector)?.innerText??null;
    const search=document.querySelector<HTMLInputElement>('#fc-file-search, [data-fc-file-search]');
    const count=document.querySelector<HTMLElement>('#fc-file-search-count, [data-fc-search-count]');
    const active=document.activeElement instanceof HTMLElement?document.activeElement:null;
    const editable=active instanceof HTMLInputElement||active instanceof HTMLTextAreaElement?active:null;
    const rows=[...document.querySelectorAll<HTMLElement>('[data-fc-result-version]')].map(row=>{
      const select=row.querySelector<HTMLInputElement>('[data-fc-select]');
      return {version:row.dataset.fcResultVersion,filename:row.querySelector('strong')?.textContent??null,box:box(row),
        selected:select?.checked??false,disabled:select?.disabled??null,selectBox:box(select),detailOpen:row.querySelector<HTMLDetailsElement>('[data-fc-detail]')?.open??null,
        findings:[...row.querySelectorAll<HTMLElement>('[data-fc-finding-id]')].map(item=>({id:item.dataset.fcFindingId,manual:item.hasAttribute('data-fc-manual-item'),box:box(item)}))};
    });
    const all=document.querySelector<HTMLInputElement>('#fc-all');
    return {width:innerWidth,height:innerHeight,scrollY,scrollX,scrollWidth:document.documentElement.scrollWidth,hash:location.hash,
      search:search?.value??null,query:search?.value??null,searchBox:box(search),count:count?.innerText??null,countBox:box(count),
      searchSelection:search?{start:search.selectionStart,end:search.selectionEnd,direction:search.selectionDirection}:null,
      filter:document.querySelector<HTMLSelectElement>('#fc-filter')?.value??null,history:document.querySelector<HTMLSelectElement>('#fc-history')?.value??null,
      renderedIds:rows.map(row=>row.version),displayedIds:rows.filter(row=>row.box?.displayed).map(row=>row.version),visibleIds:rows.filter(row=>row.box?.visible).map(row=>row.version),
      selection:{top:text('[data-fc-selection]'),bottom:text('#fc-selection'),displayedSelectedIds:rows.filter(row=>row.selected&&row.box?.displayed).map(row=>row.version),
        all:all?{checked:all.checked,indeterminate:all.indeterminate,disabled:all.disabled,box:box(all)}:null},
      focus:active?{tag:active.tagName,id:active.id,type:active instanceof HTMLInputElement?active.type:null,value:editable?.value??null,
        selectionStart:editable?.selectionStart??null,selectionEnd:editable?.selectionEnd??null,selectionDirection:editable?.selectionDirection??null,
        version:active.closest<HTMLElement>('[data-fc-result-version]')?.dataset.fcResultVersion??null,finding:active.closest<HTMLElement>('[data-fc-finding-id]')?.dataset.fcFindingId??null,box:box(active)}:null,
      facets:[...document.querySelectorAll<HTMLElement>('.fc-summary [data-fc-filter]')].map(node=>({filter:node.dataset.fcFilter,pressed:node.getAttribute('aria-pressed'),text:node.innerText,box:box(node)})),
      empty:text('#fc-result-list .fc-filter-empty'),status:text('#fc-status'),dialogs:document.querySelectorAll('dialog[open]').length,
      summary:text('.fc-summary'),topSelection:text('[data-fc-selection]'),bottomSelection:text('#fc-selection'),confirmation:text('dialog.fc-confirm[open]'),
      confirmationFiles:[...document.querySelectorAll(document.querySelector('dialog.fc-confirm[open] .fc-confirm-filename')?'dialog.fc-confirm[open] .fc-confirm-filename':'dialog.fc-confirm[open] li')].map(node=>node.textContent),
      resultListBox:box(document.querySelector('#fc-result-list')),toolbarBox:box(document.querySelector('.fc-selection-toolbar')),rows};
  });
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  const path=join(output,name+'.png');await page.screenshot({path});const png=await readFile(path);
  await writeFile(join(output,name+'.json'),JSON.stringify({...facts,audit,png_bytes:png.length,png_sha256:hash(png)},null,2)+'\n');return facts;
}
