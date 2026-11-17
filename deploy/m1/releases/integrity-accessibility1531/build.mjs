import {readFileSync,writeFileSync,mkdirSync,copyFileSync,readdirSync,symlinkSync,existsSync} from 'node:fs';
import {join,dirname} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {hostEnvironment} from '../20261117-cdp-1449-1482/local-environment/platform.mjs';
const out=dirname(fileURLToPath(import.meta.url)),root='C:/Users/yingx/AppData/Local/BondBuddy/integrity-release-1531/web',repo='C:/Users/yingx/.codex/worktrees/integrity-unavailable-sites-20261116';
const deps='C:/Users/yingx/.codex/worktrees/cdp-encrypted-release-20261117/BondBuddy-team-log-read-access-20261116',base='abd903e0de6fb360247ed90eb6624ebc5aeba9ca',source='39d9fa5f3c99d00d564cff6bec08f33416ce55fe',env=hostEnvironment();
const run=(bin,args,cwd=repo)=>execFileSync(bin,args,{cwd,env,windowsHide:true,maxBuffer:40e6});
const sha=b=>createHash('sha256').update(b).digest('hex'),live=JSON.parse(readFileSync(join(out,'preflight-main.out'),'utf8'));
if(existsSync(root))throw Error('Existing build requires reconciliation');mkdirSync(root,{recursive:true});
const tar=join(root,'source.tar');run('git',['archive','--format=tar','--output='+tar,base,'package.json','package-lock.json','apps/web','packages/contracts','product-prototype/public']);
run('C:/Program Files/WindowsApps/OpenAI.CodexPrimaryRuntime.v26-1112-737-0_26.1112.737.0_x64__3k8sg7r9htsxt/dependencies/python/python.exe',['-c','import tarfile,sys;tarfile.open(sys.argv[1]).extractall(sys.argv[2],filter=tarfile.data_filter)',tar,root]);
const prior=[join(out,'../20261117-integrity-1495/scope.patch'),join(repo,'deploy/m1/releases/encrypted-source1482/web-scope.patch'),join(repo,'deploy/m1/releases/audit-required1523/web-scope.patch')];
for(const p of prior){run('git',['apply','--check',p],root);run('git',['apply',p],root);}
let idx=readFileSync(join(root,'apps/web/index.html'),'utf8');if(!idx.includes('name="referrer"'))idx=idx.replace('    <title>','    <meta name="referrer" content="same-origin" />\n    <title>');writeFileSync(join(root,'apps/web/index.html'),idx);
const nm=join(root,'node_modules');mkdirSync(nm);for(const d of readdirSync(join(deps,'node_modules'),{withFileTypes:true}))if(d.name!=='@bondbuddy'&&d.name!=='.package-lock.json'&&d.isDirectory())symlinkSync(join(deps,'node_modules',d.name),join(nm,d.name),'junction');mkdirSync(join(nm,'@bondbuddy'));symlinkSync(join(root,'packages/contracts'),join(nm,'@bondbuddy/contracts'),'junction');
const build=tag=>{for(const [kind,args,cwd]of [['contracts',[join(deps,'node_modules/typescript/bin/tsc'),'-p','tsconfig.json'],join(root,'packages/contracts')],['web',[join(deps,'node_modules/vite/bin/vite.js'),'build'],join(root,'apps/web')]])writeFileSync(join(out,tag+'-'+kind+'.log'),run(process.execPath,args,cwd));};
build('baseline');
const baseline=live.roles.web.files.map(f=>({path:f.path,expected:f.sha256,actual:sha(readFileSync(join(root,'apps/web/dist',f.path.replace('/usr/share/nginx/html/',''))))}));writeFileSync(join(out,'baseline.json'),JSON.stringify(baseline,null,2));if(baseline.some(f=>f.expected!==f.actual))throw Error('Live baseline byte mismatch');console.log('Reproduced all seven current production web files');
const scope=['apps/web/src/integrity-site-picker.ts','apps/web/src/integrity-workspace.ts','apps/web/src/integrity-workspace.css','packages/contracts/src/integrity-site-availability.ts','packages/contracts/src/integrity-sites.ts'];
const patch=run('git',['diff','492f09893059691e98a86e227ab708176cd67ed7',source,'--',...scope]);writeFileSync(join(out,'scope.patch'),patch);run('git',['apply','--check',join(out,'scope.patch')],root);run('git',['apply',join(out,'scope.patch')],root);build('candidate');
const sites=await import(pathToFileURL(join(root,'packages/contracts/dist/integrity-sites.js')).href),availability=await import(pathToFileURL(join(root,'packages/contracts/dist/integrity-site-availability.js')).href);
const shandong=sites.integritySelectableSitesForSubjects([{kind:'company',name:'合成山东企业',province:'山东省',city:'东营市'}]).map(x=>x.id);if(shandong.length!==34||!shandong.includes('local-csrc')||shandong.includes('local-tax'))throw Error('Incorrect Shandong scope');
const count=Object.values(availability.INTEGRITY_VERIFIED_ENDPOINTS).reduce((s,a)=>s+a.length,0);if(count!==79)throw Error('Incorrect endpoint count');
const files=[],payload=join(out,'payload');function add(src,path,role){const dest=join(payload,path.slice(1));mkdirSync(dirname(dest),{recursive:true});copyFileSync(src,dest);const b=readFileSync(dest);files.push({path,role,sha256:sha(b),bytes:b.length});}
add(join(root,'packages/contracts/dist/integrity-site-availability.js'),'/app/packages/contracts/dist/integrity-site-availability.js','api');
const dist=join(root,'apps/web/dist'),index=readFileSync(join(dist,'index.html'),'utf8');for(const f of ['index.html',...[...index.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)].map(m=>m[1].slice(1))])add(join(dist,f),'/usr/share/nginx/html/'+f,'web');
const manifest={source_commit:source,develop_merge:'d208d881ab838502f33d51201a6b10d449125f1e',files,before:Object.fromEntries(Object.entries(live.roles).map(([role,c])=>[role,{id:c.id,image:c.image,files:c.files.map(({path,sha256})=>({path,sha256}))}])),baseline_files:baseline,web_base:base,prior_patches:prior.map(p=>({path:p,sha256:sha(readFileSync(p))})),scope,scope_patch_sha256:sha(patch),root,payload,shandongSiteIds:shandong,enabledEndpoints:count,pausedEndpoints:50,migrations:0,workers_changed:false,full_quality_gate_passed:false};writeFileSync(join(out,'manifest.json'),JSON.stringify(manifest,null,2));console.log(JSON.stringify({files:files.length,shandong:shandong.length,enabled:count,root}));
