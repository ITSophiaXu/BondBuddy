import {readFormatFile} from './file-authoring-format.js';
import {digest} from '@bondbuddy/api/data';

/** The flat v1 log is a derived mirror once an atomic editor manifest exists. */
export async function readCommittedEditorOperations(root:string,max=32*1024*1024):Promise<Buffer>{
  let manifest:Record<string,unknown>;
  try{manifest=JSON.parse((await readFormatFile(root,'operations.json.manifest.json',max)).toString('utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return readFormatFile(root,'operations.json',max);throw error;}
  const path=manifest.operations_object_path;
  if(manifest.version!=='word-edit-manifest-v1'||typeof path!=='string'||!/^\.operations\.json\.objects\/[a-f0-9]{64}\.json$/.test(path)||typeof manifest.operations_sha256!=='string')throw Error('WORD_EDIT_MANIFEST_INVALID');
  const bytes=await readFormatFile(root,path,max);
  if(digest(bytes)!==manifest.operations_sha256)throw Error('WORD_EDIT_OBJECT_HASH_MISMATCH');
  return bytes;
}
