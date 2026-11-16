import {Value} from '@sinclair/typebox/value';
import {
  AdminPerformanceRunResponseSchema, AdminPerformanceSummaryResponseSchema, PERFORMANCE_FILTERS,
  type AdminPerformanceRunResponse, type AdminPerformanceSummaryResponse,
} from '@bondbuddy/contracts';
import {ApiClient, ApiError} from './api.js';
import './schema-formats.js';

/** These reads have their own server-side scope; never derive them from inspection snapshots. */
export const performanceFilterNames = PERFORMANCE_FILTERS;
export type PerformanceFilters = Record<typeof performanceFilterNames[number], string>;
export const emptyPerformanceFilters = (): PerformanceFilters => Object.fromEntries(performanceFilterNames.map(name => [name, ''])) as PerformanceFilters;

export function performanceQuery(filters: PerformanceFilters): string {
  const query = new URLSearchParams();
  for (const name of performanceFilterNames) {
    const value = filters[name].trim();
    if (!value) continue;
    // The date controls are explicitly Beijing dates, independent of browser timezone.
    query.set(name, name === 'from' ? new Date(value + 'T00:00:00+08:00').toISOString()
      : name === 'to' ? new Date(value + 'T23:59:59.999+08:00').toISOString() : value);
  }
  return query.toString();
}

export class AdminPerformanceApi {
  constructor(private readonly api: Pick<ApiClient, 'request'>) {}

  async run(runId: string, cursor?: string): Promise<AdminPerformanceRunResponse> {
    const query = new URLSearchParams({limit: '200'});
    if (cursor) query.set('cursor', cursor);
    const response = await this.api.request<unknown>('GET', `/admin/performance/runs/${encodeURIComponent(runId)}?${query}`);
    if (!Value.Check(AdminPerformanceRunResponseSchema, response) || response.run_id !== runId) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return response;
  }

  async summary(filters: PerformanceFilters): Promise<AdminPerformanceSummaryResponse> {
    const response = await this.api.request<unknown>('GET', `/admin/performance/summary?${performanceQuery(filters)}`);
    if (!Value.Check(AdminPerformanceSummaryResponseSchema, response) || response.scope.full_filtered_scope !== true) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return response;
  }
}
