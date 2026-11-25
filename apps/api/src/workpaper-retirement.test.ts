import assert from 'node:assert/strict';
import {test} from 'node:test';
import Fastify from 'fastify';
import type {Pool} from 'pg';
import {registerWorkpapers} from './workpapers.js';
import {registerFileGeneration} from './file-generation.js';
import type {PrivateBlobs} from './data.js';

test('retired workpaper creation, catalogue and system template routes reject new use',async()=>{
 const app=Fastify();
 const db=()=>({} as Pool),owner=async()=> 'owner',blobs=()=>({} as PrivateBlobs);
 registerWorkpapers(app,db,owner,blobs);
 registerFileGeneration(app,db,owner,blobs);
 const sha='a'.repeat(64),base='/api/v1/projects/project';
 try{
  const requests=[
   {method:'POST' as const,url:base+'/workpapers/batches',payload:{request_id:'new',catalogue_id:'catalogue',catalogue_sha256:sha,item_ids:['entry'],source_version_id:'source',source_selection_revision:0,requirements:'',price_version:'v1',expected_points:0,start_mode:'direct'}},
   {method:'POST' as const,url:base+'/workpapers/catalogues',payload:{request_id:'new',material:{source_project_id:'project',material_id:'material',material_version:1,sha256:sha}}},
   {method:'POST' as const,url:base+'/workpapers/catalogue-preview',payload:{material:{source_project_id:'project',material_id:'material',material_version:1,sha256:sha}}},
   {method:'POST' as const,url:base+'/file-generation/builtin',payload:{request_id:'new',version:'v1',part:'catalogue'}},
  ];
  for(const request of requests){const response=await app.inject(request);assert.ok(response.statusCode>=400,request.url);assert.match(response.body,/已下线/,request.url);}
  for(const url of [base+'/file-generation/system-templates',base+'/file-generation/matches?catalogue_id=c&set_id=s']){
   const response=await app.inject({method:'GET',url});assert.equal(response.statusCode,422);assert.match(response.body,/已下线/);
  }
 }finally{await app.close();}
});
