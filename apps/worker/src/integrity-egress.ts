// Dedicated credential-free browser egress; does not widen the model provider proxy.
import {INTEGRITY_SITES,INTEGRITY_PROVINCES,resolveIntegritySite} from '@bondbuddy/contracts';
import {integrityProxy} from './integrity-browser-network.js';
const links=INTEGRITY_SITES.flatMap(s=>s.links);
for(const province of INTEGRITY_PROVINCES)for(const city of ['普通地级市','深圳','大连','厦门','宁波','青岛'])for(const id of ['local-csrc','local-tax'])links.push(...resolveIntegritySite(INTEGRITY_SITES.find(s=>s.id===id)!,{province,city}).links);
const proxy=await integrityProxy({id:'official-directory',name:'Official integrity directory',group:'egress',topic:'browser',links},{host:'0.0.0.0',port:3129});
console.log('Integrity egress ready on 3129; public addresses and official directory only');
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void proxy.close().then(()=>process.exit(0));});
