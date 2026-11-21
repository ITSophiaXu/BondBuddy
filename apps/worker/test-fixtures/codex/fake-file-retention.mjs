// Synthetic process protocol for workspace-retention tests only. Its sandbox
// response is a test substitute; these tests do not attest a security boundary.
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const args = process.argv.slice(2);
if (args.includes('sandbox')) {
  await writeFile(join(process.cwd(), 'scratch', 'permission-result'), 'ok');
  process.stdout.write('BB_FILE_PERMISSIONS_OK\n');
} else {
  const markerIndex = args.indexOf('--synthetic-provider-marker');
  if (markerIndex >= 0) await writeFile(args[markerIndex + 1], 'provider executed');
  let prompt = '';
  for await (const chunk of process.stdin) prompt += chunk;
  const cwd = args[args.indexOf('--cd') + 1];
  await writeFile(join(cwd, 'output', 'operations.json'), '{"saved":"synthetic substantive work"}');
  process.stdout.write(JSON.stringify({ type: 'item.started', item: { type: 'command_execution', id: 'synthetic-saved-work' } }) + '\n');
  if (prompt === 'completed') {
    process.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }) + '\n');
    process.exit(0);
  }
  if (prompt === 'native-nonzero') process.exit(7);
  if (prompt === 'stream-broken') process.exit(0);
  if (prompt === 'payload-failure') process.stdout.write(JSON.stringify({ type: 'error', error: { status: 413, message: 'synthetic provider rejection' } }) + '\n');
  setInterval(() => {}, 1000);
}
