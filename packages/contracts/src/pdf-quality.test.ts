import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readPdfQuality} from './pdf-quality.js';
const quality = {version:'pdf-raster-quality-1',status:'partial',page_count:100,checked_pages:7,low_resolution_pages:[{page:7,dpi:144}]};
test('quality validates measured page coverage and rejects unknown/private fields',()=>{
  assert.deepEqual(readPdfQuality(quality),quality);
  for(const delta of [{status:'complete'},{checked_pages:101},{low_resolution_pages:[{page:8,dpi:144}]},{low_resolution_pages:[{page:7,dpi:144},{page:7,dpi:144}]},{low_resolution_pages:[{page:7,dpi:300}]},{path:'/private/customer.pdf'},{page_count:null}]) assert.equal(readPdfQuality({...quality,...delta}),undefined);
  assert.equal(readPdfQuality(undefined),undefined);
});
