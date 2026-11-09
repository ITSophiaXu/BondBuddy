// A hidden Windows wsl.exe client keeps the local distro and loopback forwarding alive.
import {mkdirSync,writeFileSync} from 'node:fs';
import {stateDir} from './config.mjs';
const hostId=process.argv[2];
if(!/^[-a-f0-9]{36}$/.test(hostId??''))throw Error('Local host keeper identity required');
mkdirSync(stateDir,{recursive:true,mode:0o700});
const heartbeat=()=>writeFileSync(stateDir+'/host-keeper-live.json',JSON.stringify({hostId,linuxPid:process.pid,heartbeatAt:new Date().toISOString()})+'\n',{mode:0o600});
heartbeat();
const timer=setInterval(heartbeat,5000);
const stop=()=>{clearInterval(timer);process.exit(0);};
process.once('SIGTERM',stop);process.once('SIGINT',stop);
