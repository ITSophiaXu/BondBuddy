import {rolldown} from 'rolldown';
import {resolve} from 'node:path';

// Bundle the same registry and network implementation as the container target.
// The output contains no runtime dependencies, credentials, or business services.
const output=process.argv[2];
if(!output)throw Error('Usage: node deploy/beijing/build-egress.mjs OUTPUT.mjs');
const bundle=await rolldown({input:resolve('apps/worker/src/integrity-egress.ts'),platform:'node'});
try{await bundle.write({file:resolve(output),format:'esm',minify:true});}
finally{await bundle.close();}
