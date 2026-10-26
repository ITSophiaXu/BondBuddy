import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {basename,dirname,join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/desktop-file-workflow-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Source={path:string;sha256:string};
/** The eight captured sources are tied to sealed R31. Only ProjectFiles is
 * replaced; every other import, including any new CSS, uses the same current
 * surrounding application in both runs. Differences are disclosed, not hidden. */
export async function installDesktopFileWorkflowReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const commandText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(commandText)).toBe(provenance.sealed_command_sha256);
  const command=JSON.parse(commandText),originals=new Map<string,string>(),shared:Source[]=[];let loads=0;
  expect(provenance.sources).toHaveLength(8);
  for(const entry of provenance.sources as Source[]){
    const source=await readFile(join(directory,basename(entry.path)),'utf8');expect(hash(source)).toBe(entry.sha256);
    expect(command.source_before.find((s:Source)=>s.path===entry.path)?.sha256).toBe(entry.sha256);
    expect(command.source_after.find((s:Source)=>s.path===entry.path)?.sha256).toBe(entry.sha256);originals.set(entry.path,source);
    if(basename(entry.path)!=='project-files.ts'){shared.push(entry);continue;}
    const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
      .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
      .replace(/(['"])(\.{1,2}\/[^'"]+)\1/g,(_match,quote:string,specifier:string)=>{
        let target=resolve(dirname(join(root,entry.path)),specifier).replaceAll('\\','/');
        if(!target.endsWith('.css'))target=target.replace(/\.js$/,'').replace(/\.ts$/,'')+'.ts';
        const sourceRoot=join(root,'apps/web/src').replaceAll('\\','/')+'/';
        return quote+(target.startsWith(sourceRoot)?'/src/'+target.slice(sourceRoot.length):'/@fs/'+target)+quote;
      });
    await page.route('**/src/project-files.ts*',route=>{loads++;return route.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    const sharedFacts=[];
    for(const[path,source]of originals)expect(await readFile(join(directory,basename(path)),'utf8')).toBe(source);
    for(const entry of shared){const current=hash(await readFile(join(root,entry.path),'utf8'));sharedFacts.push({...entry,current_sha256:current,unchanged_from_r31:current===entry.sha256});}
    expect(loads).toBeGreaterThan(0);
    return {...provenance,replaced_components:[{path:'apps/web/src/project-files.ts',sha256:hash(originals.get('apps/web/src/project-files.ts')!),loads,immutable:true}],
      shared_dependencies:sharedFacts,surrounding_application:'Only ProjectFiles is R31; all other imports use the same current application in both runs.'};
  };
}
export async function captureDesktopFileWorkflow(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});
  const facts=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,scrollY,hash:location.hash,
    upload:[...document.querySelectorAll<HTMLDialogElement>('dialog[open]')].map(d=>({title:d.querySelector('h2')?.textContent,
      type:(d.querySelector('[name=type]') as HTMLSelectElement|null)?.value,required:(d.querySelector('[name=type]') as HTMLSelectElement|null)?.required,
      disabled:(d.querySelector('[name=type]') as HTMLSelectElement|null)?.disabled,file:(d.querySelector('[name=file]') as HTMLInputElement|null)?.files?.[0]?.name??null})),
    tasks:[...document.querySelectorAll<HTMLElement>('#pw-task-summary article')].map(e=>({run:e.dataset.pwTaskRun??null,text:e.textContent,href:e.querySelector('a')?.getAttribute('href'),box:e.getBoundingClientRect().toJSON()})),
    history:{toggle:document.querySelector('[data-pw-task-history-toggle]')?.textContent??null,more:document.querySelector('[data-pw-task-more]')?.textContent??null},
    focus:{tag:document.activeElement?.tagName,id:(document.activeElement as HTMLElement)?.id,task:(document.activeElement as HTMLElement)?.closest<HTMLElement>('[data-pw-task-run]')?.dataset.pwTaskRun??null},text:document.body.innerText}));
  expect(facts.width).toBe(1440);expect(facts.height).toBe(960);expect(facts.scrollWidth).toBeLessThanOrEqual(1441);
  await page.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...facts,audit},null,2));return facts;
}
