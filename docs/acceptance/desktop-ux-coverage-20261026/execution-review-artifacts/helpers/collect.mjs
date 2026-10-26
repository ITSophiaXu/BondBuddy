import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

// Collection only: no service, database, test, Git or subprocess operations.
const local=dirname(fileURLToPath(import.meta.url)),root=resolve(local,'../..');
const destination=resolve(root,'docs/acceptance/desktop-ux-coverage-20261026/execution-review-artifacts');
assert.equal(local,resolve(root,'.local/execution-review-artifacts-20261027'));
assert(!existsSync(destination),'Never overwrite a sealed or candidate archive');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const invocations=readdirSync(join(local,'runs')).sort().map(id=>{
  const resultPath=join(local,'runs',id,'result.json');
  assert(existsSync(resultPath),`Invocation incomplete: ${id}`);
  return JSON.parse(readFileSync(resultPath,'utf8'));
});
const last=mode=>{const result=invocations.filter(r=>r.mode===mode&&r.status===0).at(-1);assert(result,`Missing successful ${mode}`);return result;};
const stats=id=>{
  const log=readFileSync(join(local,'runs',id,'run.log'),'utf8'),result={};
  for(const field of ['tests','pass','fail','cancelled','skipped','todo']){
    const matches=[...log.matchAll(new RegExp(`^(?:ℹ |# )${field} (\\d+)\\r?$`,'gm'))];
    assert(matches.length,`Missing ${field}: ${id}`);result[field]=Number(matches.at(-1)[1]);
  }
  return result;
};
const adopted={};
for(const [mode,total] of [['api-registry',10],['api-editor-migration',8],['api-regression',94],['worker-regression',82]]){
  const run=last(mode),counts=stats(run.id);
  assert.equal(counts.tests,total,mode);assert.equal(counts.fail,0);assert.equal(counts.cancelled,0);
  assert.equal(counts.skipped,mode==='worker-regression'?1:0);
  adopted[mode]={invocation:run.id,...counts};
}
const freezePairs=invocations.filter(r=>r.mode==='source-after'&&r.status===0).map(after=>{
  const before=invocations.find(r=>r.id===after.snapshot.before);assert(before&&before.status===0&&before.mode==='source-before');
  const original=readFileSync(join(local,'runs',before.id,'snapshot.json'));
  const actual=readFileSync(join(local,'runs',after.id,'snapshot.json'));
  assert(original.equals(actual));assert.equal(sha(original),before.snapshot.sha256);assert.equal(sha(actual),after.snapshot.sha256);
  return {before:before.id,after:after.id,files:after.snapshot.files,sha256:after.snapshot.sha256};
});
assert(freezePairs.length);
for(const value of Object.values(adopted)){
  const started=Date.parse(JSON.parse(readFileSync(join(local,'runs',value.invocation,'start.json'),'utf8')).started);
  const finished=Date.parse(invocations.find(r=>r.id===value.invocation).finished);
  const pair=freezePairs.find(p=>Date.parse(invocations.find(r=>r.id===p.before).finished)<=started
    &&finished<=Date.parse(JSON.parse(readFileSync(join(local,'runs',p.after,'start.json'),'utf8')).started));
  assert(pair,`Adopted invocation has no unchanged source/build interval: ${value.invocation}`);
  value.freeze_before=pair.before;value.freeze_after=pair.after;
}
const freezeChanges=freezePairs.slice(1).map((current,index)=>{
  const previous=freezePairs[index];
  const entries=id=>new Map(JSON.parse(readFileSync(join(local,'runs',id,'snapshot.json'),'utf8')).map(entry=>[entry.path,entry]));
  const before=entries(previous.after),after=entries(current.before);
  const paths=[...new Set([...before.keys(),...after.keys()])].sort();
  return {from:previous.after,to:current.before,changed:paths.filter(path=>JSON.stringify(before.get(path))!==JSON.stringify(after.get(path)))};
});
// The last freeze must still describe the actual source/build files at sealing.
const finalFreeze=freezePairs.at(-1);
const finalSnapshot=JSON.parse(readFileSync(join(local,'runs',finalFreeze.after,'snapshot.json'),'utf8'));
const frozenRoots=invocations.find(r=>r.id===finalFreeze.after).snapshot.roots;
const actualPaths=[];
function enumerate(directory){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    assert(!entry.isSymbolicLink());if(entry.isDirectory()&&entry.name==='__pycache__')continue;
    const path=join(directory,entry.name);
    if(entry.isDirectory())enumerate(path);else if(entry.isFile())actualPaths.push(relative(root,path).replaceAll('\\','/'));
  }
}
for(const directory of frozenRoots)enumerate(resolve(root,directory));
for(const entry of finalSnapshot)if(!frozenRoots.some(directory=>entry.path.startsWith(directory+'/')))actualPaths.push(entry.path);
assert.deepEqual(actualPaths.sort(),finalSnapshot.map(entry=>entry.path).sort(),'Source/build file set changed after final freeze');
for(const entry of finalSnapshot){
  const bytes=readFileSync(resolve(root,entry.path));assert.equal(bytes.length,entry.bytes,entry.path);assert.equal(sha(bytes),entry.sha256,entry.path);
}
const stopped=last('pg-stop');assert.equal(stopped.stopped,true);
assert.equal(stopped.database_audit.clones.length,0);assert.equal(stopped.database_audit.other_clients.length,0);
const migration=last('migrate');
const summary={version:'execution-review-artifacts-evidence-v1',created_at:new Date().toISOString(),
  subject:'0129 review execution artifact selections; G03 remains incomplete',
  invocations,adopted,freeze_pairs:freezePairs,freeze_changes:freezeChanges,migration_invocation:migration.id,stop_invocation:stopped.id,
  failures:invocations.filter(r=>r.status!==0).map(r=>({id:r.id,mode:r.mode,error:r.error})),
  limits:['Synthetic material and DOCX bytes, real local PostgreSQL and contained Python work; no external model/provider or production system.',
    'No browser or complete same-run supplement journey executed in this slice. No V2 execution/adoption or additional pricing enabled.',
    '0129 applied as an upgrade to the seed-only 0128 template; private clone tests remove 0129 and replay the actual new SQL. No fresh whole-history rebuild is claimed.',
    'Migration invocation did not record SQL-byte hashes at execution time. Source freeze preserves final SQL path/size/hash; SQL body remains in the repository.',
    'Source/build freeze includes Python sources, excludes __pycache__; external runtimes are not frozen.',
    'Different test collections and invocations are not added into a scenario-coverage percentage.']};
mkdirSync(destination,{recursive:true});
const entries=[];
const put=(path,bytes,kind)=>{const target=join(destination,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,bytes,{flag:'wx'});entries.push({path,bytes:bytes.length,sha256:sha(bytes),kind});};
put('.gitattributes',Buffer.from('* -text\n'),'generated');
function copyTree(directory,prefix){
  for(const entry of readdirSync(directory,{withFileTypes:true})){
    assert(!entry.isSymbolicLink());const path=join(directory,entry.name),to=`${prefix}/${entry.name}`;
    if(entry.isDirectory())copyTree(path,to);else if(entry.isFile())put(to,readFileSync(path),'raw');
  }
}
copyTree(join(local,'runs'),'raw/runs');copyTree(join(local,'versions'),'raw/versions');
for(const file of ['verify.mjs','playwright.config.mjs','collect.mjs','diagnose.mjs','profile.mjs','profile-hook.mjs'])put(`helpers/${file}`,readFileSync(join(local,file)),'helper');
summary.raw_files=entries.filter(e=>e.kind==='raw').length;
summary.complete_invocations=invocations.length;
put('summary.json',Buffer.from(JSON.stringify(summary,null,2)+'\n'),'generated');
const table=Object.entries(adopted).map(([mode,c])=>`| ${mode} | ${c.pass} | ${c.fail} | ${c.skipped} |`).join('\n');
const failureList=summary.failures.map(r=>`- \`${r.id}\`：${r.error?.message??'See raw result and log.'}`).join('\n');
const readme=`# 复核成果登记绑定准确执行（0129，本地）

新增按 run、执行版本、kind 登记的成果位置，以完整执行/输入关系和准确 artifact 来源约束。最终交付前保留真实重试替换行为；交付回执或成功终态后只允许精确重放。新旧 V1 写入原子镜像，旧历史 gap/未就绪候选保留来源，不新增交付权限。API、Worker、结算 readiness 和交付成员/命名读取准确登记，无 legacy 兜底。

| 独立集合 | pass | fail | skip |
| --- | ---: | ---: | ---: |
${table}

构建覆盖 contracts/API/Worker 和 web 类型检查；contracts 样例/生命周期及原有定向测试通过。各集合/轮次不相加，不代表 UX 场景覆盖率。Worker 的 Windows symlink 项仍跳过。

原始记录共 ${summary.raw_files} 文件、${invocations.length} 次完整调用，失败调用 ${summary.failures.length} 次；完整失败与重试日志保留。冻结共 ${freezePairs.length} 对，最后一对 ${finalFreeze.files} 文件，前后及封存时源码一致。包含 Python 源码，排除 __pycache__，外部运行时不在冻结范围。verify.mjs 调用保留原始命令参数、时间、退出结果和逐版 verifier；源码路径/大小/哈希见冻结记录。两次 api-profile 仅保存各自命令/结果/日志和原 hook 字节，helpers 的 launcher 为最终 file URL 版，首次 launcher 本体未逐版冻结。manifest 不包含自身。

## 失败与采用口径

${failureList||'本轮没有失败调用。'}

首轮 API 回归为 94 tests / 92 pass / 1 fail / 1 cancelled：0125 锁回放测试第二次清理时尝试恢复依赖已删除表类型的旧交付函数，修正 test-only helper 为仅在交付表存在时恢复。另一项绑定拒绝测试触发原 30 秒上限，单独 probe 也曾超时；逐条 SQL 诊断没有改产品或上限，随后 18.4 秒完成。首次诊断启动器使用 Windows 路径作模块 URL 而失败，改 file URL 后成功；两次诊断均保留，不计入完整 API 通过数。最终采用完整 API 重跑。

采用运行 ID、精确计数和冻结对见 summary.json，只有成功的完整重跑被采用。测试启动的数据库克隆已清理，原迁移 platform seed 保留，业务行为空、其他连接为空；专用测试 PG 按准确目录/端口/PID 停止，最终回执见 ${stopped.id}。数据库升级是 0128→0129；新迁移另在私有克隆回放，不称重建全部历史迁移。首次启动的就绪探测失败后只核对同一个已启动 PID，不重启第二个实例。

各采用集合分别绑定其实际源码冻结窗口，不笼统归为同一源码版本。两对冻结之间的变化为：${freezeChanges.map(change=>change.changed.join('、')).join('；')}。Worker 采用前一稳定窗口，完整 API 重跑验证修复后的 helper；没有把前轮失败记为通过。封存时重新枚举冻结 roots 的完整文件集合，并逐条核验字节/hash。

## 限制

材料与 DOCX 为合成字节；数据库、promoter/readback、finish、租约和并发锁是真实本地实现。未调用外部模型、生产系统，未新增浏览器验收。复制的 Playwright 配置仅为 verifier 依赖，未运行浏览器模式。迁移调用当时未记录 SQL 字节哈希；最终冻结只保留 SQL 路径/大小/哈希，正文在仓库 db/migrations/0129_review_execution_artifacts.sql。

全局 V1/current-input gate 保持，M4 成果登记、后继执行采用、阶段/调用身份、真正增量处理、B 追加报价/账务、材料/正文留存和完整桌面同任务续做仍未完成。B1/B2 尚待用户决定，未代入公式。G03 / UX-A03 和整体 goal 均保持 active；本轮没有推送、PR 或部署。
`;
put('README.md',Buffer.from(readme),'generated');
entries.sort((a,b)=>a.path.localeCompare(b.path));
writeFileSync(join(destination,'manifest.json'),JSON.stringify({version:'execution-review-artifacts-evidence-v1',files:entries.length,entries},null,2)+'\n',{flag:'wx'});
console.log(JSON.stringify({destination,archive_files:entries.length+1,manifest_entries:entries.length,raw_files:summary.raw_files,invocations:invocations.length,failures:summary.failures.length,adopted},null,2));
