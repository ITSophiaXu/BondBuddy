import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ROOT, readJson } from './platform.mjs';
import { packDocument, retrieve } from './review.mjs';
export const SCOPES = ['sse-private','sse-public','szse-private','szse-public'];
export const manifest = () => readJson(join(ROOT,'knowledge','manifest.json'));
export async function loadKnowledge(scope,kind) {
  if (!SCOPES.includes(scope) || !['update','review'].includes(kind)) throw new Error('不支持的知识范围。');
  const id=`${scope}-${kind}`, base=join(ROOT,'knowledge',id);
  const data=await readJson(base+'.json');
  const handbook=await readFile(base+'.md','utf8');
  const sourceChunks=[];
  for (const source of data.sources) {
    const content=await readFile(join(ROOT,'knowledge','sources',source+'.md'),'utf8');
    sourceChunks.push(...packDocument({id:source,role:'knowledge',filename:source,records:content.split('\n').filter(Boolean).map((text,i)=>({locator:`L${i+1}`,text}))},5000));
  }
  return {...data,handbook,conflicts:'规则效力、适用条件、专家阈值与项目事实必须区分；未能解析的源文件不能作为已核验依据。',sourceChunks};
}
export const relatedKnowledge = (knowledge,query) => retrieve(query,knowledge.sourceChunks,2).map(c=>c.text).join('\n\n');
