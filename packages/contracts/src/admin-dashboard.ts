import {Type, type Static, type TSchema} from '@sinclair/typebox';
import {Int64Schema} from './billing-integers.js';
import {RUN_STATES} from './run-states.js';

// #448 operator-only read models. One row per user and one row per task, with
// usage/cost/credit totals aggregated from the existing append-only sources.
// Phone numbers are never exposed: only the last four digits leave the API.
const obj = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, {additionalProperties: false});
const id = Type.String({minLength: 1, maxLength: 128, pattern: '^[A-Za-z0-9_-]{1,128}$'});
const utc = Type.String({pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$'});
const date = Type.String({pattern: '^\\d{4}-\\d{2}-\\d{2}$', description: 'UTC calendar day.'});
const nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);
const count = Type.Integer({minimum: 0});
const runState = Type.Union(RUN_STATES.map(state => Type.Literal(state)));
// Costs are canonical decimal text with exactly ten fractional digits, matching
// bb_platform_cost_ledger round(...,10). Zero is a known measured zero; null means
// no priced attempt (or mixed currencies, see currency).
const cost = Type.String({pattern: '^(0|[1-9][0-9]{0,17})\\.[0-9]{10}$', description: 'Platform cost decimal text; never a floating-point JSON number.'});
const currency = Type.String({minLength: 3, maxLength: 3, pattern: '^[A-Z]{3}$', description: 'Single currency of all priced attempts; null when unpriced or mixed.'});
const maskedPhone = Type.String({pattern: '^\\*{4}[0-9]{4}$', description: 'Last four digits only; never the full phone number.'});
const cursor = Type.String({minLength: 1, maxLength: 512});
const taskKind = Type.String({minLength: 1, maxLength: 64, pattern: '^[a-z][a-z0-9_-]{0,63}$'});
const pricingStatus = Type.Union(['priced', 'rate_missing', 'unknown'].map(value => Type.Literal(value)));
const errorCode = Type.String({pattern: '^[A-Z][A-Z0-9_]{0,63}$'});
const stateCount = obj({state: runState, count});

const range = obj({from: nullable(utc), to: nullable(utc)});

export const AdminDashboardRangeSchema = obj({
  from: Type.Optional(Type.Union([date, utc])),
  to: Type.Optional(Type.Union([date, utc])),
  user_id: Type.Optional(id),
  state: Type.Optional(runState),
  cursor: Type.Optional(cursor),
  limit: Type.Optional(Type.Integer({minimum: 1, maximum: 100, default: 20}))
});
export type AdminDashboardRange = Static<typeof AdminDashboardRangeSchema>;

const AdminDashboardUserSchema = obj({
  user_id: id,
  phone_masked: nullable(maskedPhone),
  status: Type.Union([Type.Literal('active'), Type.Literal('disabled')]),
  created_at: utc,
  projects: count,
  runs: count,
  runs_by_state: Type.Array(stateCount, {maxItems: RUN_STATES.length}),
  last_run_at: nullable(utc),
  model_attempts: count,
  input_tokens: count,
  output_tokens: count,
  cost_amount: nullable(cost),
  currency: nullable(currency),
  credit_settled_points: Int64Schema
});

const AdminDashboardTaskSchema = obj({
  run_id: id,
  user_id: id,
  phone_masked: nullable(maskedPhone),
  project_id: id,
  project_name: Type.String({maxLength: 2000}),
  task_kind: taskKind,
  state: runState,
  stage: nullable(Type.String({maxLength: 64, pattern: '^[a-z][a-z0-9_-]{0,63}$'})),
  created_at: utc,
  updated_at: utc,
  duration_ms: nullable(count),
  model_attempts: count,
  input_tokens: count,
  output_tokens: count,
  cost_amount: nullable(cost),
  currency: nullable(currency),
  pricing_status: nullable(pricingStatus),
  last_error_code: nullable(errorCode),
  credit_settled_points: Int64Schema
});

export const adminDashboardSchemas = {
  AdminDashboardRange: AdminDashboardRangeSchema,
  AdminDashboardOverviewResponse: obj({
    range,
    users: count,
    projects: count,
    tasks: count,
    tasks_by_state: Type.Array(stateCount, {maxItems: RUN_STATES.length}),
    model_attempts: count,
    input_tokens: count,
    output_tokens: count,
    cost_amount: nullable(cost),
    currency: nullable(currency),
    credit_settled_points: Int64Schema
  }),
  AdminDashboardUsersResponse: obj({
    items: Type.Array(AdminDashboardUserSchema, {maxItems: 100}),
    next_cursor: nullable(cursor)
  }),
  AdminDashboardTasksResponse: obj({
    items: Type.Array(AdminDashboardTaskSchema, {maxItems: 100}),
    next_cursor: nullable(cursor)
  })
} as const;

export type AdminDashboardOverview = Static<typeof adminDashboardSchemas.AdminDashboardOverviewResponse>;
export type AdminDashboardUser = Static<typeof AdminDashboardUserSchema>;
export type AdminDashboardUsers = Static<typeof adminDashboardSchemas.AdminDashboardUsersResponse>;
export type AdminDashboardTask = Static<typeof AdminDashboardTaskSchema>;
export type AdminDashboardTasks = Static<typeof adminDashboardSchemas.AdminDashboardTasksResponse>;
