// Bootstrap journal evidence only. Never serialize an exception, argv, output,
// environment or credential; classes below are observations, not root causes.
const stages = new Set(['unclassified','config_read','manifest_read','adapter_verify','adapter_import','adapter_configure',
  'bootstrap_enable','admission','metadata','enrollment','binding','artifact_verification','service_envelope',
  'service_start','service_env','pg_probe_create','pg_probe_start','pg_probe_cleanup','compose_env',
  'compose_up','compose_discover','compose_id','ready_verification','ready_probe','failure_cleanup','admission_release']);
const errnos = new Set(['ENOENT','EACCES','EPERM','ECONNREFUSED','ECONNRESET','ETIMEDOUT',
  'EPIPE','ENOSPC','EIO','ERR_CHILD_PROCESS_STDIO_MAXBUFFER']);
const invariantCodes = new Set(['BOOTSTRAP_VERSION','ENROLLMENT_BINDING','PUBLIC_NODE_SCOPE','ENROLLMENT_UNPROVEN',
  'BOOTSTRAP_ADAPTER_REQUIRED','BOOTSTRAP_ADAPTER_CHANGED','BOOTSTRAP_RATE_LIMITED',
  'NODE_SERVICE_ENV_INVALID','NODE_PG_ENDPOINT_DRIFT','NODE_CONTROLLED_NETWORK_REQUIRED','NODE_PG_PREFLIGHT_ID',
  'NODE_PG_IDENTITY_MISMATCH','NODE_CONTAINER_ID','NODE_SERVICES_INCOMPLETE','NODE_PG_IDENTITY_DRIFT',
  'NODE_PG_READY_STATE_REJECTED','NODE_PG_READY_NOT_PROVEN','NODE_PRIVATE_PG_TRANSPORT_NOT_ACTIVE',
  'NODE_PRIVATE_PG_CREDENTIAL_MODE','NODE_IMAGE_NOT_INSTALLED','NODE_COMPOSE_CHANGED',
  'NODE_SECURITY_PROFILE_DRIFT','NODE_SECURITY_PROFILE_NOT_LOADED','NODE_PRIVATE_PG_ACTIVE_DRIFT',
  'PRIVATE_FILE_PERMISSIONS','PRIVATE_PATH_REQUIRED']);
const signals = new Set(['SIGTERM','SIGKILL','SIGINT','SIGABRT','SIGSEGV','SIGPIPE']);
const statuses = new Set(['created','running','paused','restarting','removing','exited','dead']);
const exitCode = value => Number.isInteger(value) && value >= 0 && value <= 255 ? value : null;
const serviceId = value => ['authoring','review','pg-preflight'].includes(value) ? value : null;

export function bootstrapStderrClass(value) {
  if (typeof value !== 'string' || value.length > 65536) return 'unclassified';
  if (/unable to apply apparmor profile/i.test(value)) return 'apparmor_apply_failed';
  if (/OCI runtime (?:create|start) failed/i.test(value)) return 'oci_start_failed';
  if (/cannot connect to the docker daemon/i.test(value)) return 'daemon_unavailable';
  if (/no such container/i.test(value)) return 'container_not_found';
  if (/no such image/i.test(value)) return 'image_not_found';
  if (/permission denied/i.test(value)) return 'permission_denied';
  return 'unclassified';
}

export function safeBootstrapContainerState(id, service, state) {
  if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/.test(id)) return null;
  return {container_id:id, service:serviceId(service),
    observation:state && typeof state === 'object' ? 'observed' : 'unavailable',
    status:statuses.has(state?.Status) ? state.Status : null,
    running:typeof state?.Running === 'boolean' ? state.Running : null,
    exit_code:exitCode(state?.ExitCode), error_class:bootstrapStderrClass(state?.Error)};
}

export function createBootstrapFailureRecorder({emit = record => process.stderr.write(JSON.stringify(record)+'\n')} = {}) {
  let stage='config_read', service=null, captured=false;
  return {
    stage(value, currentService=null) {
      stage=stages.has(value) ? value : 'unclassified'; service=serviceId(currentService);
    },
    async capture(error, observeContainers) {
      if (captured) return;
      captured=true; // A later cleanup failure must not replace the first failure.
      const at={stage,service};
      try {
        let containers=null;
        try { if(observeContainers) containers=await observeContainers(); } catch { /* unknown, not zero */ }
        const code=errnos.has(error?.code) ? error.code : invariantCodes.has(error?.message) ? error.message : null;
        const record={version:'bootstrap-failure-v1',...at,
          error_class:error instanceof SyntaxError ? 'invalid_json' :
            typeof error?.code==='number' ? 'command_failed' : errnos.has(error?.code) ? 'system_error' :
              invariantCodes.has(error?.message) ? 'invariant_failed' : 'unclassified',
          code, exit_code:exitCode(error?.code), signal:signals.has(error?.signal) ? error.signal : null,
          stderr_class:bootstrapStderrClass(error?.stderr),
          containers_scope:'tracked_and_current_service',
          containers:Array.isArray(containers) ? containers.slice(0,3).map(c=>safeBootstrapContainerState(c?.id,c?.service,c?.state)).filter(Boolean) : null};
        await emit(record);
      } catch { /* Evidence failure cannot alter fail-closed or cleanup behavior. */ }
    },
  };
}
