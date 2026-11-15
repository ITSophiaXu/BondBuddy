import {workpaperChapters,workpaperPlanGroupIds,WORKPAPER_PLAN_GROUP_SIZE,type WorkpaperProgressive} from '@bondbuddy/contracts';
import {inputManifestHash} from './production-rule-pin.js';

type BatchItem={item_id:string;attempt:number;manifest:any};
export type ExecutionBatchDemand={items:BatchItem[];sourceReady:boolean;wholePlanReady:boolean;itemPlans:Set<string>;groupReceipts:Map<string,{status:string}>;progressive_plan:WorkpaperProgressive|null;progressive_phase:string|null;state:string;max_parallel:number|null};
/** Same frozen chapter/group membership as the document stage. This classifies
 * existing admitted runs only; it neither admits another item nor schedules work. */
export function workpaperDemandKey(batchId:string,itemId:string,b:ExecutionBatchDemand):{key:string|null;reason?:'shared_plan_waiter'|'unready_input'}{
 const item=b.items.find(i=>i.item_id===itemId),task=item?.manifest?.input?.workpaper;
 if(!item||!task)return {key:null,reason:'unready_input'};
 const method=task.execution;
 if(!['shared_batch_v1','progressive_item_v1','grouped_batch_v1'].includes(method))return {key:'job:'+itemId};
 const first=b.items[0]?.item_id;
 if(!b.sourceReady&&itemId!==first)return {key:null,reason:'shared_plan_waiter'};
 if(!b.sourceReady)return {key:'source:'+batchId};
 if(method==='shared_batch_v1')return b.wholePlanReady?{key:'render:'+batchId+':'+itemId}:itemId===first?{key:'plan:'+batchId}:{key:null,reason:'shared_plan_waiter'};
 if(b.itemPlans.has(itemId))return {key:'render:'+batchId+':'+itemId};
 const plan:WorkpaperProgressive|undefined=method==='grouped_batch_v1'?{phase:'remaining',chapters:workpaperChapters(b.items.map(i=>i.manifest.input.workpaper.entry)),trial_item_ids:[],max_parallel:4}:b.progressive_plan?{...b.progressive_plan,phase:b.progressive_phase as WorkpaperProgressive['phase']}:undefined;
 let group:ReturnType<typeof workpaperPlanGroupIds>;
 try{group=workpaperPlanGroupIds(plan,itemId);}catch{return {key:null,reason:'unready_input'};}
 if(!group||item.attempt>1)return {key:'item:'+batchId+':'+itemId};
 const groupId=inputManifestHash({version:'workpaper-chapter-group-v1',chapter:group.chapter,ids:group.ids,size:WORKPAPER_PLAN_GROUP_SIZE});
 const receipt=b.groupReceipts.get(groupId);
 if(receipt?.status==='fallback')return {key:'item:'+batchId+':'+itemId};
 if(receipt)return {key:null,reason:'unready_input'}; // accepted receipt without item plan needs reconciliation
 return itemId===group.ids[0]?{key:'group:'+batchId+':'+groupId}:{key:null,reason:'shared_plan_waiter'};
}
