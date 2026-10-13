import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {runtime} from './config.mjs';
import {createParseStaging} from '../../apps/worker/dist/parse-staging.js';

const root=join(runtime,'data/parser-diagnostic');
mkdirSync(root,{recursive:true,mode:0o700});
let result;
try{
  const staged=await createParseStaging(root);
  result={platform:process.platform,stage:'createParseStaging',ok:true};
  await staged.cleanup();
}catch(error){result={platform:process.platform,stage:'createParseStaging',ok:false,error:String(error)};}
writeFileSync(join(runtime,'parser-diagnostic.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result,null,2));
if(!result.ok)process.exitCode=1;
