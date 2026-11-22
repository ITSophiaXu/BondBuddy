import {test} from 'node:test';
import assert from 'node:assert/strict';
import {materialParseJobDto} from './material-jobs.js';
const row = {id:'job',project_id:'project',material_id:'material',material_version:1,material_sha256:'a'.repeat(64),parser_version:'test',state:'failed',stage:'pdf_quality',attempts:3,max_attempts:3,error_code:'MATERIAL_PARSE_TIMEOUT',updated_at:new Date(),checkpoint:{stages:{}}};
const quality={version:'pdf-raster-quality-1',status:'partial',page_count:107,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]};
test('material DTO retains quality through failure without changing task outcome',()=>{
 const dto=materialParseJobDto({...row,checkpoint:{stages:{pdf_quality:quality}}});
 assert.deepEqual(dto.pdf_quality,quality);assert.equal(dto.state,'failed');assert.equal(dto.error_code,'MATERIAL_PARSE_TIMEOUT');assert.equal(dto.outcome,null);
 assert.equal(materialParseJobDto(row).pdf_quality,undefined);
 assert.equal(materialParseJobDto({...row,checkpoint:{stages:{pdf_quality:{...quality,private_path:'secret'}}}}).pdf_quality,undefined);
});
