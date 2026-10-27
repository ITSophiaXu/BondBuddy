#!/usr/bin/env node
// SYNTHETIC stand-in for `codex exec --json`. See README.md.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
let prompt = '';
for await (const chunk of process.stdin) prompt += chunk;
const reask = prompt.includes('[bb-reask]');
const pick = (re) => prompt.match(re)?.[1];
// A fixed-prompt caller (the platform probe) selects the scenario with a leading --fake-scenario=<name> argument.
const forced = argv.find(a => a.startsWith('--fake-scenario='))?.slice('--fake-scenario='.length);
const name = forced || (reask && pick(/REASK_SCENARIO:([a-z_0-9]+)/)) || pick(/SCENARIO:([a-z_0-9]+)/) || 'plain';
const sentinel = pick(/SENTINEL:(\S+)/);
const out = (v) => process.stdout.write(JSON.stringify(v) + '\n');
const cwd = process.cwd();
out({ type: 'fake.trace', synthetic: true, argv, cwd_entries: readdirSync(cwd), env_keys: Object.keys(process.env).sort(), codex_home_exists: !!process.env.CODEX_HOME && existsSync(process.env.CODEX_HOME), auth_link: !!process.env.CODEX_HOME && existsSync(join(process.env.CODEX_HOME, 'auth.json')) });
const imageAt=argv.indexOf('--image');
if(imageAt>=0)out({type:'fake.image',sha256:createHash('sha256').update(readFileSync(argv[imageAt+1])).digest('hex')});
const resumeAt = argv.indexOf('resume');
const lines = readFileSync(join(here, `${name}.jsonl`), 'utf8').split('\n').filter(Boolean);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
for (const line of lines) {
  const ev = JSON.parse(line);
  if (ev.fake === 'sleep') { await sleep(ev.ms); continue; }
  if (ev.fake === 'hang') { process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); await new Promise(() => {}); }
  if (ev.fake === 'exit') process.exit(ev.code);
  if (ev.fake === 'raw') { process.stdout.write(ev.text); continue; }
  if (ev.fake === 'stderr') { process.stderr.write(ev.text); continue; }
  if (ev.fake === 'side_effect') { await sleep(300); if (sentinel) writeFileSync(sentinel, 'tool executed'); continue; }
  if (ev.type === 'thread.started' && resumeAt >= 0) ev.thread_id = argv[resumeAt + 1];
  out(ev);
}
