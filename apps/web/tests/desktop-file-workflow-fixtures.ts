import {expect,type Page,type Route} from '@playwright/test';
import {Value} from '@sinclair/typebox/value';
import {schemas,type ProjectFileVersion} from '@bondbuddy/contracts';
import type {Dto} from '../src/api';
import {fixture as returnFixture,install as installReturn,assertFixture as assertReturn,assertNoBusiness as assertReturnNoBusiness,
  collection,editedFile,filesRoute,fileKey,gate,ids,login,navigate,otherProject,ready,uploadJournal} from './project-file-return-fixtures';
import {businessCalls,now} from './word-roundtrip-fixtures';

export {collection,editedFile,filesRoute,fileKey,gate,ids,login,navigate,otherProject,ready,uploadJournal};
export const filesHash='#/projects/'+ids.root+'/files';
type Task=Dto<'ProjectTasksResponse'>['items'][number];
type TaskPage=Dto<'ProjectTasksResponse'>;
const json=(route:Route,status:number,value:unknown)=>route.fulfill({status,json:value});
const fail=(route:Route,status=503)=>json(route,status,{code:'DATA_UNAVAILABLE',message:'Synthetic desktop task page unavailable',retryable:true,
  correlation_id:'desktop-file-workflow',field_errors:[]});
const created=(index:number)=>new Date(Date.parse(now)-index*60_000).toISOString();

/** Use the existing multi-document collection and the closed native Word task,
 * byte upload, import CAS, idempotent receipt and original unknown recovery.
 * Only the optional paged task projection is new synthetic HTTP here. */
export function fixture(options:{tasks?:number;originalIndex?:number}={}){
  const s=returnFixture();s.rootProject.name='合成桌面文件闭环项目';
  const count=options.tasks??4,originalIndex=options.originalIndex??count-1;
  const tasks:Task[]=Array.from({length:count},(_,index)=>({run_id:index===originalIndex?ids.originalRun:'desktop-file-task-'+String(index+1).padStart(2,'0'),
    project_id:ids.execution,kind:'generation',state:'succeeded',stage:'completed',artifact_id:index===originalIndex?ids.originalArtifact:null,
    created_at:created(index),updated_at:created(index),report_id:null,topic_id:ids.topic,document_type:index===originalIndex?'init':'issuer',operation:null}));
  const result=Object.assign(s,{workflowTasks:tasks,taskPageCalls:[] as {owner:string;cursor:string|null;runs:string[]}[],taskPageReplies:0,
    taskPageGates:new Map<string,Promise<void>>(),taskPageFailures:new Set<string>(),taskPageFault:null as 'duplicate'|null});
  validateTasks(result);return result;
}
export type State=ReturnType<typeof fixture>;
export function validateTasks(s:State){expect(Value.Check(schemas.ProjectTasksResponse,{project_id:ids.root,items:s.workflowTasks,page:{has_more:false,next_cursor:null}})).toBe(true);}
export function pageFor(s:State,cursor:string|null):TaskPage{
  const start=cursor?s.workflowTasks.findIndex(t=>cursor==='desktop-after:'+t.run_id)+1:0;
  if(cursor&&start===0)throw new Error('Unknown synthetic task cursor '+cursor);
  const items=structuredClone(s.workflowTasks.slice(start,start+20)),hasMore=start+items.length<s.workflowTasks.length;
  const result:TaskPage={project_id:ids.root,items,page:{has_more:hasMore,next_cursor:hasMore?'desktop-after:'+items.at(-1)!.run_id:null}};
  expect(Value.Check(schemas.ProjectTasksResponse,result)).toBe(true);return result;
}
export function addHead(s:State){
  const task:Task={...structuredClone(s.workflowTasks[0]),run_id:'desktop-file-new-head',created_at:new Date(Date.parse(now)+60_000).toISOString(),
    updated_at:new Date(Date.parse(now)+60_000).toISOString(),state:'running',stage:'model_generation',artifact_id:null};
  s.workflowTasks.unshift(task);validateTasks(s);return task;
}
export function latest(s:State,type:ProjectFileVersion['document_type']){const values=s.registry.filter(v=>v.latest&&v.document_type===type);expect(values).toHaveLength(1);return values[0];}
export async function install(page:Page,s=fixture()){
  await installReturn(page,s);
  await page.route('**/api/v1/**',async route=>{
    const req=route.request(),url=new URL(req.url()),path=url.pathname.slice('/api/v1'.length);
    if(req.method()!=='GET'||path!=='/projects/'+ids.root+'/tasks')return route.fallback();
    s.calls.push({owner:s.owner,method:'GET',path,search:url.search,body:null});
    if(!s.authenticated||s.owner!==ids.owner)return fail(route,401);
    const cursor=url.searchParams.get('cursor');
    try{
      expect([...url.searchParams.keys()]).toEqual(cursor?['cursor']:[]);
      const response=pageFor(s,cursor),shouldFail=s.taskPageFailures.has(cursor??''),owner=s.owner;
      if(cursor&&s.taskPageFault==='duplicate'&&response.items.length)response.items[0]=structuredClone(s.workflowTasks[0]);
      expect(Value.Check(schemas.ProjectTasksResponse,response)).toBe(true);
      s.taskPageCalls.push({owner,cursor,runs:response.items.map(t=>t.run_id)});s.taskReads++;
      await s.taskPageGates.get(cursor??'');
      if(shouldFail)return fail(route);
      await json(route,200,response);s.taskPageReplies++;
    }catch(error){s.errors.push(error instanceof Error?error.message:String(error));return fail(route,500);}
  });return s;
}
export async function open(page:Page,s=fixture(),hash=filesHash){
  await page.setViewportSize({width:1440,height:960});await install(page,s);await page.goto('/'+hash);
  await expect(page.locator('#file-list')).toBeVisible();await ready(page);return s;
}
export function assertFixture(s:State){assertReturn(s);validateTasks(s);}
export function noBusiness(s:State){assertReturnNoBusiness(s);}
export function noExecution(s:State){expect(businessCalls(s)).toEqual([]);expect(s.quotes).toEqual([]);expect(s.executions).toEqual([]);expect(s.checkRequests).toEqual([]);expect(s.updatePosts).toEqual([]);assertFixture(s);}
