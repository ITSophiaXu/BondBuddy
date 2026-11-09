import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {randomBytes,createHash} from 'node:crypto';
import {docxSample,DOCX} from '../apps/api/dist/upload-safety.samples.js';
const output=process.argv[2];
if(!output)throw new Error('An isolated fixture output directory is required');
const directory=resolve(output);await mkdir(directory,{recursive:true,mode:0o700});
const small=await docxSample();
const large=await docxSample([],Buffer.from(`<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Synthetic upload acceptance ${randomBytes(7*1024*1024).toString('base64')}</w:t></w:r></w:p></w:body></w:document>`));
if(large.length<6*1024*1024)throw new Error('Large fixture must exceed 6 MiB');
const files=[];
for(const [filename,bytes] of [['synthetic-small.docx',small],['synthetic-large.docx',large]]){
 await writeFile(join(directory,filename),bytes,{flag:'wx',mode:0o600});
 files.push({filename,media_type:DOCX,role:'historical',byte_size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});
}
await writeFile(join(directory,'manifest.json'),JSON.stringify({synthetic:true,files},null,2)+'\n',{flag:'wx',mode:0o600});
process.stdout.write(JSON.stringify({synthetic:true,files})+'\n');
