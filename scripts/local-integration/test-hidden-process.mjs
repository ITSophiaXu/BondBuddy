import assert from 'node:assert/strict';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {repo,runtime} from './config.mjs';
import {windowsProcess,consoleState,terminate,identity,sameIdentity} from './processes.mjs';

mkdirSync(join(runtime,'launch'),{recursive:true});
const launchId=randomUUID();
const ref=windowsProcess({action:'launch',exe:process.execPath,args:['-e','setTimeout(()=>{},60000)'],cwd:repo,
  stdout:join(runtime,'hidden-probe.stdout.log'),stderr:join(runtime,'hidden-probe.stderr.log'),
  receipt:join(runtime,'launch',launchId+'.json'),launchId});
try{
  const snapshot=consoleState(ref);
  assert.equal(snapshot.windows.filter(w=>w.visible).length,0);
  assert.equal(snapshot.processes.filter(p=>p.name.toLowerCase()==='conhost.exe').length,1);
  assert.equal(sameIdentity(identity(ref.pid),{...ref,createdTicks:'0'}),false);
  assert.throws(()=>terminate({...ref,createdTicks:'0'}),/different process generation/);
  assert.ok(sameIdentity(identity(ref.pid),ref),'A rejected identity must leave the real process alive');
  console.log(JSON.stringify({hiddenConsoleProbe:'passed',snapshot},null,2));
}finally{terminate(ref);}
