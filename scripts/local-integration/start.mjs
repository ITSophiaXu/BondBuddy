import {startServices} from './lifecycle.mjs';
try {
  const state=await startServices({databaseOnly:process.argv.includes('--database-only'),dependenciesOnly:process.argv.includes('--dependencies-only')});
  console.log(JSON.stringify({phase:state.phase,baseURL:state.baseURL,ready:state.ready,modelReady:state.modelReady}));
} catch(error) {console.error(error);process.exitCode=1;}
