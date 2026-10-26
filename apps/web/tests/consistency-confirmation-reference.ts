import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..');
const hash=(bytes:Buffer|string)=>createHash('sha256').update(bytes).digest('hex');
type Identity={path:string;bytes:number;sha256:string};

/** Exact sealed R43 component and its twelve unchanged direct local imports.
 * The native shell and runtime/transitive dependencies belong to the current app. */
export async function installConsistencyConfirmationReference(page:Page){
  const provenancePath=join(root,'ux-evidence/consistency-confirmation-reference-provenance.json');
  const originalProvenance=await readFile(provenancePath);
  const provenance=JSON.parse(originalProvenance.toString()) as {round:string;reference_round:string;parent_seal:Identity;parent_freeze:Identity;sources:(Identity&{original:string})[]};
  expect(provenance.round).toBe('R44');expect(provenance.reference_round).toBe('R43');
  const exact=async(identity:Identity)=>{const bytes=await readFile(join(root,identity.path));expect(bytes.length,identity.path).toBe(identity.bytes);expect(hash(bytes),identity.path).toBe(identity.sha256);return bytes;};
  const seal=JSON.parse((await exact(provenance.parent_seal)).toString());expect(seal.round).toBe('R43');
  const freeze=JSON.parse((await exact(provenance.parent_freeze)).toString()) as {files:{path:string;sha256:string}[]};
  const originals=new Map<string,Buffer>();let loads=0,mainLoads=0;const forbidden:string[]=[];
  page.on('request',request=>{const path=new URL(request.url()).pathname;if(path==='/src/main.ts')mainLoads++;if(/\/consistency-confirmation\.(?:ts|css)$/.test(path))forbidden.push(path);});
  expect(provenance.sources).toHaveLength(13);
  for(const source of provenance.sources){
    expect(source.path).toBe('ux-evidence/consistency-confirmation-reference-source/'+source.original);
    expect(originals.has(source.original)).toBe(false);
    const bytes=await exact(source);originals.set(source.original,bytes);
    expect(freeze.files.filter(f=>f.path===source.original).map(f=>f.sha256)).toEqual([source.sha256]);
    if(source.original!=='apps/web/src/file-consistency.ts'){expect((await readFile(join(root,source.original))).equals(bytes)).toBe(true);continue;}
    const body=ts.transpileModule(bytes.toString(),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
      .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote:string,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
    await page.route(url=>url.pathname==='/src/file-consistency.ts',route=>{loads++;return route.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    expect((await readFile(provenancePath)).equals(originalProvenance)).toBe(true);await exact(provenance.parent_seal);await exact(provenance.parent_freeze);
    for(const source of provenance.sources){expect((await exact(source)).equals(originals.get(source.original)!)).toBe(true);if(source.original!=='apps/web/src/file-consistency.ts')expect((await readFile(join(root,source.original))).equals(originals.get(source.original)!)).toBe(true);}
    expect(loads).toBeGreaterThan(0);expect(mainLoads).toBeGreaterThan(0);expect(forbidden).toEqual([]);
    const mount=await page.evaluate(()=>({hash:location.hash,pages:document.querySelectorAll('.fc-results').length,dialogs:document.querySelectorAll('dialog.fc-confirm[open]').length}));
    expect(mount.hash).toMatch(/^#consistency\?/);expect(mount.pages).toBe(1);expect(mount.dialogs).toBe(1);
    return {...provenance,component_loads:loads,main_loads:mainLoads,forbidden_requests:forbidden,mount,exact_sources_revalidated:true,
      limits:'Exact R43 FileConsistency plus 12 unchanged direct local imports in current native shell, synthetic HTTP fixture; not complete R43 app/prototype/real services or business acceptance.'};
  };
}

/** Actual 1440×960 viewport; capture does not move focus, scroll or disclosure state. */
export async function captureConsistencyConfirmation(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const facts=await page.evaluate(()=>{
    const rect=(e:Element|null)=>{if(!(e instanceof HTMLElement))return null;const r=e.getBoundingClientRect();return {box:r.toJSON(),scrollTop:e.scrollTop,scrollHeight:e.scrollHeight,clientHeight:e.clientHeight,clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,visible:e.checkVisibility(),inViewport:r.top>=0&&r.bottom<=innerHeight&&r.left>=0&&r.right<=innerWidth};};
    const dialog=document.querySelector<HTMLDialogElement>('dialog.fc-confirm[open]');
    return {width:innerWidth,height:innerHeight,pageWidth:document.documentElement.scrollWidth,hash:location.hash,
      dialog:{text:dialog?.innerText,...rect(dialog)},source:dialog?.querySelector('.fc-confirm-source')?.textContent??null,
      rows:[...(dialog?.querySelectorAll<HTMLElement>('li')??[])].map(e=>({version:e.dataset.confirmVersion??null,text:e.innerText,...rect(e)})),
      body:rect(dialog?.querySelector('.fc-confirm-body')??null),heading:rect(dialog?.querySelector('header')??null),footer:rect(dialog?.querySelector('.pf-footer')??null),
      details:[...(dialog?.querySelectorAll('details')??[])].map(e=>({open:e.open,text:e.innerText})),
      focus:document.activeElement instanceof HTMLElement?{id:document.activeElement.id,tag:document.activeElement.tagName}:null};
  });
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.pageWidth).toBeLessThanOrEqual(1441);
  const png=join(directory,name+'.png');await page.screenshot({path:png,fullPage:false});const bytes=await readFile(png);
  await writeFile(join(directory,name+'.json'),JSON.stringify({...facts,audit,png:{bytes:bytes.length,sha256:hash(bytes)},synthetic:true},null,2)+'\n');return facts;
}
