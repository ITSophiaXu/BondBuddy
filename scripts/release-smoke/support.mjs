import {createHash} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve,dirname} from 'node:path';

export const SAMPLE_REF='6480f7c1bda41e3d49dc757e1b305de21de4edfa';
export const CASES=['update-rq-202509','review-dongying','qa-dongying'];
export const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
export function writeJson(path,value){mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});}
export function contained(root,relative){const p=resolve(root,relative);if(!p.startsWith(resolve(root)+'/'))throw Error('Sample path escapes its root');return p;}
export function verifiedFile(root,relative,hash){const path=contained(root,relative),bytes=readFileSync(path);if(!/^[a-f0-9]{64}$/.test(hash)||sha256(bytes)!==hash)throw Error('Sample hash mismatch: '+relative);return path;}
export function verdict(results){return CASES.every(id=>results.find(r=>r.id===id)?.status==='passed')?'passed':'blocked';}
export function assertLocalContext(inspect){
 const host=inspect?.Endpoints?.docker?.Host;
 if(typeof host!=='string'||!host.startsWith('unix:///'))throw Error('Release smoke requires a local Docker Unix socket; remote engines are refused');
}
export function assertTestReport(report){
 if(report.baseURL!=='http://localhost:5288'||!/^bb-release-[a-f0-9]{10}$/.test(report.project??'')||!(/^[a-f0-9]{40}$/).test(report.sha??'')||report.sampleRef!==SAMPLE_REF)throw Error('Not a recognized local release test report');
 if(report.modelProbe!=='passed')throw Error('Setup is incomplete; start a fresh test instead of resuming business tasks');
 if(!Array.isArray(report.cases)||report.cases.length!==CASES.length||CASES.some(id=>report.cases.filter(c=>c.id===id).length!==1))throw Error('Required test cases are missing or duplicated');
 for(const name of ['api','worker','web'])if(!/^sha256:[a-f0-9]{64}$/.test(report.images?.[name]?.id??''))throw Error('Test image identity missing');
}
