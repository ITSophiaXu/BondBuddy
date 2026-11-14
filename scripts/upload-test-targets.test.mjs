import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {localUploadTargets} from './upload-test-targets.mjs';

// Azurite's published public development key; never a production credential.
const key='Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==';
const storage=host=>`DefaultEndpointsProtocol=https;AccountName=devstoreaccount1;AccountKey=${key};BlobEndpoint=https://${host}:10000/devstoreaccount1;`;
test('raw target validation accepts only explicit local protocols without overrides',()=>{
 for(const host of ['localhost','127.0.0.1','[::1]'])assert.equal(localUploadTargets(`postgresql://synthetic@${host}/bb_synthetic`,storage(host)).database.hostname,host);
 for(const db of ['postgresql://synthetic@production.invalid/bb_synthetic','https://localhost/bb_synthetic','postgresql://localhost/bb_synthetic?host=production.invalid','postgresql://localhost/','invalid'])assert.throws(()=>localUploadTargets(db,storage('localhost')));
 assert.throws(()=>localUploadTargets('postgresql://localhost/bb_synthetic',storage('production.invalid')));
});
for(const [kind,db,blob] of [
 ['remote database','postgresql://synthetic@production.invalid/bb_synthetic',storage('localhost')],
 ['remote storage','postgresql://synthetic@localhost/bb_synthetic',storage('production.invalid')],
])test(`capacity entry refuses ${kind} before any actual socket/CREATE DATABASE`,()=>{
 const source=`import net from 'node:net';let connections=0;net.Socket.prototype.connect=function(){connections++;throw Error('Unexpected fixture connection')};process.argv[2]='/synthetic-fixture';let error='';try{await import('./scripts/upload-four-confirmation.mjs')}catch(e){error=e.message}console.log(JSON.stringify({connections,error}));`;
 const result=spawnSync(process.execPath,['--input-type=module','-e',source],{env:{PATH:process.env.PATH,BB_TEST_DATABASE_URL:db,BB_TEST_AZURITE_CONNECTION_STRING:blob},encoding:'utf8',timeout:15000});
 assert.equal(result.status,0,result.stderr);const actual=JSON.parse(result.stdout.trim());
 assert.equal(actual.connections,0);assert.equal(actual.error,'Upload fixtures require explicit loopback PostgreSQL and HTTPS Blob targets');
});
