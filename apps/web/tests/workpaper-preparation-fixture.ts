import {expect, type Page} from '@playwright/test';
import {AUTOMATIC_PRICE_VERSION, AUTOMATIC_TASK_TARIFF, WORKPAPER_PRICE, emptyFileGenerationPreparation,
  type FileGenerationWorkspace, type FileGenerationSubmit, type FileGenerationPreparation,
  type WorkpaperWorkspace, type WorkpaperBatch, type ProjectFileWorkspace} from '@bondbuddy/contracts';
import {fixtureBody, fixtureRequest} from './billing-fixture-wire';
import {ids, now, sha} from './generation-entry-fixtures';

type Snapshot = {request:FileGenerationSubmit; preparation:FileGenerationPreparation; source:NonNullable<ProjectFileWorkspace['source']>};

// Current preparation uses a saved revision and a server quote. The legacy
// /workpapers fixture remains responsible for result actions and old requests.
export async function workpaperPreparation(page:Page, workpapers:WorkpaperWorkspace,
  source:NonNullable<ProjectFileWorkspace['source']>, automatic=false, builtinAvailable=true) {
  const catalogue=workpapers.catalogues[0];
  const pricing=automatic
    ? {mode:'automatic' as const,price_version:AUTOMATIC_PRICE_VERSION,workpaper_points:AUTOMATIC_TASK_TARIFF.workpaper.points,document_points:AUTOMATIC_TASK_TARIFF.related.points}
    : {mode:'legacy' as const,price_version:WORKPAPER_PRICE.version,workpaper_points:WORKPAPER_PRICE.points,document_points:WORKPAPER_PRICE.points};
  const data:FileGenerationWorkspace={revision:0,preparation:emptyFileGenerationPreparation(),sets:[],
    builtin:{name:'光大证券模板',version:'synthetic-workpaper-v1',available:builtinAvailable},batches:[],pricing};
  const state={data,quotes:[] as Snapshot[],submissions:[] as Snapshot[],lost:false};
  const quoted=new Map<string,Snapshot>();
  await page.route('**/api/v1/projects/*/workpapers/catalogues/*',route=>route.fulfill({json:catalogue}));
  await page.route('**/api/v1/projects/*/file-generation**',async route=>{
    const request=route.request(),path=new URL(request.url()).pathname,method=request.method();
    const body=method==='GET'?undefined:fixtureRequest(request);
    const reply=(value:unknown)=>route.fulfill({json:fixtureBody(route,value)});
    if(method==='GET'&&path.endsWith('/file-generation'))return reply(data);
    if(path.endsWith('/progress'))return reply({revision:sha,active:false});
    if(path.endsWith('/builtin'))return reply({catalogue});
    if(path.endsWith('/preparation')){
      expect(method).toBe('PUT');
      if(body.expected_revision!==data.revision)return route.fulfill({status:409,json:{code:'INPUT_REVISION_CONFLICT'}});
      data.preparation=structuredClone(body.preparation);data.revision++;
      return reply({revision:data.revision,preparation:data.preparation});
    }
    if(path.endsWith('/quote')){
      expect(body.expected_revision).toBe(data.revision);
      expect(body.source_version_id).toBe(source.version_id);
      expect(body.source_selection_revision).toBe(source.selection_revision);
      expect(data.preparation.document_types).toEqual(['workpaper']);
      const snapshot:Snapshot={request:body,preparation:structuredClone(data.preparation),source:structuredClone(source)};
      state.quotes.push(snapshot);const quoteId='workpaper-quote-'+state.quotes.length;quoted.set(quoteId,snapshot);
      return reply({quote_id:quoteId,count:snapshot.preparation.item_ids.length,
        points:snapshot.preparation.item_ids.length*pricing.workpaper_points,price_version:pricing.price_version,
        omitted:catalogue.entries.filter(e=>!snapshot.preparation.item_ids.includes(e.id)),
        ...(automatic?{auto_charge:true,quote_status:'ready'}:{})});
    }
    if(path.endsWith('/batches')){
      const snapshot=quoted.get(body.quote_id);expect(snapshot,'submission must reference an issued quote').toBeDefined();
      expect(body.expected_revision).toBe(snapshot!.request.expected_revision);
      expect(body.source_version_id).toBe(snapshot!.request.source_version_id);
      expect(body.source_selection_revision).toBe(snapshot!.request.source_selection_revision);
      expect(body.expected_points).toBe(snapshot!.preparation.item_ids.length*pricing.workpaper_points);
      expect(body.price_version).toBe(pricing.price_version);
      const submitted={...structuredClone(snapshot!),request:body};state.submissions.push(submitted);
      let batch=data.batches.find(b=>b.batch_id==='unified-'+body.request_id);
      if(!batch){
        const workpaper:WorkpaperBatch={batch_id:'batch-1',topic_id:'topic-workpapers',catalogue_id:catalogue.catalogue_id,
          revision:1,state:'queued',start_mode:'direct',source:snapshot!.source,total_points:body.expected_points,
          charged_points:0,created_at:now,error:null,items:catalogue.entries.filter(e=>snapshot!.preparation.item_ids.includes(e.id))
            .map(entry=>({entry,run_id:null,state:'queued',stage:null,attempt:1,error:null,artifacts:[]}))};
        workpapers.batches.push(workpaper);
        batch={batch_id:'unified-'+body.request_id,created_at:now,points:body.expected_points,workpapers:workpaper,documents:null};
        data.batches.push(batch);
      }
      if(state.lost){state.lost=false;return route.abort('failed');}
      return reply(batch);
    }
    return route.fulfill({status:404,json:{code:'NOT_FOUND'}});
  });
  return state;
}
