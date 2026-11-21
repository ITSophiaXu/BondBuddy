// The protected entry runs exactly one case in a fresh real broker session.
export * from './runtime-impl.js';
process.stdout.write(JSON.stringify({boot:true})+'\n');
import('./candidate-retention-runtime.pg.test.js').catch(()=>{process.exitCode=1;});
