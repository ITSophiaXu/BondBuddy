import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';
const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/review-flow-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Exact sealed R26 editor in the current application; shared cache/CSS are verified unchanged. */
export async function installReviewFlowReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const sealedText=await readFile(join(root,'ux-evidence',provenance.sealed_command),'utf8');expect(hash(sealedText)).toBe(provenance.sealed_command_sha256);
  const sealed=JSON.parse(sealedText),source=await readFile(join(directory,'review-editor.ts'),'utf8');
  const dependencies:{path:string;sha256:string;shared_unchanged:boolean}[]=[];
  for(const file of ['review-editor.ts','review-editor-cache.ts','review-editor.css']){
    const relative='apps/web/src/'+file,exact=await readFile(join(directory,file),'utf8'),sha256=hash(exact);
    expect(sha256).toBe(provenance.sources.find((item:{path:string})=>item.path===relative)?.sha256);
    expect(sha256).toBe(sealed.source_before.find((item:{path:string})=>item.path===relative)?.sha256);
    expect(sha256).toBe(sealed.source_after.find((item:{path:string})=>item.path===relative)?.sha256);
    if(file!=='review-editor.ts'){expect(await readFile(join(root,relative),'utf8')).toBe(exact);dependencies.push({path:relative,sha256,shared_unchanged:true});}
  }
  const body=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
    .replace(/from ['"]@bondbuddy\/contracts['"]/g,'from "/@fs/'+root.replaceAll('\\','/')+'/packages/contracts/dist/index.js"')
    .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
    .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
  let loads=0;await page.route('**/src/review-editor.ts*',route=>{loads++;return route.fulfill({contentType:'text/javascript',body});});
  return async()=>{const after=await readFile(join(directory,'review-editor.ts'),'utf8');expect(after).toBe(source);expect(loads).toBeGreaterThan(0);for(const dependency of dependencies)expect(hash(await readFile(join(root,dependency.path),'utf8'))).toBe(dependency.sha256);return {...provenance,replaced_components:[{path:'apps/web/src/review-editor.ts',sha256:hash(source),sha256_after:hash(after),loads,immutable:true}],shared_dependencies:dependencies};};
}
export async function captureReviewFlow(page:Page,directory:string,name:string,audit:unknown){
  await mkdir(directory,{recursive:true});const component=page.locator('#review-results-panel');await component.scrollIntoViewIfNeeded();
  const state=await page.evaluate(()=>({width:innerWidth,height:innerHeight,scrollWidth:document.documentElement.scrollWidth,hash:location.hash,
    selectedRun:document.querySelector<HTMLSelectElement>('[data-editor-history]')?.value,category:document.querySelector<HTMLSelectElement>('#review-editor-category')?.value,
    selectedIssue:document.querySelector<HTMLElement>('[data-editor-issue].active')?.dataset.editorIssue,
    detailTitle:document.querySelector('.review-issue-detail h3')?.textContent,
    status:document.querySelector('[data-editor-status]')?.textContent,
    toolbar:document.querySelector<HTMLElement>('.review-editor-toolbar')?.innerText,
    saveDisabled:document.querySelector<HTMLButtonElement>('[data-editor-save]')?.disabled,
    discardPresent:!!document.querySelector('[data-editor-discard]'),discardDisabled:document.querySelector<HTMLButtonElement>('[data-editor-discard]')?.disabled,
    followupDisabled:document.querySelector<HTMLButtonElement>('[data-editor-followup]')?.disabled,
    manual:document.querySelector<HTMLTextAreaElement>('#review-manual-text')?.value,
    preview:document.querySelector<HTMLElement>('[data-editor-document]')?.innerText}));
  expect(state.width).toBe(1440);expect(state.scrollWidth).toBeLessThanOrEqual(1441);
  await component.screenshot({path:join(directory,name+'.png')});await writeFile(join(directory,name+'.json'),JSON.stringify({...state,audit},null,2));return state;
}
