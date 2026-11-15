import {X509Certificate, createPrivateKey, createPublicKey, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, lstat, open, rename, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {requireThat, sha256} from './policy.mjs';

/** Install freshly issued credentials, never personal authentication or image data.
 * The production caller supplies a root-owned directory under /etc/bondbuddy,
 * which the contained model's named permission policy explicitly denies. */
export function validateTransportCredentials(credentials,expected,{now=Date.now}={}) {
  requireThat(credentials?.version==='execution-pg-mtls-v1', 'PG_ISSUANCE_REQUIRED');
  requireThat(['ca_pem','cert_pem','key_pem'].every(k=>typeof credentials[k]==='string' && Buffer.byteLength(credentials[k])<=16384), 'PG_CREDENTIAL_BOUND');
  requireThat(credentials.instance_id===expected.instance_id && credentials.epoch===expected.epoch &&
    credentials.account_id===expected.account_id && credentials.region===expected.region, 'PG_CREDENTIAL_IDENTITY');
  requireThat(sha256(credentials.ca_pem)===expected.ca_sha256, 'PG_CA_PIN');
  let ca,cert,key;
  try {ca=new X509Certificate(credentials.ca_pem);cert=new X509Certificate(credentials.cert_pem);key=createPrivateKey(credentials.key_pem);} catch {throw Error('PG_CREDENTIAL_INVALID');}
  requireThat(ca.ca && Date.parse(ca.validFrom)<=now() && Date.parse(ca.validTo)>now()+60000 &&
    cert.keyUsage?.includes('1.3.6.1.5.5.7.3.2') && cert.verify(ca.publicKey) && cert.subject===`CN=${expected.instance_id}:${expected.epoch}` &&
    cert.checkPrivateKey(key) && Date.parse(cert.validFrom)<=now() && Date.parse(cert.validTo)>now()+60000 &&
    Date.parse(cert.validTo)<=now()+86400000, 'PG_CERTIFICATE_BINDING');
  // Assert the public key again before any filesystem or service mutation.
  requireThat(createPublicKey(key).export({type:'spki',format:'der'}).equals(cert.publicKey.export({type:'spki',format:'der'})), 'PG_KEY_BINDING');
}

export async function installPrivateTransport(directory, credentials, expected, {now=Date.now, uid=process.getuid()}={}) {
  requireThat(directory.startsWith('/'),'PG_PRIVATE_DIRECTORY');
  validateTransportCredentials(credentials,expected,{now});
  await mkdir(directory,{recursive:true,mode:0o700});
  const dir=await lstat(directory);
  requireThat(dir.isDirectory()&&!dir.isSymbolicLink()&&dir.uid===uid&&(dir.mode&0o777)===0o700,'PG_PRIVATE_DIRECTORY');
  for(const [name,value] of [['ca.pem',credentials.ca_pem],['client.pem',credentials.cert_pem],['client.key',credentials.key_pem]]) {
    const target=join(directory,name),tmp=join(directory,`.${name}-${randomUUID()}`);
    try {const s=await lstat(target);requireThat(s.isFile()&&!s.isSymbolicLink()&&s.uid===uid&&(s.mode&0o777)===0o600,'PG_PRIVATE_FILE');} catch(e){if(e.code!=='ENOENT')throw e;}
    let f;
    try {f=await open(tmp,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);await f.writeFile(value);await f.sync();await f.close();f=null;await rename(tmp,target);}
    finally {if(f)await f.close();await unlink(tmp).catch(e=>{if(e.code!=='ENOENT')throw e;});}
  }
  return {ca_file:join(directory,'ca.pem'),cert_file:join(directory,'client.pem'),key_file:join(directory,'client.key')};
}

/** Create only the reviewed network. Existing networks must match the complete
 * controlled preimage; no silent reuse of the default bridge. */
export async function ensurePrivateExecutionNetwork(config,runDocker) {
  requireThat(/^[A-Za-z0-9_-]{1,64}$/.test(config.execution_network) && config.execution_network_subnet==='172.28.61.0/24' &&
    config.private_pg.local_host==='172.28.61.1','NODE_NETWORK_CONFIG');
  let raw;
  try {raw=await runDocker(['network','inspect',config.execution_network]);} catch(error) {
    // Inspect failure is not proof of absence. The normal successful inventory
    // must explicitly show the name absent before creating it.
    const names=(await runDocker(['network','ls','--format','{{.Name}}'])).split('\n');
    requireThat(!names.includes(config.execution_network),'NODE_NETWORK_OBSERVATION_UNKNOWN');
    await runDocker(['network','create','--driver','bridge','--internal','--subnet',config.execution_network_subnet,
      '--gateway',config.private_pg.local_host,'--label','bondbuddy.execution.network=v1',config.execution_network]);
    raw=await runDocker(['network','inspect',config.execution_network]);
  }
  const rows=JSON.parse(raw),n=rows[0];
  requireThat(rows.length===1&&n.Name===config.execution_network&&n.Driver==='bridge'&&n.Internal===true&&
    n.Labels?.['bondbuddy.execution.network']==='v1'&&n.IPAM?.Config?.length===1&&
    n.IPAM.Config[0].Subnet===config.execution_network_subnet&&n.IPAM.Config[0].Gateway===config.private_pg.local_host,'NODE_NETWORK_DRIFT');
}
