import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/project-file-status-reference-source');
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
type Source={path:string;sha256:string};

/** Replace exact sealed R33 ProjectFiles only; main and its three imported styles
 * remain shared and hash checked. This is a component comparison inside the
 * same surrounding application, with no new-module implementation shim. */
export async function installProjectFileStatusReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const currentStylePath='apps/web/src/project-file-status.css',currentStyle=await readFile(join(root,currentStylePath),'utf8');let currentStyleLoads=0;
  page.on('request',request=>{if(new URL(request.url()).pathname==='/src/project-file-status.css')currentStyleLoads++;});
  const commandText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');
  expect(hash(commandText)).toBe(provenance.sealed_command_sha256);
  const command=JSON.parse(commandText),originals=new Map<string,string>(),loads=new Map<string,number>(),shared:Source[]=[];
  for(const entry of provenance.sources as Source[]){
    const source=await readFile(join(directory,entry.path),'utf8');
    expect(hash(source)).toBe(entry.sha256);
    expect(command.source_before.find((s:Source)=>s.path===entry.path)?.sha256).toBe(entry.sha256);
    expect(command.source_after.find((s:Source)=>s.path===entry.path)?.sha256).toBe(entry.sha256);
    originals.set(entry.path,source);
    if(basename(entry.path)!=='project-files.ts'){
      expect(await readFile(join(root,entry.path),'utf8')).toBe(source);shared.push(entry);continue;
    }
    loads.set(entry.path,0);
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_match,quote:string,specifier:string)=>{
        let target=resolve(dirname(join(root,entry.path)),specifier).replaceAll('\\','/');
        if(!target.endsWith('.css'))target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';
        const sourceRoot=join(root,'apps/web/src').replaceAll('\\','/')+'/';
        return quote+(target.startsWith(sourceRoot)?'/src/'+target.slice(sourceRoot.length):'/@fs/'+target)+quote;
      });
    await page.route('**/src/'+basename(entry.path)+'*',route=>{
      loads.set(entry.path,loads.get(entry.path)!+1);return route.fulfill({contentType:'text/javascript',body});
    });
  }
  expect([...loads.keys()].map(path=>basename(path)).sort()).toEqual(['project-files.ts']);
  return async()=>{
    const replaced=[];
    for(const[path,source]of originals){
      const after=await readFile(join(directory,path),'utf8');expect(after).toBe(source);
      if(loads.has(path)){
        expect(loads.get(path)).toBeGreaterThan(0);
        replaced.push({path,sha256:hash(source),sha256_after:hash(after),loads:loads.get(path),immutable:true});
      }
    }
    for(const entry of shared)expect(hash(await readFile(join(root,entry.path),'utf8'))).toBe(entry.sha256);
    expect(await readFile(join(root,currentStylePath),'utf8')).toBe(currentStyle);expect(currentStyleLoads).toBe(0);
    return {...provenance,replaced_components:replaced,shared_dependencies:shared.map(s=>({...s,shared_unchanged:true})),
      current_only_styles:[{path:currentStylePath,sha256:hash(currentStyle),loads_in_reference:currentStyleLoads}],
      surrounding_application:'Other imports use the same current surrounding application. The new desktop status stylesheet is imported only by the current ProjectFiles; exact R33 does not load it.'};
  };
}

export async function captureProjectFileStatus(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const facts=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,hash:location.hash,
    statusFilters:[...document.querySelectorAll<HTMLButtonElement>('[data-file-status]')].map(e=>({key:e.dataset.fileStatus,pressed:e.getAttribute('aria-pressed'),disabled:e.disabled,text:e.textContent})),
    statusNote:document.querySelector('#pw-file-status-note')?.textContent??null,prepareOtherFiles:!!document.querySelector('#file-list .pw-prepare'),
    styleModules:[...document.querySelectorAll<HTMLStyleElement>('style[data-vite-dev-id]')].map(e=>e.dataset.viteDevId),
    search:(document.querySelector('#file-search') as HTMLInputElement|null)?.value??null,
    selected:[...document.querySelectorAll<HTMLElement>('#file-folders [aria-current="page"]')].map(e=>({folder:e.dataset.folder??null,type:e.dataset.fileType??null,text:e.textContent})),
    tree:[...document.querySelectorAll<HTMLDetailsElement>('#file-folders>details')].map(e=>({id:e.dataset.fileTree??null,summary:e.querySelector(':scope>summary')?.textContent,open:e.open})),
    focus:{tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement)?.id,key:(document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-file-key]')?.dataset.fileKey??null},
    files:[...document.querySelectorAll<HTMLElement>('#file-list>.collection-file')].map(e=>({key:e.dataset.fileKey??null,family:e.dataset.fileFamily??null,version:e.dataset.fileVersion??null,text:e.textContent,infoBox:e.querySelector('.collection-file-info')?.getBoundingClientRect().toJSON()??null,titleBox:e.querySelector('strong')?.getBoundingClientRect().toJSON()??null,actionsBox:e.querySelector('.pw-file-actions')?.getBoundingClientRect().toJSON()??null,renderable:e.checkVisibility()&&!e.closest('details:not([open])'),inViewport:e.checkVisibility()&&e.getBoundingClientRect().bottom>0&&e.getBoundingClientRect().top<innerHeight,box:e.getBoundingClientRect().toJSON()})),
    text:document.body.innerText,dialogs:document.querySelectorAll('dialog[open]').length}));
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(directory,name+'.png')});
  await writeFile(join(directory,name+'.json'),JSON.stringify({...facts,audit},null,2));return facts;
}
