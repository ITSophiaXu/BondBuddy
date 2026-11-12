// Synthetic verifier input only. Never runtime, gate or deployment evidence.
import { createHash } from 'node:crypto';
import { browserUploadConfirmationConfig } from './browser-upload-confirmation.mjs';

export function syntheticBrowserUploadConfirmation(plan, { pid = 123, parentPid = 100,
  startedAt = '2026-11-11T13:00:11.000Z', readyAt = '2026-11-11T13:00:11.500Z',
  stopRequestedAt = '2026-11-11T13:00:22.500Z', finishedAt = '2026-11-11T13:00:23.000Z' } = {}) {
  const config = browserUploadConfirmationConfig({ root: '/workspace', plan });
  const files = ['apps/worker/src/upload-confirmation-runtime.ts', 'apps/worker/src/upload-confirmation-spool.ts', 'apps/api/src/upload-confirmation.ts',
    'apps/worker/dist/upload-confirmation-runtime.js', 'apps/worker/dist/upload-confirmation-spool.js', 'apps/api/dist/upload-confirmation.js'];
  const digest = value => createHash('sha256').update('synthetic-only:' + value).digest('hex');
  return { ...config, status: 'stopped', process: { pid, parent_pid: parentPid, start_ticks: '456', platform: 'linux' },
    sources: Object.fromEntries(files.map(path => [path, digest(path)])), consumers: { upload: ['upload.complete_requested'], run: [], parse: [], model: [] },
    entry: 'apps/worker/dist/upload-confirmation-runtime.js#UploadConfirmationRuntime', events: {}, errors: [],
    started_at: startedAt, ready_at: readyAt, stop_requested_at: stopRequestedAt, finished_at: finishedAt,
    spool_identity: { path: config.spool, dev: '1', ino: '2' },
    database_probe: { status: 'passed', database: 'bondbuddy_local', port: 55433, username: 'bondbuddy', version: '160014' },
    storage_probe: { status: 'passed', endpoint: 'http://127.0.0.1:10000/devstoreaccount1/bondbuddy-private', container: config.container },
    cleanup: { status: 'passed', steps: [{ name: 'drain', status: 'passed', finished_at: finishedAt }, { name: 'pool', status: 'passed', closed: true },
      { name: 'spool-release', status: 'passed', lock_released: true, reserved_bytes: 0 }, { name: 'spool-remove', status: 'passed', removed: true, absence_confirmed: true }] },
    process_exit: { code: 0, signal: null, stop_signal: 'SIGTERM' }, log: { path: config.output + '/events.jsonl', bytes: 0, sha256: digest('log') } };
}
