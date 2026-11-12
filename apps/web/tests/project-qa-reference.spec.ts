
import {test,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {createHash} from 'node:crypto';
import ts from 'typescript';
import {fixture,install,writes,projectId,prepareId,questions,oldMaterial,oldArtifact,answerId} from './project-qa-continuation-fixtures';

// Read-only capture of the immutable QA component with current shell/dependencies.
// The shell-only bridge below restores its historical constructor arguments.
// There is no
// verified dedicated Word-QA prototype in this baseline. This is a reference
// screenshot, not an acceptance test of the changed production controller.
const root=resolve(process.cwd(),'../..'),baseline=resolve(root,'../remote-review-20261025-ffd637f/BondBuddy-develop');
test.skip(!process.env.BB_UX_EVIDENCE_DIR || ['project-qa-workspace.ts','project-qa-workspace.css'].some(file=>!existsSync(join(baseline,'apps/web/src',file))),
  'Historical component screenshots require an explicit evidence run and its local immutable baseline.');
for(const width of [1440,390])test(`baseline QA reference at ${width}`,async({page})=>{
 const evidence=process.env.BB_UX_EVIDENCE_DIR;if(!evidence)throw Error('BB_UX_EVIDENCE_DIR is required for reference capture');
 const original=await readFile(join(baseline,'apps/web/src/project-qa-workspace.ts'),'utf8');
 const css=await readFile(join(baseline,'apps/web/src/project-qa-workspace.css'),'utf8');
 expect(createHash('sha256').update(original).digest('hex')).toBe('ee78cf781733e6028f63504f5e1eaeed6d879f86adc086afc9bbb6c0f4ecd8a8');
 expect(createHash('sha256').update(css).digest('hex')).toBe('ad92e00f1c50f265d6993bf9c0313aaee33f319c504a852e9c0746e381376977');
 const shellAdapters:{source_sha256:string;adapted_sha256:string;matches:number}[]=[];
 await page.route('**/src/main.ts*',async route=>{
  const response=await route.fetch();expect(response.status()).toBe(200);const source=await response.text();
  // ffd637f expects (api,shell,current,assistantCallback,projectId); the current
  // shell passes (api,shell,current,projectId,ownerId). Keep both the original
  // component and the real global assistant; never pass the owner as project ID.
  const currentConstructor=/new ProjectQaWorkspace\(api,\s*shell,\s*\(\)\s*=>\s*token\s*===\s*epoch,\s*query\.get\(["']project["']\)\s*\?\?\s*undefined,\s*identity\)/g;
  const matches=[...source.matchAll(currentConstructor)];expect(matches).toHaveLength(1);
  const adapted=source.replace(currentConstructor,'new ProjectQaWorkspace(api, shell, () => token === epoch, () => globalAssistant, query.get("project") ?? undefined)');
  shellAdapters.push({source_sha256:createHash('sha256').update(source).digest('hex'),adapted_sha256:createHash('sha256').update(adapted).digest('hex'),matches:matches.length});
  await route.fulfill({response,body:adapted});
 });
 let script=ts.transpileModule(original,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText;
 script=script.replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`);
 script=script.replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name)=>quote+'/src/'+name+(name.endsWith('.css')?'':'.ts')+quote);
 await page.route('**/src/project-qa-workspace.ts*',route=>route.fulfill({contentType:'text/javascript',body:script}));
 await page.route('**/src/project-qa-workspace.css*',route=>route.fulfill({contentType:'text/javascript',body:`const style=document.createElement('style');style.textContent=${JSON.stringify(css)};document.head.append(style);export default '';`}));
 const state=fixture();state.workspace.draft={preparation_id:prepareId,questions:[structuredClone(questions[0]),structuredClone(questions[2])],materials:[oldMaterial,oldArtifact],requirements:'保留历史要求：逐题说明依据与待补材料。',use_knowledge:false};
 await install(page,state);await page.setViewportSize({width,height:width===390?844:960});await mkdir(evidence,{recursive:true});
 const records=[];
 for(const [stateName,suffix] of [['completed','&run='+answerId],['preparation','']]){
  await page.goto('/#qa?project='+projectId+suffix);await expect(page.locator('#qa-history')).toBeVisible();await expect(page.locator('.qa-page .page-head')).toContainText('上传 Word 问题清单，让 BondBuddy 把回答写回文档。');if(stateName==='preparation'){await expect(page.locator('#qa-use-knowledge')).toBeVisible();await expect(page.locator('[data-qa-knowledge-choice]')).toHaveCount(0);}
  await page.evaluate(async()=>{(document.activeElement as HTMLElement|null)?.blur();window.scrollTo(0,0);await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));});
  const filename=`qa-reference-${stateName}-${width}.png`;await page.screenshot({path:join(evidence,filename),fullPage:true});
  records.push({filename,viewport:{width,height:width===390?844:960},overflow:await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)});
 }
 expect(shellAdapters.length).toBeGreaterThan(0);expect(state.calls.filter(call=>call.method==='GET'&&call.path===`/projects/${projectId}/qa`).length).toBeGreaterThanOrEqual(2);
 expect(writes(state)).toEqual([]);expect(state.errors).toEqual([]);expect(state.unexpected).toEqual([]);
 await writeFile(join(evidence,`qa-reference-capture-${width}.json`),JSON.stringify({baseline_sha:'ffd637fac6c1fdf1581112e728f21ec29a94c67c',source_sha256:createHash('sha256').update(original).digest('hex'),css_sha256:createHash('sha256').update(css).digest('hex'),shell_constructor_adapter:shellAdapters,scope:'immutable QA component; current shell, assistant and dependencies',records,write_requests:0,errors:[]},null,2));
});
