import test from 'node:test';
import assert from 'node:assert/strict';
import {qaProspectusIssue} from './project-qa.js';
import type {ProjectFileAsset,ProjectFileSource} from './project-file-workspace.js';
const asset:ProjectFileAsset={kind:'material',pin:{source_project_id:'p',material_id:'m',material_version:1,sha256:'a'.repeat(64)}};
const prospectus:ProjectFileSource={project_id:'p',version_id:'v',selection_revision:1,sequence:1,filename:'募集说明书.docx',asset};
test('answer requires adopted prospectus, exact selected version, distinct from questions',()=>{
 assert.match(qaProspectusIssue(null,[asset])!,/募集说明书/);
 assert.match(qaProspectusIssue(prospectus,[])!,/尚未选入/);
 assert.match(qaProspectusIssue(prospectus,[asset],asset)!,/不能同时/);
 assert.ok(qaProspectusIssue(prospectus,[{...asset,pin:{...asset.pin,material_version:2}}]));
 assert.equal(qaProspectusIssue(prospectus,[structuredClone(asset)]),null);
});
