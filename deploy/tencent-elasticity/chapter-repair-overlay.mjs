/** Offline additive packaging only: no cloud APIs, installation or activation. */
import {readFileSync,writeFileSync,mkdirSync,existsSync,lstatSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {sha256,requireThat} from './policy.mjs';
import {businessOverlayFiles,businessOverlayProfile,CHAPTER_REPAIR_VERSION,chapterRepairFiles} from './business-overlay.mjs';

export function packOverlay(entries){
  const blocks=[];
  // Adjacent copies of the same path let gzip share its bounded dictionary
  // across roles. Contents and per-role pins are unchanged; no limit is raised.
  const key=name=>name.replace(/^(authoring|review)\//,'')+'/'+name;
  for(const [name,bytes] of [...entries].sort(([a],[b])=>key(a)<key(b)?-1:key(a)>key(b)?1:0)){
    requireThat(Buffer.byteLength(name)<100 && /^[a-zA-Z0-9_./-]+$/.test(name) && !name.split('/').includes('..'),'BUSINESS_OVERLAY_PATH');
    const header=Buffer.alloc(512);header.write(name);
    for(const [offset,width,value] of [[100,8,0o644],[108,8,0],[116,8,0],[124,12,bytes.length],[136,12,0]])
      header.write(value.toString(8).padStart(width-1,'0')+'\0',offset,width);
    header.fill(32,148,156);header[156]=48;header.write('ustar\0',257);header.write('00',263);
    const checksum=header.reduce((sum,b)=>sum+b,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8);
    blocks.push(header,bytes,Buffer.alloc((512-bytes.length%512)%512));
  }
  blocks.push(Buffer.alloc(1024));return gzipSync(Buffer.concat(blocks),{level:9});
}

export function pinnedOverlaySql(buildRoot,path,pin){
  const raw=readFileSync(join(buildRoot,path));
  const bytes=sha256(raw)===pin.sha256?raw:Buffer.from(raw.toString('utf8').replaceAll('\r\n','\n'));
  requireThat(sha256(bytes)===pin.sha256 && bytes.length===pin.bytes,'CHAPTER_OVERLAY_SQL_CHANGED');
  return bytes;
}

export function buildChapterRepairOverlay(base,archive,buildRoot){
  requireThat(base.version==='shared-business-eight-permissions-encrypted-v1','CHAPTER_OVERLAY_BASE_REQUIRED');
  const previous=businessOverlayFiles(archive,base),files=new Map(previous),changed=[];
  const profile=businessOverlayProfile(CHAPTER_REPAIR_VERSION);
  for(const path of chapterRepairFiles){
    const target=join(buildRoot,path),stat=lstatSync(target);
    requireThat(stat.isFile() && !stat.isSymbolicLink() && stat.nlink===1,'CHAPTER_OVERLAY_SOURCE_UNSAFE');
    const bytes=readFileSync(target);
    for(const role of ['authoring','review']){
      const key=`${role}/${path}`;
      changed.push({service_id:role,path,previous_sha256:previous.has(key)?sha256(previous.get(key)):null,sha256:sha256(bytes),bytes:bytes.length});
      files.set(key,bytes);
    }
  }
  const descriptors=[...files].map(([key,bytes])=>({service_id:key.split('/')[0],path:key.slice(key.indexOf('/')+1),sha256:sha256(bytes),bytes:bytes.length}));
  for(const [path,pin] of Object.entries(profile.sql)){
    files.set(path,pinnedOverlaySql(buildRoot,path,pin));
  }
  const output=packOverlay(files);
  requireThat(output.length<=524288,'BUSINESS_OVERLAY_SIZE_LIMIT');
  const descriptor={version:CHAPTER_REPAIR_VERSION,sha256:sha256(output),bytes:output.length,files:descriptors};
  businessOverlayFiles(output,descriptor); // strict path, checksum, hash and closure check
  return {archive:output,descriptor,receipt:{version:'chapter-repair-package-v1',base_archive_sha256:base.sha256,
    archive_sha256:descriptor.sha256,changed,preserved_entries:base.files.filter(f=>!chapterRepairFiles.includes(f.path)),
    deployed:false,cold_warm_acceptance:'not_run'}};
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [basePath,archivePath,buildRoot,output]=process.argv.slice(2);
  requireThat(basePath && archivePath && buildRoot && output && !existsSync(output),'CHAPTER_OVERLAY_ARGUMENTS');
  const git=(...args)=>execFileSync('git',['-C',buildRoot,...args],{encoding:'utf8'}).trim();
  requireThat(!git('status','--porcelain','--untracked-files=all'),'CHAPTER_OVERLAY_CLEAN_SOURCE_REQUIRED');
  // Re-emit from the fixed source before reading dist, so an old local build
  // cannot silently ship under the current commit's receipt.
  execFileSync(process.execPath,[join(resolve(buildRoot),'node_modules/typescript/bin/tsc'),'-p',join(resolve(buildRoot),'apps/worker/tsconfig.json')],{cwd:buildRoot,stdio:'inherit'});
  const result=buildChapterRepairOverlay(JSON.parse(readFileSync(basePath,'utf8')),readFileSync(archivePath),resolve(buildRoot));
  result.receipt.source_commit=git('rev-parse','HEAD');result.receipt.source_tree=git('rev-parse','HEAD^{tree}');
  mkdirSync(output,{recursive:false});
  writeFileSync(join(output,'overlay.tar.gz'),result.archive);
  writeFileSync(join(output,'descriptor.json'),JSON.stringify(result.descriptor,null,2)+'\n');
  writeFileSync(join(output,'receipt.json'),JSON.stringify(result.receipt,null,2)+'\n');
  console.log(JSON.stringify({version:result.descriptor.version,sha256:result.descriptor.sha256,bytes:result.descriptor.bytes,files:result.descriptor.files.length,deployed:false}));
}
