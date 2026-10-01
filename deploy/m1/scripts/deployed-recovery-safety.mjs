// Small, side-effect-free checks shared by the deployed drill and its focused tests.
export function assertServiceIdentity(service, actualId, expectedId, container, expectedSha) {
  if (actualId !== expectedId) throw new Error(`${service} ID does not match the specified running service`);
  if (container.State.Status !== 'running' || container.State.Paused) throw new Error(`${service} is not ready`);
  if (['api', 'web', 'postgres'].includes(service) && container.State.Health?.Status !== 'healthy')
    throw new Error(`${service} healthcheck is not healthy`);
  if (container.Config.Labels?.['com.docker.compose.service'] !== service) throw new Error(`${service} Compose label mismatch`);
  if (service === 'postgres') {
    if (!container.Config.Image.startsWith('postgres:16')) throw new Error('PostgreSQL is not version 16');
    return;
  }
  const image = `bondbuddy-m1-${service === 'ops' ? 'worker' : service}:${expectedSha.slice(0, 12)}`;
  if (container.Config.Image !== image || (service !== 'web' && !container.Config.Env.includes(`BB_RELEASE_SHA=${expectedSha}`)))
    throw new Error(`${service} image commit mismatch`);
}

export function assertHealthIdentity(direct, proxied) {
  const expected = { status: 'ok', service: 'bondbuddy-m1-api-skeleton', implementation: 'health-and-contract-only' };
  for (const [name, response] of [['direct API', direct], ['Web /healthz', proxied]]) {
    if (response.status !== 200 || !/^application\/json(?:;|$)/i.test(response.contentType ?? ''))
      throw new Error(`${name} health status or content type mismatch`);
    let body;
    try { body = JSON.parse(response.body); } catch { throw new Error(`${name} health is not JSON`); }
    if (JSON.stringify(body) !== JSON.stringify(expected)) throw new Error(`${name} health body mismatch`);
  }
  if (direct.body !== proxied.body) throw new Error('Web /healthz differs from specified API');
}

export function assertProxyTarget(actualConfigHash, expectedConfigHash, resolvedApiIp, sharedApiIps) {
  if (actualConfigHash !== expectedConfigHash) throw new Error('Web API proxy configuration mismatch');
  if (!sharedApiIps.includes(resolvedApiIp)) throw new Error('Web api DNS does not resolve to specified API container');
}

export function assertWebPort(base, portBindings) {
  const url = new URL(base);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash ||
      !portBindings?.some(binding => binding.HostIp === '127.0.0.1' && binding.HostPort === url.port))
    throw new Error('Base URL does not address the specified Web container port');
}

export async function closeSyntheticAccount(state, dependencies) {
  const { rows, qid, uuid, save, login, request, record, short } = dependencies;
  try {
    if (!state.user_id && /^[a-z][a-z0-9_]{2,31}$/.test(state.username)) {
      const found = rows(`SELECT id FROM bb_users WHERE username='${state.username}'`);
      if (found[0]) { state.user_id = uuid(found[0][0]); save(state); }
    }
    if (!state.user_id) { record('cleanup', { status: 'no_account_created' }); return true; }
    const account = rows(`SELECT username,status FROM bb_users WHERE id=${qid(state.user_id)}`)[0];
    if (!account || account[0] !== state.username) throw new Error('Saved account identity mismatch');
    if (account[1] === 'closed') {
      record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'already_closed' });
      return true;
    }
    if (!state.project_id) {
      const found = rows(`SELECT id FROM bb_projects WHERE owner_user_id=${qid(state.user_id)} AND name='SYNTHETIC recovery drill' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT 1`);
      if (found[0]) { state.project_id = uuid(found[0][0]); save(state); }
    }
    await login(state);
    if (state.project_id) {
      const project = rows(`SELECT owner_user_id,name,deleted_at IS NULL FROM bb_projects WHERE id=${qid(state.project_id)}`)[0];
      if (project && (project[0] !== state.user_id || project[1] !== 'SYNTHETIC recovery drill')) throw new Error('Saved project identity mismatch');
      if (project?.[2] === 't') await request('DELETE', `/api/v1/projects/${uuid(state.project_id)}`);
    }
    await request('POST', '/api/v1/account/closure', { password: state.password, confirm_username: state.username });
    const closed = rows(`SELECT status FROM bb_users WHERE id=${qid(state.user_id)}`)[0]?.[0];
    if (closed !== 'closed') throw new Error('Account closure not confirmed');
    record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'closed' });
    return true;
  } catch (error) {
    record('cleanup', { user_id: state.user_id, project_id: state.project_id, status: 'manual_recovery_required', reason: short(error) });
    return false;
  }
}
