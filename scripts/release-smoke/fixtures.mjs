import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {SAMPLE_REF,sha256,verifiedFile} from './support.mjs';

export function loadFixedFixtures({repo,samples,env,readGit=path=>execFileSync('git',['cat-file','blob',SAMPLE_REF+':'+path],{cwd:repo,env,maxBuffer:4*1024*1024})}){
 const oldRel='tests/samples/2026-09-25',recentRel='tests/samples/2026-11-05',old=join(samples,oldRel),recent=join(samples,recentRel);
 const lockedJson=relative=>{const bytes=readGit(relative);verifiedFile(samples,relative,sha256(bytes));return {body:JSON.parse(bytes.toString('utf8')),sha256:sha256(bytes)};};
 const oldManifest=lockedJson(oldRel+'/manifest.json'),newManifest=lockedJson(recentRel+'/manifest.json');
 const rq=oldManifest.body.cases.find(c=>c.case_id==='rq-202509');if(!rq)throw Error('Fixed RQ sample missing');const assets=newManifest.body.assets;
 const ids=['nov05-f009','nov05-f012','nov05-f013','nov05-f014','nov05-f015','nov05-f016'];
 const asset=id=>{const matches=assets.filter(a=>a.file_id===id);if(matches.length!==1)throw Error('Missing or duplicated fixed fixture '+id);const a=matches[0];return verifiedFile(recent,a.path,a.sha256);};
 const integrity=lockedJson(recentRel+'/cases/integrity-dongying/input.json'),workpaper=lockedJson(recentRel+'/cases/workpaper-dongying/input.json');
 const fixtures={rq:rq.files.map(f=>({path:verifiedFile(old,f.path,f.sha256),role:f.upload_role})),dongying:asset('nov05-f012'),financial:['nov05-f014','nov05-f015','nov05-f016'].map(asset),questions:asset('nov05-f013'),workpaperCatalogue:asset('nov05-f009'),integrityRecipe:integrity.body,workpaperRecipe:workpaper.body};
 const fixtureHashes=[...rq.files,...assets.filter(a=>ids.includes(a.file_id))].map(a=>({id:a.file_id??a.path,sha256:a.sha256}));
 fixtureHashes.push({id:oldRel+'/manifest.json',sha256:oldManifest.sha256},{id:recentRel+'/manifest.json',sha256:newManifest.sha256},{id:'integrity-dongying/input.json',sha256:integrity.sha256},{id:'workpaper-dongying/input.json',sha256:workpaper.sha256});
 return {fixtures,fixtureHashes};
}
export function assertFixtureBindings(privateData,report,locked){
 if(!isDeepStrictEqual(privateData.fixtures,locked.fixtures)||!isDeepStrictEqual(report.fixtureHashes,locked.fixtureHashes))throw Error('Original fixture bytes, recipe, manifest or paths changed; resume refused');
 return privateData;
}
