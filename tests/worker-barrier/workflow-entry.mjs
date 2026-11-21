// Test-only protected runtime argv for the real host broker.
export * from './runtime-impl.js';
process.stdout.write(JSON.stringify({boot:true})+'\n');
import('./workflow-authoring.pg.test.js').catch(error=>{console.error(error);process.exitCode=1;});
