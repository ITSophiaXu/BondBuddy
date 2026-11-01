// Run lifecycle states are shared by public run DTOs, project projections, operator
// dashboards and filters. Kept in a leaf module so operator contracts can import the
// enum without a circular dependency on the aggregate index.
export const RUN_STATES = ['preparing', 'rejected', 'queued', 'running', 'awaiting_input', 'paused', 'validating', 'delivering', 'settlement_pending', 'succeeded', 'test_completed', 'failed', 'cancelled'] as const;
export type RunState = typeof RUN_STATES[number];
