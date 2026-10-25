// Dedicated credential-free browser egress; does not widen the model provider proxy.
import {INTEGRITY_SITES,INTEGRITY_PROVINCES,resolveIntegritySite} from '@bondbuddy/contracts';
import {integrityProxy} from './integrity-browser-network.js';
import {integrityEgressListen} from './integrity-egress-config.js';
const links=INTEGRITY_SITES.flatMap(s=>s.links);
for(const province of INTEGRITY_PROVINCES)for(const city of ['普通地级市','深圳','大连','厦门','宁波','青岛'])for(const id of ['local-csrc','local-tax'])links.push(...resolveIntegritySite(INTEGRITY_SITES.find(s=>s.id===id)!,{province,city}).links);
const listen=integrityEgressListen();
const proxy=await integrityProxy({id:'official-directory',name:'Official integrity directory',group:'egress',topic:'browser',links},listen);
console.log(`Integrity egress ready on ${listen.host}:${listen.port}; public addresses and official directory only`);
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>{void proxy.close().then(()=>process.exit(0));});
