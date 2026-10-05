// Synthetic fixture: validates the report handed to the existing file authoring runtime.
import {readFileSync} from 'node:fs';
const args=process.argv.slice(2);
if(args.includes('exec')){
 const cwd=args[args.indexOf('--cd')+1],input=JSON.parse(readFileSync(cwd+'/input.json','utf8'));
 if(input.source_review?.version!=='review-result-v1'||!input.requirements.some(r=>r.includes('保留历史名称')))throw Error('review requirements not pinned');
 const report=input.materials.find(m=>m.role==='review_report');
 const source=input.materials.find(m=>m.editing_baseline);
 if(!report||!source||source.material_id!==input.source_review.source_material.material_id||report.path===source.path)throw Error('wrong report or baseline');
 readFileSync(cwd+'/'+report.path);
}
await import('./fake-file-authoring.mjs');
