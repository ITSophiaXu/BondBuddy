import type { Page } from '@playwright/test';
import type { Dto } from '../src/api';

// Synthetic HTTP receipt behavior matching project/role/content reuse in the API.
export async function duplicateUploadFixture(page:Page, attach:(material:Dto<'MaterialResponse'>)=>void) {
  const uploads:Dto<'UploadCreateRequest'>[]=[], materials:Dto<'MaterialResponse'>[]=[];
  await page.route('**/materials/uploads',async route=>{
    const upload=route.request().postDataJSON();uploads.push(upload);
    const id=String(uploads.length-1);
    await route.fulfill({json:{upload_id:id,state:'uploading',upload_url:'/api/v1/duplicate-test-bytes/'+id,expires_at:'2099-01-01T00:00:00Z',max_bytes:104857600}});
  });
  await page.route('**/duplicate-test-bytes/*',route=>route.fulfill({status:204}));
  await page.route('**/materials/uploads/*/complete',async route=>{
    const id=new URL(route.request().url()).pathname.split('/').at(-2)!,upload=uploads[Number(id)];
    let material=materials.find(m=>m.role===upload.role&&m.sha256===upload.sha256);
    if(!material){material={...upload,material_id:'duplicate-test-'+id,material_version:1,upload_id:id,state:'persisted',persisted_at:'2026-10-14T00:00:00Z',error:null};materials.push(material);}
    await route.fulfill({json:material});
  });
  await page.route('**/m4/topics/*/materials',async route=>{
    const pin=route.request().postDataJSON().material;
    const material=materials.find(m=>m.material_id===pin.material_id)!;attach(material);
    await route.fulfill({json:{material:pin}});
  });
  return {uploads,materials};
}
