import assert from 'node:assert/strict';
import {test} from 'node:test';
import {generationEntry,generationRoute,generationDocumentTypes} from './file-generation-entry.js';

test('workpaper bookmarks keep their batch, check and source destinations in the new entry',()=>{
 for(const hash of ['#workpapers','#workpapers?project=p&step=prepare','#generate?project=p&step=workpapers&batch=b&view=results','#generate?project=p&mode=workpapers','#generate?project=p&workpaper_batch=b','#generate?project=p&run=r&operation=workpaper_check','#generate?project=p&run=r&operation=workpaper_assessment']){
  assert.equal(generationRoute(generationEntry(hash)),'workpapers');
 }
 for(const hash of ['#generate','#generate?project=p&step=prepare','#generate?project=p&step=results','#generate?topic=t&run=r&mode=workpapers']){
  assert.equal(generationRoute(generationEntry(hash)),'generate');
 }
});

test('each entry submits only its own types and documents restore without reselecting a workpaper',()=>{
 assert.deepEqual(generationDocumentTypes(['workpaper','annual'],'documents'),['annual']);
 assert.deepEqual(generationDocumentTypes(['workpaper','annual'],'workpapers'),['workpaper']);
 assert.deepEqual(generationDocumentTypes(['annual'],'workpapers'),['workpaper']);
 assert.deepEqual(generationDocumentTypes(['workpaper'],'documents',['annual','init']),['annual','init']);
 assert.deepEqual(generationDocumentTypes([],'documents',['annual']),[]);
 assert.deepEqual(generationDocumentTypes(['legal'],'documents',['annual']),['legal']);
});
