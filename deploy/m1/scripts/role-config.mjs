// Deployment metadata only; private env is data, never executable shell code.
import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, atomicJSON, optionalJSON } from './role-state.mjs';
const fail = () => { throw new Error('invalid role configuration'); };
try {
  const [mode, envPath, state, role] = process.argv.slice(2);
  const values = {};
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    if (!/^(BB_(DEPLOY_ROLE|ROLE_OVERRIDE_FILE|ROLE_OVERRIDE_SHA256|ROLE_STATE_DIR|PARSE_ROLE|UPLOAD_CONFIRMATION_ROLE|UPLOAD_CONFIRMATION_SPOOL_HOST_DIR|DEPLOY_SCRIPT_SHA|INTEGRITY_MODE|MAIN_DATABASE_URL|EXECUTION_DATABASE_URL|PG_FORWARD_PORT)|COMPOSE_.*|BB_(ROLE|MAIN|EXECUTION)_PARSE_.*|BB_ROLE_CONFIRMATION_.*)$/.test(m[1])) continue;
    let v = m[2].trim();
    if (v.startsWith("'") || v.startsWith('"')) {
      const q = v[0], end = v.lastIndexOf(q);
      if (end < 1 || !/^\s*(?:#.*)?$/.test(v.slice(end + 1))) fail();
      v = v.slice(1, end);
    } else v = v.replace(/\s+#.*$/, '').trim();
    values[m[1]] = v;
  }
  const privateState = values.BB_ROLE_STATE_DIR || '';
  if (privateState && (!isAbsolute(privateState) || /[\r\n$`]/.test(privateState))) fail();
  if (mode === 'state') {
    console.log(privateState);
  } else {
  if (values.BB_DEPLOY_ROLE !== role) fail();
  const file = values.BB_ROLE_OVERRIDE_FILE || '', digest = values.BB_ROLE_OVERRIDE_SHA256 || '';
  if (Boolean(file) !== Boolean(digest)) fail();
  if (file && (!isAbsolute(file) || /[\r\n$`]/.test(file) || !/^[a-f0-9]{64}$/.test(digest) || hash(readFileSync(file)) !== digest)) fail();
  if (file && (!privateState || realpathSync(privateState) !== realpathSync(state))) fail();
  const parseRole = values.BB_PARSE_ROLE || (file ? '' : 'execution');
  if (!['main', 'execution'].includes(parseRole)) fail();
  const confirmationRole = values.BB_UPLOAD_CONFIRMATION_ROLE || 'disabled';
  if (!['disabled','execution','size-split'].includes(confirmationRole)) fail();
  if (confirmationRole === 'size-split' && parseRole !== 'main') fail();
  const spoolHost = values.BB_UPLOAD_CONFIRMATION_SPOOL_HOST_DIR || '';
  if (confirmationRole !== 'disabled' && role === 'execution' && (!isAbsolute(spoolHost) || /[\r\n$`]/.test(spoolHost))) fail();
  const project = values.COMPOSE_PROJECT_NAME || `bb-${role}`;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(project)) fail();
  // These names are reserved for the entry point, including values in the private env itself.
  for (const key of Object.keys(values)) if ((key.startsWith('COMPOSE_') && key !== 'COMPOSE_PROJECT_NAME') || (/^BB_(MAIN|EXECUTION|ROLE)_PARSE_/.test(key) || /^BB_ROLE_CONFIRMATION_/.test(key))) fail();
  const binding = { version: 1, role, state: realpathSync(state), env: realpathSync(envPath), project, override: file ? realpathSync(file) : '',
    override_sha256: digest, parse_role: parseRole, integrity: role === 'execution' ? values.BB_INTEGRITY_MODE : '',
    database: hash(values[role === 'main' ? 'BB_MAIN_DATABASE_URL' : 'BB_EXECUTION_DATABASE_URL'] || ''),
    pg_forward_port: values.BB_PG_FORWARD_PORT || '15432',
    ...(confirmationRole === 'disabled' ? {} : {upload_confirmation_role:confirmationRole,
      ...(confirmationRole==='size-split'?{upload_confirmation_lane:role==='main'?'small':'large'}:{}),
      ...(role==='execution'?{upload_confirmation_spool:spoolHost}:{})}) };
  const fixedPort = value => /^[1-9][0-9]{0,4}$/.test(value) && Number(value) <= 65535;
  if (!fixedPort(binding.pg_forward_port)) fail();
  const bindingPath = `${state}/environment-binding.json`;
  const saved = optionalJSON(bindingPath);
  if (saved) {
    const { pg_volume, ...identity } = saved;
    if (JSON.stringify(identity) !== JSON.stringify(binding)) fail();
  }
  if (mode === 'metadata') {
    const script = values.BB_DEPLOY_SCRIPT_SHA || '';
    if (script && !/^[a-f0-9]{40}$/.test(script)) fail();
    console.log([file, digest, parseRole, project, script, values.BB_INTEGRITY_MODE || '', confirmationRole].join('\n'));
  } else if (mode === 'runtime-volume') {
    const expected = (saved?.pg_volume || optionalJSON(`${state}/pg-volume.json`)).name;
    const mounts = JSON.parse(readFileSync(0, 'utf8')).filter(m => m.Destination === '/var/lib/postgresql/data');
    if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== expected) fail();
  } else if (mode === 'validate') {
    const c = JSON.parse(readFileSync(0, 'utf8')), s = c.services;
    if (!c.networks.backend.internal || c.name !== project) fail();
    if (role === 'execution' && (s.postgres || s.migrate || s.api || s.web || s['pg-tunnel'].ports?.length)) fail();
    if (role === 'main') {
      const pg = s.postgres, mount = pg.volumes.find(v => v.target === '/var/lib/postgresql/data');
      if (mount?.type !== 'volume' || mount.source !== 'pgdata' || pg.ports?.length !== 1 || pg.ports[0].host_ip !== '127.0.0.1' || Number(pg.ports[0].target) !== 5432 || !fixedPort(pg.ports[0].published) || pg.ports[0].published !== binding.pg_forward_port) fail();
      // A non-internal PG bridge is dedicated to PG and cannot masquerade traffic out.
      for (const network of Object.keys(pg.networks)) if (!c.networks[network].internal) {
        if (c.networks[network].driver_opts?.['com.docker.network.bridge.enable_ip_masquerade'] !== 'false') fail();
        if (Object.entries(s).some(([name, service]) => name !== 'postgres' && Object.hasOwn(service.networks || {}, network))) fail();
      }
      const volumePath = `${state}/pg-volume.json`, volume = JSON.stringify(c.volumes.pgdata);
      if (existsSync(volumePath) && readFileSync(volumePath, 'utf8') !== volume) fail();
      if (saved?.pg_volume && JSON.stringify(saved.pg_volume) !== volume) fail();
      // Verify the candidate against the actual existing volume BEFORE adopting any binding.
      const ids = execFileSync('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=postgres'], {encoding:'utf8'}).trim().split(/\s+/).filter(Boolean);
      if (ids.length > 1) fail();
      if (ids.length) {
        const mounts = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}', ids[0]], {encoding:'utf8'})).filter(m => m.Destination === '/var/lib/postgresql/data');
        if (mounts.length !== 1 || mounts[0].Type !== 'volume' || mounts[0].Name !== c.volumes.pgdata.name) fail();
      }
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
    // Filtered lanes belong only to the explicit, disjoint size-split placement.
    if (parseRole === role && confirmationRole !== 'size-split' &&
        (parser.environment.BB_UPLOAD_CONFIRMATION_LANE??'general') !== 'general') fail();
    // The only concurrent placement is the exact, disjoint small/large split.
    if (confirmationRole === 'size-split' && role === 'main') {
      const e=parser.environment;
      if(e.BB_UPLOAD_CONFIRMATION_ENABLED!=='1' || e.BB_UPLOAD_CONFIRMATION_LANE!=='small' ||
        e.BB_UPLOAD_CONFIRMATION_SMALL_SLOT!=='0' || e.BB_UPLOAD_SPOOL_MAX_BYTES!=='134217728' ||
        !['10m','10m0s'].includes(parser.stop_grace_period)) fail();
    } else if (confirmationRole !== 'disabled' && parseRole === role &&
        (parser.environment.BB_UPLOAD_CONFIRMATION_ENABLED !== '0' || parser.environment.BB_UPLOAD_CONFIRMATION_SMALL_SLOT !== '0' ||
         (parser.environment.BB_UPLOAD_CONFIRMATION_LANE??'general')!=='general')) fail();
    if (role === 'execution') {
      const service=s['upload-confirmation'], active=confirmationRole!=='disabled', e=service.environment;
      const environmentKeys=new Set(['DATABASE_URL','AZURE_STORAGE_CONNECTION_STRING','BB_UPLOAD_CONFIRMATION_ENABLED','BB_UPLOAD_CONFIRMATION_LANE','BB_UPLOAD_CONFIRMATION_SMALL_SLOT','BB_UPLOAD_CONFIRMATION_CONTAINER','BB_UPLOAD_SPOOL_DIR','BB_UPLOAD_SPOOL_MAX_BYTES','NODE_OPTIONS','HTTPS_PROXY','https_proxy','NO_PROXY','no_proxy']);
      if (Number(service.deploy.replicas)!==(active?1:0) || !service.profiles.includes(active?'bb-confirmation-active':'bb-confirmation-inactive')) fail();
      if (JSON.stringify(service.command)!==JSON.stringify(['node','apps/worker/dist/upload-confirmation-runtime.js']) ||
          e.BB_UPLOAD_CONFIRMATION_ENABLED!=='1' || !['0','1'].includes(e.BB_UPLOAD_CONFIRMATION_SMALL_SLOT) ||
          e.BB_UPLOAD_CONFIRMATION_LANE!==(confirmationRole==='size-split'?'large':'general') ||
          (confirmationRole==='size-split' && e.BB_UPLOAD_CONFIRMATION_SMALL_SLOT!=='0') ||
          e.BB_UPLOAD_SPOOL_DIR!=='/var/lib/bondbuddy/upload-confirmation' || e.BB_UPLOAD_SPOOL_MAX_BYTES!=='134217728' ||
          new URL(e.DATABASE_URL).hostname!=='pg-tunnel' || Object.keys(service.networks).join()!=='backend' ||
          Object.keys(e).some(k=>!environmentKeys.has(k)) || service.user!=='1000:1000' || service.entrypoint?.length || service.privileged ||
          service.volumes.length!==1 || service.volumes[0].target!==e.BB_UPLOAD_SPOOL_DIR || service.volumes[0].type!=='bind' ||
          (active && service.volumes[0].source!==spoolHost) ||
          Number(service.deploy.resources.limits.cpus)!==0.5 || service.deploy.resources.limits.memory!=='536870912' ||
          service.read_only!==true || service.ports?.length || service.env_file?.length) fail();
      if (active) {
        // Compose versions omit different boolean values. An empty bind object
        // alone cannot prove false: compare against a second render with the
        // trusted explicit-false overlay and a distinct true negative control.
        // Both probes are read-only; unknown/collapsed semantics fail closed.
        if (!service.volumes[0].bind || ![false,undefined].includes(service.volumes[0].bind.create_host_path)) fail();
        const expected = JSON.parse(readFileSync(3, 'utf8')).services?.['upload-confirmation']?.volumes;
        const unsafe = JSON.parse(readFileSync(4, 'utf8')).services?.['upload-confirmation']?.volumes;
        if (!Array.isArray(expected) || !Array.isArray(unsafe) ||
            JSON.stringify(expected) === JSON.stringify(unsafe) || JSON.stringify(service.volumes) !== JSON.stringify(expected)) fail();
      }
      for(const name of ['worker','worker-review','worker-parse']) if(s[name].environment.BB_UPLOAD_CONFIRMATION_ENABLED!=='0') fail();
    }
    // Adopt only a fully validated configuration, before the caller can mutate Docker.
    // One atomic authoritative file includes both environment identity and the validated PG.
    if (file && (!saved || role === 'main' && !saved.pg_volume)) atomicJSON(bindingPath, {...binding, ...(role === 'main' ? {pg_volume:c.volumes.pgdata} : {})});
  } else fail();
  }
} catch {
  console.error('role configuration rejected: verify private env, override file/hash, parser placement and persisted environment/volume binding (details withheld)');
  process.exitCode = 2;
}
