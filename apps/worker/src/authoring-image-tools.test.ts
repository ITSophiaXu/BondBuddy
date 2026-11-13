import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink, link, truncate } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { callAuthoringImageTool, authoringImageToolDefinitions } from './authoring-image-tools.js';

const fakePreview={mime_type:'image/jpeg' as const,data:'/9j/',byte_size:2,source_width:200,source_height:100,
  region:[0,0,200,100] as [number,number,number,number],preview_width:200,preview_height:100,scaled:false,jpeg_quality:95,note:'synthetic'};
async function fixture(fn:(root:string)=>Promise<void>){const root=await mkdtemp(join(tmpdir(),'bb-image-tool-'));
  try{for(const dir of ['materials','scratch','output'])await mkdir(join(root,dir));await fn(root);}
  finally{await rm(root,{recursive:true,force:true});}}

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
