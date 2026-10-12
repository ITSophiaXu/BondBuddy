import {startServices} from './lifecycle.mjs';
try {
  const state=await startServices({databaseOnly:process.argv.includes('--database-only')});
  console.log(JSON.stringify({phase:state.phase,baseURL:state.baseURL,ready:state.ready,modelReady:false}));
} catch(error) {console.error(error);process.exitCode=1;}
