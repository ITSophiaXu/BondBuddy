import { Pool } from 'pg';
import { azureBlobs } from '../apps/api/dist/data.js';
import { runUploadConfirmationOnce } from '../apps/api/dist/upload-confirmation.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
if (!process.env.DATABASE_URL || !process.env.AZURE_STORAGE_CONNECTION_STRING) {
  process.stderr.write('DATABASE_URL and AZURE_STORAGE_CONNECTION_STRING are required for upload confirmation\n');
  process.exit(1);
}

const pool = new Pool({ connectionString: process.env.DATABASE_URL, options: '-c jit=off' });
const blobs = azureBlobs(process.env.AZURE_STORAGE_CONNECTION_STRING);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await pool.end();
  process.exit(0);
}
process.on('SIGTERM', () => { void stop(); });
process.on('SIGINT', () => { void stop(); });

process.stdout.write('upload confirmation consumer started\n');
while (!stopping) {
  try {
    const outcome = await runUploadConfirmationOnce(pool, blobs);
    if (outcome !== 'idle') process.stdout.write(`${new Date().toISOString()} upload_confirmation ${outcome}\n`);
    if (outcome === 'idle' || outcome === 'error') await sleep(500);
  } catch (error) {
    process.stderr.write(`${new Date().toISOString()} upload_confirmation_error ${error instanceof Error ? error.message : String(error)}\n`);
    await sleep(1000);
  }
}
