/** Host deployments bind loopback. Containers opt in to their isolated network explicitly. */
export function integrityEgressListen(env:NodeJS.ProcessEnv=process.env){
 const host=env.BB_INTEGRITY_EGRESS_BIND_HOST??'127.0.0.1';
 if(!['127.0.0.1','0.0.0.0'].includes(host))throw Error('INVALID_INTEGRITY_EGRESS_BIND_HOST');
 return {host,port:3129};
}
