import {readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';

/** The caller's Compose wrapper pins this random project and its generated file. */
export async function cleanupReleaseEnvironment({report,keep,out,compose,command}){
 if(report.status!=='passed'||keep){report.cleanup='retained';return;}
 try{
  const config=JSON.parse(readFileSync(join(out,'compose.json'),'utf8'));
  const profiles=[...new Set(Object.values(config.services).flatMap(service=>{
   if(service.profiles===undefined)return [];
   if(!Array.isArray(service.profiles)||service.profiles.some(name=>typeof name!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)))throw Error('Invalid generated Compose profile');
   return service.profiles;
  }))].sort();
  // Compose otherwise excludes stopped profile services and can leave their volumes behind.
  await command(...compose([...profiles.flatMap(name=>['--profile',name]),'down','--volumes']),'cleanup.log');
  for(const name of ['copilot-oauth','copilot-auth.json'])rmSync(join(out,name),{force:true});
  report.cleanup='completed';
 }catch(error){report.status='blocked';report.cleanup='failed';report.error='Business flows passed, but isolated environment cleanup failed: '+error.message;}
}
