import { Type, type Static } from '@sinclair/typebox';
export const AUTHORING_ACTIVITY_LABELS = {
  process_document:'正在处理文档',
  read_materials:'正在读取原稿与财务材料', read_knowledge:'正在查阅编制要求',
  analyze:'正在分析材料与更新范围', write_document:'正在编制募集书内容',
  check_document:'正在检查文档排版', prepare_download:'正在生成 Word 文件',
} as const;
export const AuthoringActivitySchema = Type.Object({
  activity_id:Type.String({pattern:'^[a-f0-9]{64}$'}),
  code:Type.Union(Object.keys(AUTHORING_ACTIVITY_LABELS).map(k=>Type.Literal(k as keyof typeof AUTHORING_ACTIVITY_LABELS))),
  state:Type.Union(['started','completed','failed'].map(s=>Type.Literal(s))),
  summary:Type.Optional(Type.String({minLength:1,maxLength:240})),
}, {additionalProperties:false});
export type AuthoringActivity = Static<typeof AuthoringActivitySchema>;
const utc = Type.String({ pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$' });
export const AuthoringProgressSchema=Type.Object({
  policy:Type.Union([Type.Literal('authoring_balance_v2'),Type.Literal('authoring_progress_v1'),Type.Literal('on_delivery')]),
  accrued_points:Type.Integer({minimum:0}), charged_points:Type.Integer({minimum:0}),
  released_points:Type.Integer({minimum:0}), active_ms:Type.Integer({minimum:0}),
  credit_exhausted:Type.Optional(Type.Boolean()), available_points:Type.Optional(Type.Integer({minimum:0})),
  pause_requested:Type.Boolean(), queued_at:utc, sampled_at:utc,
  last_activity_at:Type.Union([utc,Type.Null()]),
  queue_ahead:Type.Union([Type.Integer({minimum:0}),Type.Null()]),
  clock_running:Type.Boolean(),
},{additionalProperties:false});
export type AuthoringProgress=Static<typeof AuthoringProgressSchema>;
