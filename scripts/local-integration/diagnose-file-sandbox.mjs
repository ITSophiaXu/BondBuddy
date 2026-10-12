import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {filePermissionArgs} from '/app/apps/worker/dist/codex-file-permissions.js';
const root=await mkdtemp('/var/lib/bondbuddy/parse-staging/bb-sandbox-diagnostic-'),cwd=join(root,'cwd'),home=join(root,'home');
try{
 for(const dir of [cwd,home,join(cwd,'scratch'),join(cwd,'output')])await mkdir(dir,{mode:0o700});
 await writeFile(join(cwd,'input.json'),'{}',{mode:0o400});
 await writeFile(join(home,'permission-canary'),'private',{mode:0o600});
 const code=`import pathlib,socket\nr=pathlib.Path.cwd()\nassert (r/'input.json').read_text()=='{}'\n(r/'scratch/result').write_text('ok')\n(r/'output/result').write_text('ok')\nfor p,m in [('${join(home,'permission-canary')}','r'),('/run/secrets/bb-copilot-oauth','r'),('/proc/1/environ','r'),('/proc/self/environ','r'),('/proc/self/mountinfo','r'),(str(r/'input.json'),'w'),(str(r/'new-input'),'w')]:\n try: open(p,m)\n except OSError: print('denied',p)\n else: raise RuntimeError('file_boundary_failed '+p)\ntry: socket.socket().connect(('127.0.0.1',3000))\nexcept PermissionError: print('network_denied')\nelse: raise RuntimeError('network_boundary_failed')\nprint('PYTHON_OK')`;
 const args=[...filePermissionArgs(cwd),'sandbox','--','/opt/venv/bin/python','-B','-c',code];
 const r=spawnSync('codex',args,{cwd,env:{PATH:'/usr/local/bin:/usr/bin:/bin',HOME:home,CODEX_HOME:home,TMPDIR:join(cwd,'scratch'),LANG:'C.UTF-8'},encoding:'utf8',timeout:30000});
 console.log(JSON.stringify({status:r.status,error:r.error?.message,stdout:r.stdout,stderr:r.stderr}));
 if(r.status!==0)process.exitCode=1;
}finally{await rm(root,{recursive:true,force:true});}
