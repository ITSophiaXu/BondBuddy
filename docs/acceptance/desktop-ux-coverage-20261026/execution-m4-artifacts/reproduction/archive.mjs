import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,readdirSync,existsSync,copyFileSync} from 'node:fs';
import {gzipSync,gunzipSync} from 'node:zlib';
import {spawnSync} from 'node:child_process';
import {dirname,resolve,join,relative} from 'node:path';
import {fileURLToPath} from 'node:url';

const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const target=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-m4-artifacts');
assert(!existsSync(target),'Never overwrite an existing acceptance archive');
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=p=>JSON.parse(readFileSync(p,'utf8'));
const json=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx'});
const runs=readdirSync(join(local,'runs')).sort().map(id=>({id,dir:join(local,'runs',id),result:read(join(local,'runs',id,'result.json'))}));
const latest=mode=>{const r=runs.findLast(r=>r.result.mode===mode&&r.result.status===0);assert(r,`No successful ${mode}`);return r;};
const counts=run=>{const text=readFileSync(join(run.dir,'run.log'),'utf8'),v={};for(const key of ['tests','pass','fail','cancelled','skipped']){const values=[...text.matchAll(new RegExp(`(?:ℹ|#) ${key} (\\d+)`,'g'))];if(values.length)v[key]=Number(values.at(-1)[1]);}return v;};
const accepted=Object.fromEntries(['api-registry','api-regression','api-cases','worker-regression'].map(mode=>{const r=latest(mode),c=counts(r);assert(c.tests>0&&c.fail===0&&c.cancelled===0,mode);return [mode,{run:r.id,...c}];}));
const before=latest('source-before'),after=latest('source-after');
assert.equal(after.result.snapshot.before,before.id);assert.equal(before.result.snapshot.sha256,after.result.snapshot.sha256);
const windows=runs.filter(r=>r.result.mode==='source-after'&&r.result.status===0).map(end=>{
  const begin=runs.find(r=>r.id===end.result.snapshot.before);assert(begin&&begin.result.status===0);
  for(const r of [begin,end])assert.equal(sha(readFileSync(join(r.dir,'snapshot.json'))),r.result.snapshot.sha256,'Snapshot bytes differ from receipt');
  assert.equal(begin.result.snapshot.sha256,end.result.snapshot.sha256);
  return {begin,end,start:Date.parse(begin.result.finished),finish:Date.parse(read(join(end.dir,'start.json')).started),scriptSha:read(join(begin.dir,'start.json')).script_sha256};
});
for(const [mode,selection] of Object.entries(accepted)){
  const selected=runs.find(r=>r.id===selection.run),start=read(join(selected.dir,'start.json'));
  assert.equal(runs.findLast(r=>r.result.mode===mode).id,selected.id,`${mode}: a later failure cannot reuse an older success`);
  const window=windows.find(w=>Date.parse(start.started)>=w.start&&Date.parse(selected.result.finished)<=w.finish&&start.script_sha256===w.scriptSha);
  assert(window,`${mode}: accepted run/verifier outside a matching source freeze`);
  selection.freeze_before=window.begin.id;selection.freeze_after=window.end.id;
}
assert.equal(latest('m4-replay').result.migration_sha256,sha(readFileSync(resolve(root,'db/migrations/0130_m4_execution_artifacts.sql'))));
const frozen=read(join(after.dir,'snapshot.json'));
for(const entry of frozen){const b=readFileSync(resolve(root,entry.path));assert.equal(b.length,entry.bytes,entry.path);assert.equal(sha(b),entry.sha256,entry.path);}
const stop=latest('pg-stop');assert.equal(stop.result.stopped,true);
function git(args){const r=spawnSync('git',['-c',`safe.directory=${root.replaceAll('\\','/')}`,...args],{cwd:root,encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stderr);return r.stdout.trim().split(/\r?\n/).filter(Boolean);}
const changed=[...new Set([...git(['diff','--name-only','HEAD','--','apps','packages','db']),...git(['ls-files','--others','--exclude-standard','--','apps','packages','db'])])].sort();
const sources=changed.map(path=>{const entry=frozen.find(e=>e.path===path);assert(entry,`Changed source absent from tested freeze: ${path}`);return entry;});
for(const selection of Object.values(accepted)){
  const selected=runs.find(r=>r.id===selection.freeze_after),entries=read(join(selected.dir,'snapshot.json'));
  for(const source of sources)assert.deepEqual(entries.find(e=>e.path===source.path),source,`Accepted run tested different source: ${source.path}`);
}
mkdirSync(target,{recursive:true});
writeFileSync(join(target,'.gitattributes'),'raw/** -text -diff\nreproduction/** -text\n',{flag:'wx'});
const raw=[];
function archive(directory,destination){mkdirSync(destination,{recursive:true});for(const item of readdirSync(directory,{withFileTypes:true})){assert(!item.isSymbolicLink());const from=join(directory,item.name),to=join(destination,item.name);if(item.isDirectory())archive(from,to);else{const b=readFileSync(from);if(item.name.endsWith('.log')){const zipped=gzipSync(b);assert(gunzipSync(zipped).equals(b));writeFileSync(to+'.gz',zipped,{flag:'wx'});raw.push({original:relative(local,from).replaceAll('\\','/'),archive:relative(target,to+'.gz').replaceAll('\\','/'),bytes:b.length,sha256:sha(b),encoding:'gzip'});}else{copyFileSync(from,to);raw.push({original:relative(local,from).replaceAll('\\','/'),archive:relative(target,to).replaceAll('\\','/'),bytes:b.length,sha256:sha(b),encoding:'identity'});}}}}
archive(join(local,'runs'),join(target,'raw/runs'));archive(join(local,'versions'),join(target,'raw/versions'));
mkdirSync(join(target,'reproduction'));for(const name of ['verify.mjs','archive.mjs','playwright.config.mjs'])copyFileSync(join(local,name),join(target,'reproduction',name));
json(join(target,'sources.json'),sources);json(join(target,'raw-files.json'),raw);
const failures=runs.filter(r=>r.result.status!==0).map(r=>({run:r.id,mode:r.result.mode,counts:counts(r),error:r.result.error}));
const summary={scope:'Synthetic M4 exact V1 Word registration, real PostgreSQL readback/receipts/settlement; successor and B repricing remain disabled',accepted,failures,
  freeze:{before:before.id,after:after.id,files:frozen.length,sha256:after.result.snapshot.sha256},
  freeze_windows:runs.filter(r=>r.result.mode==='source-after'&&r.result.status===0).map(r=>({before:r.result.snapshot.before,after:r.id,files:r.result.snapshot.files,sha256:r.result.snapshot.sha256})),database_stop:stop.id,
  calls:runs.length,builds:runs.filter(r=>['build','api-build','worker-build','contracts-check'].includes(r.result.mode)).map(r=>({run:r.id,mode:r.result.mode,status:r.result.status})),
  migration:runs.filter(r=>['migrate','m4-replay'].includes(r.result.mode)).map(r=>({run:r.id,mode:r.result.mode,status:r.result.status,migration_sha256:r.result.migration_sha256??null})),
  raw_files:raw.length,raw_format:'Every original log is losslessly gzip-compressed and round-trip verified; metadata/snapshots are byte copies. Manifest excludes itself.',
  limitations:['No external model, production system, new browser acceptance, professional-content or Word/WPS visual acceptance.','Worker pipeline test requires Azurite and is skipped; Windows symlink test is skipped.','Initial migrate precedes the added replay guards; m4-replay installs and saves the final 0130 SQL before both frozen test windows.','Source freeze records working-tree bytes; Git may normalize line endings. Browser config is a verifier dependency; browser mode was not run.']};
json(join(target,'summary.json'),summary);
const a=accepted;
writeFileSync(join(target,'README.md'),`# M4 文件登记绑定准确执行（0130，本地）\n\nM4 正文与编制说明按完整执行/输入和准确 artifact 来源登记。保留旧字段、NULL 稿次和 PostgreSQL 微秒；新旧 V1 INSERT 原子镜像，重复登记核对全部可提供的元数据。Word 读取、底稿、交付成员与结算 readiness 消费准确登记；缺失时拒绝旧 Word 兜底。问答仍使用严格的 QA snapshot、subtype、binding 与持久化全文证据。通用已交付文件引用保留原授权。\n\nWorker 先锁 topic/project，再锁 run/job 并重新验租约；真实并发测试证明等 topic 时 run 未被提前锁定，等待期间过期的租约不产生登记或事件。双文件齐全才形成耐久交付；动态余额任务仍须完成原结算才可下载，充值后复用已保存文件。撤销编制说明时终态交付被拒绝。\n\n| 独立集合 | pass | fail | skip |\n| --- | ---: | ---: | ---: |\n| API 登记专项 | ${a['api-registry'].pass} | 0 | ${a['api-registry'].skipped} |\n| API 相关回归 | ${a['api-regression'].pass} | 0 | ${a['api-regression'].skipped} |\n| API 案例模板 | ${a['api-cases'].pass} | 0 | ${a['api-cases'].skipped} |\n| Worker 相关回归 | ${a['worker-regression'].pass} | 0 | ${a['worker-regression'].skipped} |\n\n构建覆盖 contracts/API/Worker 和 web 类型检查，契约样例与原有定向检查通过。各组与各轮不相加为 UX 场景覆盖率。采用运行 ID、原始计数、构建记录及冻结窗口见 [summary.json](summary.json)，改动源码的实际工作区字节见 [sources.json](sources.json)。最后冻结 ${frozen.length} 个文件，测试前后和封存时逐项核验一致。各采用组绑定各自冻结窗口和启动器 hash；最后一窗口只调整选集检查，全部改动源码与各采用窗口逐项一致。\n\n## 失败与采用\n\n首轮 API 登记为 13 pass / 2 fail：QA 期望漏掉真实持久化的公开检索声明；动态 fixture 用户名含非法连字符。修正为核对准确全文、hash/bytes 与合法用户名。首轮 Worker 为 40 pass / 1 fail / 2 skip：旧 mock 仍匹配旧登记表；改为 canonical 视图并补缺失登记拒绝断言。未改生产约束、超时或计价。最终登记及 Worker 采用完整重跑，失败原文与全部运行均保留。API 相关回归命令曾列出两个不存在的文件模式，Node 未执行这些模式，未计入覆盖；真实案例模板测试以 api-cases 单独补跑，最终启动器增加文件存在性检查。原命令及当时启动器版本均保留。\n\n日志在 raw/ 下以 gzip 无损保存，已逐份解压核对原字节；[raw-files.json](raw-files.json) 记录原始路径、大小和 hash。JSON、冻结和 verifier 各版本直接复制；[reproduction](reproduction/) 保存最终启动器。旧验收档案未修改。迁移先从本地 0129 升至 0130，随后在空业务的专用模板上按真实前驱拆除/回放最终 0130；最终 SQL 正文和 hash 随 m4-replay 保存，专项另验证历史回填和失败原子性。不称重建全部历史迁移。\n\n测试克隆已清理，已审计业务表仅余原迁移 seed；无其他连接。专用 PG 已按目录/端口/PID 核对并停止，回执为 ${stop.id}。\n\n## 限制与后续\n\n材料、模型回复及 DOCX 为合成数据；数据库、私有内存字节 readback、队列结算、下载和锁为实际本地实现。Worker 的 Azurite 全流水线和 Windows symlink 两项跳过；未调用外部模型/生产系统，未新增浏览器或 Word/WPS 排版验收。复制的浏览器配置仅为 verifier 冻结依赖，未运行浏览器。\n\n费用沿现有规则；用户已选 B，追加公式 B1/B2 仍待确定。全局 V1/current-input gate、后继采用/执行、阶段/调用版本、真正增量处理、版本化追加报价/账务与完整桌面同任务续做仍未完成。G03 / UX-A03 与整体 goal 保持 active。本轮仅本地提交，未推送、创建 PR 或部署。\n`,{flag:'wx'});
const files=[];function manifest(directory){for(const e of readdirSync(directory,{withFileTypes:true})){const p=join(directory,e.name);if(e.isDirectory())manifest(p);else{const b=readFileSync(p);files.push({path:relative(target,p).replaceAll('\\','/'),bytes:b.length,sha256:sha(b)});}}}manifest(target);files.sort((a,b)=>a.path.localeCompare(b.path));json(join(target,'manifest.json'),files);
console.log(JSON.stringify({target,accepted,calls:runs.length,files:files.length+1,failures:failures.length}));
