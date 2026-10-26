import {expect,type Page} from '@playwright/test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import ts from 'typescript';

const root=resolve(process.cwd(),'../..'),directory=join(root,'ux-evidence/generation-mobile-reference-source');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
/** Reuse the R19 exact-source interception mechanism against the sealed R19 files. */
export async function installGenerationMobileReference(page:Page){
  const provenance=JSON.parse(await readFile(join(directory,'provenance.json'),'utf8'));
  const originals=new Map<string,string>(),loads=new Map<string,number>();
  for(const file of ['file-workspace.ts','file-generation-cache.ts','project-files.ts','file-workspace.css']){
    const relative='apps/web/src/'+file,source=await readFile(join(directory,relative),'utf8');
    expect(hash(source)).toBe(provenance.sources.find((item:{path:string})=>item.path===relative)?.sha256);originals.set(file,source);loads.set(file,0);
    const body=file.endsWith('.css')?`import {updateStyle} from '/@vite/client'; updateStyle(${JSON.stringify('generation-mobile-reference-'+file)},${JSON.stringify(source)});`:
      ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText
        .replace(/from ['"]@bondbuddy\/contracts['"]/g,`from "/@fs/${root.replaceAll('\\','/')}/packages/contracts/dist/index.js"`)
        .replace(/from ['"]@sinclair\/typebox\/value['"]/g,'from "/node_modules/.vite/deps/@sinclair_typebox_value.js"')
        .replace(/(['"])\.\/([^'"]+)\1/g,(_match,quote,name:string)=>quote+'/src/'+(name.endsWith('.css')||name.endsWith('.ts')?name:name.replace(/\.js$/,'')+'.ts')+quote);
    await page.route(`**/src/${file}*`,route=>{loads.set(file,loads.get(file)!+1);return route.fulfill({contentType:'text/javascript',body});});
  }
  return async()=>{
    const sources=[];
    for(const[file,source]of originals){const after=await readFile(join(directory,'apps/web/src',file),'utf8');expect(after).toBe(source);expect(loads.get(file)).toBeGreaterThan(0);sources.push({path:'apps/web/src/'+file,sha256:hash(source),sha256_after:hash(after),loads:loads.get(file),immutable:true});}
    return {...provenance,approval:'Exact previous component comparison; no new mobile prototype or human approval implied.',sources};
  };
}
