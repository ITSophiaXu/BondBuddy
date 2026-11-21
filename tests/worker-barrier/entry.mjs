// Test-only protected entrypoint; the real runtime remains runtime-impl.js.
export * from './runtime-impl.js';
console.log(JSON.stringify({ boot: true }));
import('./barrier-matrix.test.mjs').catch(error => {
  console.error(error);
  process.exitCode = 1;
});
