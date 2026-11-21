// Test-only protected runtime argv for the real host broker.
export * from './runtime-impl.js';
console.log(JSON.stringify({boot:true}));
import('./workflow-authoring.pg.test.js').catch(error=>{console.error(error);process.exitCode=1;});
