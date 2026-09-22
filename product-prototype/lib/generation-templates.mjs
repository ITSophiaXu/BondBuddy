import { randomUUID,createHash } from 'node:crypto';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join,extname,resolve } from 'node:path';
import { readJson,atomicJson,python } from './platform.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const normalise=value=>String(value||'').normalize('NFKC').replace(/\s+/g,'').trim();
const publicTemplate=({id,broker,filename,createdAt,sha256})=>({id,broker,filename,createdAt,sha256});
export class GenerationTemplates{
  constructor(root){this.root=root;this.tail=Promise.resolve();}
  ownerFolder(owner){return join(this.root,hash(owner));}
  async index(owner){return readJson(join(this.ownerFolder(owner),'index.json')).catch(error=>{if(error.code==='ENOENT')return [];throw error;});}
  async list(owner,broker){const list=await this.index(owner);return list.filter(t=>normalise(t.broker)===normalise(broker)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(publicTemplate);}
  async get(owner,id,broker){
    const item=(await this.index(owner)).find(t=>t.id===id&&normalise(t.broker)===normalise(broker));
    if(!item)throw Object.assign(new Error('未找到当前账号、该券商的模板，请重新选择。'),{status:404});
    const path=join(this.ownerFolder(owner),item.id,'source'+extname(item.filename).toLowerCase()),content=await readFile(path);
    if(hash(content)!==item.sha256)throw new Error('模板文件已变化，请重新上传。');
    return {...publicTemplate(item),file:{role:'generationTemplate',filename:item.filename,content}};
  }
  async save(owner,broker,file){
    const run=this.tail.then(async()=>{
      if(!normalise(broker)||broker.length>200)throw new Error('请填写立项券商全称。');
      if(!['.docx','.pdf','.txt'].includes(extname(file.filename).toLowerCase())||!file.content.length||file.content.length>20*1024*1024)throw new Error('立项模板请提供不超过20 MB的 DOCX、PDF 或 TXT。');
      const index=await this.index(owner),digest=hash(file.content),existing=index.find(t=>normalise(t.broker)===normalise(broker)&&t.sha256===digest);
      if(existing)return this.get(owner,existing.id,broker);
      const id=randomUUID(),dir=join(this.ownerFolder(owner),id);await mkdir(dir,{recursive:true});
      const path=join(dir,'source'+extname(file.filename).toLowerCase());await writeFile(path,file.content);
      await atomicJson(join(dir,'manifest.json'),{files:[{role:'generationTemplate',filename:file.filename,path}]});
      // Account hashes and template IDs can put this directory beyond Windows'
      // process working-directory limit. Keep the process at ROOT and pass paths.
      await python('extract_materials.py',[resolve(dir,'manifest.json'),resolve(dir,'evidence.json')]);
      const documents=(await readJson(join(dir,'evidence.json'))).documents;
      if(!documents[0]?.records.length)throw new Error('模板未提取到文字，请上传可检索的模板或参考报告。');
      const item={id,broker:broker.trim(),filename:file.filename,createdAt:new Date().toISOString(),sha256:digest};
      await atomicJson(join(this.ownerFolder(owner),'index.json'),[...index,item]);return {...publicTemplate(item),file:{...file,role:'generationTemplate'}};
    });this.tail=run.catch(()=>{});return run;
  }
}
