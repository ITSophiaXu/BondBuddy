import {symlinkSync,mkdirSync} from 'node:fs';
import {spawnSync} from 'node:child_process';

mkdirSync('/app/node_modules/@bondbuddy',{recursive:true});
// npm's Windows junctions contain host paths; recreate workspace links in the snapshot.
for(const name of ['contracts','domain','rule-pack-registry','rule-applicability-context'])
  symlinkSync(`/app/packages/${name}`,`/app/node_modules/@bondbuddy/${name}`);
for(const name of ['api','worker','web'])symlinkSync(`/app/apps/${name}`,`/app/node_modules/@bondbuddy/${name}`);
console.log('Snapshot ready; running the unchanged worker assertions and startup deadlines.');
const files=['authoring-pause.pg.test','run-runtime.test','runtime-isolation.test','runtime-parse-slots.test','runtime-entry.test'];
const result=spawnSync(process.execPath,['--test','--test-concurrency=1',...files.map(n=>`apps/worker/dist/${n}.js`)],{stdio:'inherit'});
process.exitCode=result.status??1;
