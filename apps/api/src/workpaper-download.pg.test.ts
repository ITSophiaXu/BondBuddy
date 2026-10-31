import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {crc32,inflateRawSync} from 'node:zlib';
import {Pool} from 'pg';
import {BlobServiceClient} from '@azure/storage-blob';
import {ZipFile} from 'yazl';
import {createServer} from './server.js';
import {azureBlobs,digest} from './data.js';
import {isolatedTestDatabase} from './test-database.js';
import {makeSyntheticDocxFixture} from './docx-fixtures.js';
import {readWorkpaperBatch} from './workpapers.js';
import {readProjectFileAsset} from './project-file-storage.js';
import {setTimeout as delay} from 'node:timers/promises';

const database=await isolatedTestDatabase(undefined,'workpaper-download');
const storage=process.env.BB_TEST_AZURITE_CONNECTION_STRING;
const media='application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('248-file ZIP on real PostgreSQL/Azurite: cold/warm HTTP, legacy-read benchmark, CRC and authorization',
 {skip:!database||!storage,timeout:180000},async t=>{
  const pool=new Pool({connectionString:database}),originalOwner=randomUUID();let actor:string=originalOwner;
  const container='bb-zip-'+randomUUID().replaceAll('-',''),blobs=azureBlobs(storage!,container);
  // Model real per-object latency while retaining actual Azurite reads/hashes.
  // Preparing all 248 files exceeds the request deadline below, so a blocking
  // cold response would fail even though every individual file is healthy.
  const slowBlobs={...blobs,openRead:async(key:string,signal?:AbortSignal)=>{await delay(200,undefined,{signal});return blobs.openRead!(key,signal);}};
  const app=createServer({pool,blobs:slowBlobs,allowedOrigin:'http://bondbuddy.test',principal:async()=>({userId:actor,csrfVerified:true})});
  const post=async(path:string,payload:unknown)=>{
    const response=await app.inject({method:'POST',url:'/api/v1'+path,payload:payload as any,headers:{origin:'http://bondbuddy.test'}});
    assert.ok(response.statusCode<300,response.body);return response.json();
  };
  try{
    const project=(await post('/projects',{name:'Synthetic ZIP benchmark',kind:'generation',issuer_name:'Synthetic',market:'sse',offering:'private'})).project_id;
    const topic=(await post('/m4/topics',{creation_request_id:randomUUID(),name:'Synthetic ZIP batch',source_project_id:project})).topic;
    const bytes=makeSyntheticDocxFixture({text:randomBytes(40_000).toString('base64')}),sha=digest(bytes);
    const source={project_id:project,version_id:'synthetic-source',selection_revision:1,sequence:1,filename:'Synthetic.docx',asset:{kind:'material',pin:{source_project_id:project,material_id:'synthetic-material',material_version:1,sha256:sha}}};
    const catalogue=randomUUID(),batch=randomUUID();
    const entries=Array.from({length:248},(_,i)=>({id:'item-'+i,code:'1-'+i,title:'合成核查记录（含附表）',folder:'1 尽职调查文件',kind:'file',sheet:'目录',row:i+2,instructions:'synthetic',path:i+'.docx'}));
    await pool.query("INSERT INTO bb_workpaper_catalogues(id,owner_user_id,project_id,request_id,request_hash,material,filename,entries,warnings,sha256) VALUES($1,$2,$3,$1,$4,'{}','Synthetic.xlsx',$5,'[]',$4)",[catalogue,actor,project,sha,JSON.stringify(entries)]);
    await pool.query("INSERT INTO bb_workpaper_batches(id,owner_user_id,project_id,topic_id,catalogue_id,request_id,request_hash,source,state,total_points,price_version,start_mode) VALUES($1,$2,$3,$4,$5,$1,$6,$7,'complete',0,'synthetic','direct')",[batch,actor,project,topic.topic_id,catalogue,sha,source]);
    await pool.query("INSERT INTO bb_input_revisions(project_id,revision,owner_user_id,draft_revision,input_hash,manifest,material_versions,requirement_message_ids) VALUES($1,1,$2,1,$3,'{}','[]','[]')",[topic.project_id,actor,sha]);
    for(let n=0;n<entries.length;n++){
      const entry=entries[n],key='synthetic/'+entry.id;await blobs.put(key,bytes,media);
      const run=n<124?null:randomUUID();
      if(run){
        await pool.query("INSERT INTO bb_runs(id,owner_user_id,project_id,input_revision,input_hash,execution_request_id,task_kind,request_hash,state) VALUES($1,$2,$3,1,$4,$1,'generation',$4,'running')",[run,actor,topic.project_id,sha]);
        const evidence=randomUUID();
        await pool.query("INSERT INTO bb_word_delivery_evidence(id,owner_user_id,run_id,artifact_id,artifact_version,candidate_sha256,byte_size,validator_version,quality_status,delivery_status,delivery_code,readback_sha256,readback_byte_size,quality_evidence) VALUES($1,$2,$3,$4,1,$5,$6,'synthetic-validator','passed','available','readback_verified',$5,$6,$7)",[evidence,actor,run,entry.id,sha,bytes.length,{sha256:sha,byte_size:bytes.length,validator_version:'synthetic-validator',quality_status:'passed'}]);
        await pool.query("INSERT INTO bb_artifact_versions(id,version,owner_user_id,run_id,media_type,sha256,object_key,quality_status,delivery_status,word_delivery_evidence_id) VALUES($1,1,$2,$3,$4,$5,$6,'passed','available',$7)",[entry.id,actor,run,media,sha,key,evidence]);
        await pool.query("INSERT INTO bb_m4_artifacts(owner_user_id,run_id,artifact_id,artifact_version,kind,filename,topic_id,byte_size,input_hash) VALUES($1,$2,$3,1,'document',$4,$5,$6,$7)",[actor,run,entry.id,entry.path,topic.topic_id,bytes.length,sha]);
        await pool.query("UPDATE bb_runs SET state='succeeded',artifact_id=$2,artifact_version=1 WHERE id=$1",[run,entry.id]);
      }
      await pool.query("INSERT INTO bb_workpaper_items(owner_user_id,batch_id,item_id,ordinal,manifest,state,run_id,explanation) VALUES($1,$2,$3,$4,$5,'succeeded',$6,$7)",[actor,batch,entry.id,n,{input:{workpaper:{entry}}},run,run?null:{key,sha256:sha,filename:entry.path}]);
    }
    // Same database/storage and the previous serial per-file read/query/compress
    // strategy. This is a local benchmark, not a production latency claim.
    const legacyStart=performance.now(),data=await readWorkpaperBatch(pool,actor,project,batch),zip=new ZipFile();
    const oldBody=(async()=>{const chunks:Buffer[]=[];for await(const chunk of zip.outputStream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks);})();
    for(const item of data.items){
      let key:string;
      if(item.explanation){
        await pool.query('SELECT id FROM bb_projects WHERE owner_user_id=$1 AND id=$2 AND deleted_at IS NULL',[actor,project]);
        key=(await pool.query('SELECT explanation FROM bb_workpaper_items WHERE owner_user_id=$1 AND batch_id=$2 AND item_id=$3',[actor,batch,item.entry.id])).rows[0].explanation.key;
      }else key=(await readProjectFileAsset(pool,actor,{kind:'artifact',pin:item.artifacts[0].pin})).object_key;
      const read=await blobs.getIfExistsBounded(key,64*1024*1024);assert.ok(read);assert.equal(digest(read),sha);zip.addBuffer(read,item.entry.id+'.docx');
    }
    zip.end();await oldBody;const legacyMs=performance.now()-legacyStart;
    const address=await app.listen({port:0,host:'127.0.0.1'}),url=`${address}/api/v1/projects/${project}/workpapers/batches/${batch}/download`;
    const download=async()=>{
      const start=performance.now();let response:Response,polls=0,maxRequestMs=0;
      for(;;){
        const requestStart=performance.now();
        response=await fetch(url,{headers:{Prefer:'respond-async'},signal:AbortSignal.timeout(2000)});
        maxRequestMs=Math.max(maxRequestMs,performance.now()-requestStart);
        if(response.status!==202)break;
        const preparation=await response.json();assert.equal(preparation.status,'preparing');
        assert.equal(preparation.progress.total_files,248);
        assert.ok(['retrieving','packaging'].includes(preparation.progress.phase));
        assert.ok(Number.isInteger(preparation.progress.completed_files)&&preparation.progress.completed_files>=0&&preparation.progress.completed_files<=248);polls++;
        await delay(Number(response.headers.get('retry-after'))*1000);
      }
      const headersMs=performance.now()-start;
      assert.equal(response.status,200,await (response.status===200?Promise.resolve(''):response.text()));
      const content=Buffer.from(await response.arrayBuffer());assert.equal(Number(response.headers.get('content-length')),content.length);
      return {content,headersMs,totalMs:performance.now()-start,polls,maxRequestMs};
    };
    const cold=await download(),warm=await download();assert.deepEqual(warm.content,cold.content);
    assert.ok(cold.polls>1);assert.ok(cold.totalMs>2000);assert.equal(warm.polls,0);
    let offset=cold.content.readUInt32LE(cold.content.length-6),count=0;
    while(cold.content.readUInt32LE(offset)===0x02014b50){
      const local=cold.content.readUInt32LE(offset+42),size=cold.content.readUInt32LE(offset+20),nameLength=cold.content.readUInt16LE(offset+28);
      const name=cold.content.subarray(offset+46,offset+46+nameLength).toString();assert.match(name,/^(可生成文件|不适用说明)\//);
      const start=local+30+cold.content.readUInt16LE(local+26)+cold.content.readUInt16LE(local+28),compressed=cold.content.subarray(start,start+size);
      const member=cold.content.readUInt16LE(offset+10)===0?compressed:inflateRawSync(compressed);
      assert.equal(crc32(member),cold.content.readUInt32LE(offset+16));assert.equal(digest(member),sha);
      offset+=46+nameLength+cold.content.readUInt16LE(offset+30)+cold.content.readUInt16LE(offset+32);count++;
    }
    assert.equal(count,248);
    t.diagnostic(JSON.stringify({files:count,zipBytes:cold.content.length,legacySerialMs:Math.round(legacyMs),coldPrepareMs:Math.round(cold.headersMs),coldTotalMs:Math.round(cold.totalMs),coldPolls:cold.polls,maxRequestMs:Math.round(cold.maxRequestMs),warmPrepareMs:Math.round(warm.headersMs),warmTotalMs:Math.round(warm.totalMs)}));
    actor='foreign';assert.equal((await fetch(url)).status,404);actor=originalOwner;
    await pool.query("UPDATE bb_artifact_versions SET delivery_status='pending' WHERE owner_user_id=$1 AND id='item-124'",[actor]);
    const changed=await download();assert.notDeepEqual(changed.content,cold.content);
    await pool.query('UPDATE bb_projects SET deleted_at=now() WHERE owner_user_id=$1 AND id=$2',[actor,project]);
    assert.equal((await fetch(url)).status,404);
    assert.equal((await pool.query('SELECT count(*)::int n FROM bb_credit_events WHERE owner_user_id=$1',[actor])).rows[0].n,0);
  }finally{await app.close();await pool.end();await BlobServiceClient.fromConnectionString(storage!).getContainerClient(container).deleteIfExists();}
});
