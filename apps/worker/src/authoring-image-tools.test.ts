import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { callAuthoringImageTool, authoringImageToolDefinitions, authoringImageToolDefinitionsFor, createAuthoringImageBudget,
  AUTHORING_IMAGE_HISTORY_MAX_BYTES, AUTHORING_IMAGE_MAX_BYTES } from './authoring-image-tools.js';
import { AUTHORING_IMAGE_BUDGET_SIGNAL } from './authoring-image-tools.js';

const fakePreview={mime_type:'image/jpeg' as const,data:'/9j/',byte_size:2,source_width:200,source_height:100,
  region:[0,0,200,100] as [number,number,number,number],preview_width:200,preview_height:100,scaled:false,jpeg_quality:95,note:'synthetic'};
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'bb-image-tool-'));
  try{for(const dir of ['materials','scratch','output'])await mkdir(join(root,dir));await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}}

test('a replaced PDF crop cannot be shown with a previous record digest',()=>fixture(async root=>{
  const path='scratch/pdf-crops/current.png',bytes=Buffer.from('synthetic cell 1'),digest=createHash('sha256').update(bytes).digest('hex');
  await mkdir(join(root,'scratch/pdf-crops'));await writeFile(join(root,path),bytes);
  const budget=createAuthoringImageBudget(),render=async()=>fakePreview;
  const first=await callAuthoringImageTool(root,'view_image',{path,expected_sha256:digest},render,budget);
  assert.equal(first.content[1].type,'image');const remaining=budget.remaining();
  await writeFile(join(root,path),'synthetic cell 2');
  const forbidden=async()=>{throw Error('wrong crop reached renderer');};
  await assert.rejects(callAuthoringImageTool(root,'view_image',{path,expected_sha256:digest},forbidden,budget),/IMAGE_SOURCE_CHANGED/);
  await assert.rejects(callAuthoringImageTool(root,'view_image',{path},forbidden,budget),/IMAGE_SOURCE_HASH_REQUIRED/);
  assert.equal(budget.remaining(),remaining);
}));

test('bounded image tool exposes one read-only method and passes bytes/crop without changing the source',()=>fixture(async root=>{
  const bytes=Buffer.from('synthetic image bytes');await writeFile(join(root,'scratch','a.png'),bytes);
  let calls=0;
  const result=await callAuthoringImageTool(root,'view_image',{path:'scratch/a.png',crop:[10,20,30,40]},async(input,crop)=>{
    calls++;assert.deepEqual(input,bytes);assert.deepEqual(crop,[10,20,30,40]);return fakePreview;});
  assert.equal(calls,1);assert.deepEqual(authoringImageToolDefinitions.map(t=>t.name),['view_image']);
  assert.equal(authoringImageToolDefinitions[0].annotations.readOnlyHint,true);
  const metadata=JSON.parse((result.content[0] as {text:string}).text);
  assert.equal(metadata.source_sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(result.content[1].type,'image');
}));

test('paths outside the three directories, traversal, absolute paths and unexpected arguments never reach renderer',()=>fixture(async root=>{
  const render=async()=>{throw Error('renderer must not run');};
  for(const path of ['/tmp/a.png','C:/a.png','scratch/../secret.png','scratch//a.png','scratch/./a.png','scratch\\a.png',
    'scratch/a.png:stream','input.json','knowledge/a.png','scratch/a.pdf','scratch/\0a.png'])
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path},render),/IMAGE_PATH_INVALID/);
  await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/a.png',extra:true},render),/IMAGE_PATH_INVALID/);
  await assert.rejects(callAuthoringImageTool(root,'unknown',{path:'scratch/a.png'},render),/IMAGE_TOOL_UNSUPPORTED/);
  for(const crop of [[0,0,0,1],[0,0,1.5,2],[-1,0,3,4],[0,0,2,3,4]])
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/a.png',crop},render),/IMAGE_CROP_INVALID/);
}));

test('directory links, hardlinks, nonregular files and oversized files are rejected before rendering',()=>fixture(async root=>{
  const outside=await mkdtemp(join(tmpdir(),'bb-image-outside-'));const render=async()=>{throw Error('renderer must not run');};
  try {
    await writeFile(join(outside,'secret.png'),'secret');
    await symlink(outside,join(root,'scratch','link'),process.platform==='win32'?'junction':'dir');
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/link/secret.png'},render),/IMAGE_PATH_INVALID/);
    await link(join(outside,'secret.png'),join(root,'output','hard.png'));
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'output/hard.png'},render),/IMAGE_INPUT_TOO_LARGE/);
    await mkdir(join(root,'scratch','directory.png'));
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/directory.png'},render),/IMAGE_INPUT_TOO_LARGE/);
    await writeFile(join(root,'scratch','large.png'),'x');await truncate(join(root,'scratch','large.png'),32*1024*1024+1);
    await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/large.png'},render),/IMAGE_INPUT_TOO_LARGE/);
  }finally{await rm(outside,{recursive:true,force:true});}
}));

test('cumulative image history counts emitted base64 and emits a precise text-only host continuation signal',()=>fixture(async root=>{
  await writeFile(join(root,'scratch','a.png'),'synthetic source');
  const budget=createAuthoringImageBudget(),data=Buffer.alloc(AUTHORING_IMAGE_MAX_BYTES,7).toString('base64');
  let renders=0,emittedBytes=0;
  const render=async()=>{renders++;return {...fakePreview,data,byte_size:AUTHORING_IMAGE_MAX_BYTES};};
  for(let n=0;n<3;n++){
    const result=await callAuthoringImageTool(root,'view_image',{path:'scratch/a.png',crop:[n,0,10,10]},render,budget);
    const images=result.content.filter(item=>item.type==='image') as {type:string;data:string;mimeType:string}[];
    if(n<2){
      assert.equal(images.length,1);
      emittedBytes+=Buffer.byteLength(`data:${images[0].mimeType};base64,${images[0].data}`,'utf8');
    }else{
      assert.equal(images.length,0);
      assert.equal('isError' in result&&result.isError,false,'the host control signal remains a normal MCP result, not a flattened tool error');
      assert.ok((result.content[0] as {text:string}).text.startsWith(AUTHORING_IMAGE_BUDGET_SIGNAL+'.'));
      assert.match((result.content[0] as {text:string}).text,/pdf_pages/);
      assert.match((result.content[0] as {text:string}).text,/fresh context within the recovery limits/);
      assert.match((result.content[0] as {text:string}).text,/uncertain financial digits/);
    }
  }
  assert.ok(emittedBytes<=AUTHORING_IMAGE_HISTORY_MAX_BYTES);
  assert.equal(budget.remaining(),AUTHORING_IMAGE_HISTORY_MAX_BYTES-emittedBytes);
  const later=await callAuthoringImageTool(root,'view_image',{path:'scratch/a.png'},async()=>{renders++;return fakePreview;},budget);
  assert.ok(later.content.every(item=>item.type==='text'));
  assert.equal(renders,3,'a budget-exhausted context does not decode more images or emit smaller retries');
}));

test('image budget accepts its exact boundary, latches excess and rendering failures do not spend it',()=>fixture(async root=>{
  const budget=createAuthoringImageBudget();
  assert.equal(budget.consume(AUTHORING_IMAGE_HISTORY_MAX_BYTES-1),true);
  assert.equal(budget.consume(1),true);
  assert.equal(budget.remaining(),0);
  assert.equal(budget.consume(1),false);
  assert.equal(budget.exhausted(),true);
  await writeFile(join(root,'scratch','a.png'),'synthetic source');
  const fresh=createAuthoringImageBudget();
  await assert.rejects(callAuthoringImageTool(root,'view_image',{path:'scratch/a.png'},async()=>{throw Error('IMAGE_DECODE_FAILED');},fresh),/IMAGE_DECODE_FAILED/);
  assert.equal(fresh.remaining(),AUTHORING_IMAGE_HISTORY_MAX_BYTES);
  assert.equal(fresh.exhausted(),false);
}));

test('nonrecoverable file routes can read four bounded images without the low rotation threshold or a continuation promise',()=>fixture(async root=>{
  await writeFile(join(root,'scratch','a.png'),'synthetic source');
  const budget=createAuthoringImageBudget(false),data=Buffer.alloc(AUTHORING_IMAGE_MAX_BYTES,7).toString('base64');
  let emitted=0;
  for(let n=0;n<4;n++){
    const result=await callAuthoringImageTool(root,'view_image',{path:'scratch/a.png',crop:[n,0,10,10]},
      async()=>({...fakePreview,data,byte_size:AUTHORING_IMAGE_MAX_BYTES}),budget);
    assert.equal(result.content.filter(item=>item.type==='image').length,1);
    const metadata=JSON.parse((result.content[0] as {text:string}).text);
    assert.equal(metadata.byte_size,AUTHORING_IMAGE_MAX_BYTES);
    assert.equal(metadata.image_history_remaining_bytes,null,'no fake cumulative budget is exposed');
    assert.equal((result.content[0] as {text:string}).text.includes(AUTHORING_IMAGE_BUDGET_SIGNAL),false);
    emitted+=Buffer.byteLength(`data:image/jpeg;base64,${data}`);
  }
  assert.ok(emitted>AUTHORING_IMAGE_HISTORY_MAX_BYTES);
  assert.equal(budget.exhausted(),false);
  assert.equal(budget.remaining(),null);
  assert.match(authoringImageToolDefinitionsFor(false)[0].description,/does not support automatic context rotation/);
  assert.doesNotMatch(authoringImageToolDefinitionsFor(false)[0].description,/exhaustion asks the host/);
  assert.match(authoringImageToolDefinitionsFor(true)[0].description,/exhaustion asks the host/);
}));
