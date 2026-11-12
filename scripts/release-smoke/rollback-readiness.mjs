#!/usr/bin/env node
/** Read-only preflight. Missing legacy evidence blocks a version change; this
 * never invents historical quality approval or an exception to the release gate.
 */
import {execFileSync} from 'node:child_process';
import {existsSync,readFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {verifyRollbackReceipt} from '../prospectus-quality-gate.mjs';
import {verifyRollbackReport} from './verify.mjs';
import {candidateIdentity,verifyInstalledImages,targetsFor} from './verify-images.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
export function verifyRollbackReadiness({candidate,current,scope,qualityRaw,smokeRaw,releasesLog,previousExpected,docker,now=Date.now()}){
 targetsFor(scope);if(!/^[a-f0-9]{40}$/.test(candidate))throw Error('Candidate commit must be exact');
 if(!current)return {status:'first_deployment',previous:null};
 if(!/^[a-f0-9]{12}$/.test(current)||!/^[a-f0-9]{40}$/.test(candidate))throw Error('Current deployment must identify an exact trusted commit');
 if(current===candidate.slice(0,12))return {status:'same_candidate',previous:candidate};
 if(!previousExpected||previousExpected.commit.slice(0,12)!==current||!qualityRaw||!smokeRaw||!releasesLog)throw Error('Existing version has no verifiable rollback evidence; retain the old deployment and obtain an explicit transition decision');
 const role=scope==='all'?undefined:scope;
 verifyRollbackReceipt(qualityRaw,previousExpected,releasesLog,now,role);
 const report=verifyRollbackReport(smokeRaw,previousExpected,releasesLog,now,role);
 const images=verifyInstalledImages(report,previousExpected,scope,{docker});
 return {status:'verified',previous:previousExpected.commit,images,scope,compatibility:'database backups and migration compatibility remain separate required checks'};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [ref,state,scope='all']=process.argv.slice(2);if(!ref||!state)throw Error('Usage: rollback-readiness.mjs <candidate> <state> [all|main|execution]');
  const git=args=>execFileSync('git',args,{cwd:root,windowsHide:true}),candidate=git(['rev-parse','--verify',`${ref}^{commit}`]).toString().trim();
  const currentPath=join(state,'current'),current=existsSync(currentPath)?readFileSync(currentPath,'utf8').trim():'';
  let previousExpected,qualityRaw,smokeRaw,releasesLog;
  if(current&&current!==candidate.slice(0,12)){
   previousExpected=candidateIdentity(current,git);
   const quality=join(state,'quality',previousExpected.commit+'.json'),smoke=join(state,'release-smoke',previousExpected.commit+'.json'),log=join(state,'releases.log');
   if(existsSync(quality))qualityRaw=readFileSync(quality,'utf8');if(existsSync(smoke))smokeRaw=readFileSync(smoke,'utf8');if(existsSync(log))releasesLog=readFileSync(log,'utf8');
  }
  const docker=args=>execFileSync('docker',args,{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe']});
  process.stdout.write(JSON.stringify(verifyRollbackReadiness({candidate,current,scope,qualityRaw,smokeRaw,releasesLog,previousExpected,docker}))+'\n');
 }catch(error){console.error('Rollback readiness blocked: '+error.message+'; no legacy quality receipt or rollback waiver was created');process.exitCode=1;}
}
