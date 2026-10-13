import {stopServices} from './lifecycle.mjs';
try {
  await stopServices();
  console.log('Local integration services stopped; all data retained.');
} catch(error) {console.error(error);process.exitCode=1;}
