// Same protected entrypoint/UID in a disposable container, with synthetic DB only.
export * from './runtime-impl.js';
console.log(JSON.stringify({boot:true}));
import('./managed-run-recovery.pg.test.js').catch(error=>{
 console.error(error);
 process.exitCode=1;
});
