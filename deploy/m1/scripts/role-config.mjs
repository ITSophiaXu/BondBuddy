// Deployment metadata only; private env is data, never executable shell code.
import { readFileSync, realpathSync, existsSync, writeFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
const hash = value => createHash('sha256').update(value).digest('hex');
const fail = () => { throw new Error('invalid role configuration'); };
try {
  const [mode, envPath, state, role] = process.argv.slice(2);
  const values = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!/^(BB_(DEPLOY_ROLE|ROLE_OVERRIDE_FILE|ROLE_OVERRIDE_SHA256|PARSE_ROLE|DEPLOY_SCRIPT_SHA|INTEGRITY_MODE|MAIN_DATABASE_URL|EXECUTION_DATABASE_URL|PG_FORWARD_PORT)|COMPOSE_.*|BB_(ROLE|MAIN|EXECUTION)_PARSE_.*)$/.test(m[1])) continue;
    let v = m[2].trim();
    if (v.startsWith("'") || v.startsWith('"')) {
      const q = v[0], end = v.lastIndexOf(q);
      if (end < 1 || !/^\s*(?:#.*)?$/.test(v.slice(end + 1))) fail();
      v = v.slice(1, end);
    } else v = v.replace(/\s+#.*$/, '').trim();
    values[m[1]] = v;
  }
  if (values.BB_DEPLOY_ROLE !== role) fail();
  const file = values.BB_ROLE_OVERRIDE_FILE || '', digest = values.BB_ROLE_OVERRIDE_SHA256 || '';
  if (Boolean(file) !== Boolean(digest)) fail();
  if (file && (!isAbsolute(file) || /[\r\n$`]/.test(file) || !/^[a-f0-9]{64}$/.test(digest) || hash(readFileSync(file)) !== digest)) fail();
  const parseRole = values.BB_PARSE_ROLE || (file ? '' : 'execution');
  if (!['main', 'execution'].includes(parseRole)) fail();
  const project = values.COMPOSE_PROJECT_NAME || `bb-${role}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail();
  // These names are reserved for the entry point, including values in the private env itself.
  for (const key of Object.keys(values)) if ((key.startsWith('COMPOSE_') && key !== 'COMPOSE_PROJECT_NAME') || /^BB_(MAIN|EXECUTION|ROLE)_PARSE_/.test(key)) fail();
  const binding = { version: 1, role, env: realpathSync(envPath), project, override: file ? realpathSync(file) : '',
    override_sha256: digest, parse_role: parseRole, integrity: role === 'execution' ? values.BB_INTEGRITY_MODE : '',
    database: hash(values[role === 'main' ? 'BB_MAIN_DATABASE_URL' : 'BB_EXECUTION_DATABASE_URL'] || ''),
    pg_forward_port: values.BB_PG_FORWARD_PORT || '15432' };
  const bindingPath = `${state}/environment-binding.json`;
  if (existsSync(bindingPath) && JSON.stringify(JSON.parse(readFileSync(bindingPath))) !== JSON.stringify(binding)) fail();
  if (mode === 'metadata') {
    const script = values.BB_DEPLOY_SCRIPT_SHA || '';
    if (script && !/^[a-f0-9]{40}$/.test(script)) fail();
    console.log([file, digest, parseRole, project, script, values.BB_INTEGRITY_MODE || ''].join('\n'));
  } else if (mode === 'validate') {
    const c = JSON.parse(readFileSync(0, 'utf8')), s = c.services;
    if (!c.networks.backend.internal || c.name !== project) fail();
    if (role === 'execution' && (s.postgres || s.migrate || s.api || s.web || s['pg-tunnel'].ports?.length)) fail();
    if (role === 'main') {
      const pg = s.postgres, mount = pg.volumes.find(v => v.target === '/var/lib/postgresql/data');
      if (mount?.type !== 'volume' || mount.source !== 'pgdata' || pg.ports?.length !== 1 || pg.ports[0].host_ip !== '127.0.0.1' || Number(pg.ports[0].target) !== 5432) fail();
      // A non-internal PG bridge is dedicated to PG and cannot masquerade traffic out.
      for (const network of Object.keys(pg.networks)) if (!c.networks[network].internal) {
        if (c.networks[network].driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') fail();
        if (Object.entries(s).some(([name, service]) => name !== 'postgres' && Object.hasOwn(service.networks || {}, network))) fail();
      }
      const volumePath = `${state}/pg-volume.json`, volume = JSON.stringify(c.volumes.pgdata);
      if (existsSync(volumePath) && readFileSync(volumePath, 'utf8') !== volume) fail();
      for (const name of ['api', 'ops', 'migrate']) if (new URL(s[name].environment.DATABASE_URL).hostname !== 'postgres') fail();
    }
    const parser = s['worker-parse'];
    if (parseRole !== role) {
      if (Number(parser.deploy.replicas) !== 0 || !parser.profiles.includes('bb-parse-inactive')) fail();
    } else {
      const e = parser.environment;
      if (Number(parser.deploy.replicas) !== 1 || !parser.profiles.includes('bb-parse-active') || e.BB_WORKER_JOB_KINDS !== 'parse' || e.BB_WORKER_CONCURRENCY !== '1') fail();
      if (role === 'main') {
        if (e.BB_WORKER_LEASE_SECONDS !== '120' || Number(parser.deploy.resources.limits.cpus) !== 0.5 || parser.deploy.resources.limits.memory !== '1073741824') fail();
        if (new URL(e.DATABASE_URL).hostname !== 'postgres' || Object.keys(parser.networks).join() !== 'backend') fail();
        if (Object.keys(e).some(k => /CODEX|COPILOT|DEEPSEEK/.test(k)) || parser.volumes.some(v => /secrets|oauth|codex/i.test(v.target))) fail();
      }
    }
    // Adopt only a fully validated configuration, before the caller can mutate Docker.
    if (file && !existsSync(bindingPath)) writeFileSync(bindingPath, JSON.stringify(binding), { mode: 0o600, flag: 'wx' });
    if (file && role === 'main' && !existsSync(`${state}/pg-volume.json`)) writeFileSync(`${state}/pg-volume.json`, JSON.stringify(c.volumes.pgdata), {mode: 0o600, flag: 'wx'});
  } else fail();
} catch {
  console.error('role configuration rejected: verify private env, override file/hash, parser placement and persisted environment/volume binding (details withheld)');
  process.exitCode = 2;
}
