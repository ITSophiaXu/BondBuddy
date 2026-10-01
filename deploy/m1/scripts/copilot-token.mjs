#!/usr/local/bin/node
// Codex auth.command: stdout is exclusively the short-lived bearer token.
// The OAuth source is a read-only file mounted only into the model worker.
import { readFile } from 'node:fs/promises';

async function main() {
  const path = process.env.BB_COPILOT_OAUTH_FILE;
  if (path !== '/run/secrets/bb-copilot-oauth') throw new Error('credential source unavailable');
  const oauth = (await readFile(path, 'utf8')).trim();
  if (!oauth || /\s/.test(oauth)) throw new Error('credential source invalid');
  const response = await fetch('https://api.github.com/copilot_internal/v2/token', {
    headers: { Authorization: `Bearer ${oauth}`, Accept: 'application/json', 'X-GitHub-Api-Version': '2025-04-01' },
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(`credential exchange HTTP ${response.status}`);
  const body = await response.json();
  if (typeof body?.token !== 'string' || !body.token || /\s/.test(body.token)) throw new Error('credential exchange invalid');
  process.stdout.write(body.token);
}

main().catch(() => { process.stderr.write('credential exchange failed\n'); process.exitCode = 1; });
