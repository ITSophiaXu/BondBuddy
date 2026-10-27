import {Type,type Static} from '@sinclair/typebox';
const obj=<T extends Parameters<typeof Type.Object>[0]>(p:T)=>Type.Object(p,{additionalProperties:false});
const id=Type.String({minLength:1,maxLength:128});
export const WORKPAPER_LIMITS={fileBytes:10*1024*1024,items:1000,rows:10000,sheets:30} as const;
export const WorkpaperEntrySchema=obj({id,code:Type.String({maxLength:100}),title:Type.String({minLength:1,maxLength:300}),
  folder:Type.String({maxLength:600}),instructions:Type.String({maxLength:2000}),sheet:Type.String({maxLength:200}),row:Type.Integer({minimum:1}),
  kind:Type.Union([Type.Literal('file'),Type.Literal('folder')]),path:Type.String({minLength:1,maxLength:1000})});
export type WorkpaperEntry=Static<typeof WorkpaperEntrySchema>;
export const WorkpaperTaskSchema=obj({batch_id:id,catalogue_id:id,entry:WorkpaperEntrySchema});
export type WorkpaperTask=Static<typeof WorkpaperTaskSchema>;
