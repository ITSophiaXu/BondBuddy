import {X509Certificate,createPrivateKey} from 'node:crypto';
import {constants} from 'node:fs';
import {open,mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {sha256,requireThat} from './policy.mjs';
import {validateTransportCredentials} from './private-transport.mjs';
const exec=promisify(execFile);
async function privatePem(path) {
  requireThat(path?.startsWith('/'),'PG_ISSUER_PRIVATE_PATH');
  const f=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try {const s=await f.stat();requireThat(s.isFile()&&s.uid===process.getuid()&&(s.mode&0o777)===0o600&&s.size<=16384,'PG_ISSUER_PRIVATE_MODE');return await f.readFile('utf8');}
  finally{await f.close();}
}
export async function validateTransportIssuer(config,{now=Date.now}={}) {
  requireThat(config?.ca_file&&config.signing_key_file&&/^[a-f0-9]{64}$/.test(config.ca_sha256??''),'PG_DYNAMIC_ISSUER_REQUIRED');
  const caPem=await privatePem(config.ca_file),keyPem=await privatePem(config.signing_key_file);
  requireThat(sha256(caPem)===config.ca_sha256,'PG_ISSUER_CA_PIN');
  try {const ca=new X509Certificate(caPem);requireThat(ca.ca&&ca.checkPrivateKey(createPrivateKey(keyPem))&&
    Date.parse(ca.validFrom)<=now()&&Date.parse(ca.validTo)>now()+86400000,'PG_ISSUER_CA_INVALID');}
  catch {throw Error('PG_ISSUER_CA_INVALID');}
  return {caPem,keyPem};
}
/** Only the control service holds the new signing authority. Leaf issuance is
 * operation-aware; a warm epoch never reuses the previous epoch's certificate. */
export async function issueTransportCredentials(identity,config,{now=Date.now}={}) {
  requireThat(/^ins-[a-z0-9]+$/.test(identity.instance_id)&&/^[a-f0-9-]{36}$/.test(identity.epoch),'PG_ISSUER_IDENTITY');
  const {caPem,keyPem}=await validateTransportIssuer(config,{now}),dir=await mkdtemp(join(tmpdir(),'execution-pg-issuer-'));
  try {
    await writeFile(join(dir,'ca.pem'),caPem,{mode:0o600});await writeFile(join(dir,'ca.key'),keyPem,{mode:0o600});
    await writeFile(join(dir,'client.ext'),'extendedKeyUsage=clientAuth\nbasicConstraints=critical,CA:FALSE\n',{mode:0o600});
    try {
      await exec('/usr/bin/openssl',['req','-newkey','ec','-pkeyopt','ec_paramgen_curve:P-256','-nodes','-subj',`/CN=${identity.instance_id}:${identity.epoch}`,
        '-keyout',join(dir,'client.key'),'-out',join(dir,'client.csr')],{timeout:5000,maxBuffer:4096});
      await exec('/usr/bin/openssl',['x509','-req','-in',join(dir,'client.csr'),'-CA',join(dir,'ca.pem'),'-CAkey',join(dir,'ca.key'),'-CAcreateserial',
        '-days','1','-extfile',join(dir,'client.ext'),'-out',join(dir,'client.pem')],{timeout:5000,maxBuffer:4096});
    }catch{throw Error('PG_LEAF_ISSUANCE_FAILED');}
    const credentials={version:'execution-pg-mtls-v1',...identity,ca_pem:caPem,cert_pem:await readFile(join(dir,'client.pem'),'utf8'),key_pem:await readFile(join(dir,'client.key'),'utf8')};
    validateTransportCredentials(credentials,{...identity,ca_sha256:config.ca_sha256},{now});return credentials;
  }finally{await rm(dir,{recursive:true});}
}
