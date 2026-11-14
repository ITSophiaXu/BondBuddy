import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { TEMPLATE_DATABASE } from '../capabilities.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
assert.deepEqual(process.argv.slice(2), ['probe']);
assert.equal(process.platform, 'linux'); assert.equal(process.getuid(), 1000);
assert.equal(process.cwd(), '/app'); assert.equal(process.execPath, '/transfer/native-node');
const source = JSON.parse(readFileSync('/transfer/native-manifest.json', 'utf8'));
for (const [file, expected] of Object.entries(source.files)) assert.equal(hash(join('/app', file)), expected, 'Candidate file changed: ' + file);
const node = { sha256: hash(process.execPath), version: process.version, modules: process.versions.modules, arch: process.arch, platform: process.platform };
assert.deepEqual(node, source.node, 'Cached Node identity or ABI changed');
const security = Object.fromEntries(['CapEff', 'NoNewPrivs', 'Seccomp'].map(key => [key, readFileSync('/proc/self/status', 'utf8').match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))?.[1]]));
assert.equal(security.CapEff, '0000000000000000'); assert.equal(security.NoNewPrivs, '1'); assert.equal(security.Seccomp, '2');
const tools = Object.fromEntries(['pg_dump', 'pg_restore'].map(name => {
  const executable = '/usr/lib/postgresql/16/bin/' + name;
  assert.equal(realpathSync(executable), executable);
  const result = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.error, undefined); assert.equal(result.status, 0, name + ' could not execute');
  const version = result.stdout.trim(); assert.match(version, new RegExp('^' + name + ' \\(PostgreSQL\\) 16\\.'));
  return [name, { executable, sha256: hash(executable), version }];
}));
assert.equal(process.env.BB_TEST_DATABASE_URL, TEMPLATE_DATABASE);
assert.equal(process.env.BB_TEST_AZURITE_CONNECTION_STRING, 'UseDevelopmentStorage=true');
for (const key of ['BB_TEST_LIVE_AUTHORING', 'BB_PLATFORM_PROBE_ENABLED', 'BB_REVIEW_WEB_SEARCH_ENABLED']) assert.equal(process.env[key], '0');
// Import the real API and its native dependency with the copied Node binary.
// No replacement API, native module or database dump implementation is used.
const { createServer } = await import('/app/apps/api/dist/server.js'); assert.equal(typeof createServer, 'function');
const argon2 = (await import('/app/node_modules/argon2/argon2.cjs')).default; assert.equal(typeof argon2.hash, 'function');
const { Pool } = (await import('/app/node_modules/pg/lib/index.js')).default;
const pool = new Pool({ connectionString: TEMPLATE_DATABASE, connectionTimeoutMillis: 5000 });
let database;
try {
  database = (await pool.query("SELECT current_database() AS name,current_user AS username,current_setting('server_version_num')::int AS version,to_regclass('bb_projects')::text AS projects")).rows[0];
  assert.equal(database.name, 'bb_m4_core'); assert.equal(database.username, 'bondbuddy'); assert.equal(database.projects, 'bb_projects');
  assert.ok(database.version >= 160000 && database.version < 170000);
} finally { await pool.end(); }
console.log(JSON.stringify({ status: 'passed', commit: source.commit, tree: source.tree, files: source.files, node, uid: process.getuid(), security, tools, database, models: 0 }));
