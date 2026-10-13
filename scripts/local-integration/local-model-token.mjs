#!/usr/local/bin/node
// Local-only: the user's existing GH CLI credential already authenticates directly
// to their configured Copilot Enterprise endpoint. Never use this in production.
import {readFile} from 'node:fs/promises';
try {
  if(process.env.BB_COPILOT_OAUTH_FILE!=='/run/secrets/bb-copilot-oauth')throw Error();
  const token=(await readFile('/run/secrets/bb-copilot-oauth','utf8')).trim();
  if(!token||/\s/.test(token))throw Error();
  process.stdout.write(token);
}catch{process.stderr.write('Local model credential unavailable\n');process.exitCode=1;}
