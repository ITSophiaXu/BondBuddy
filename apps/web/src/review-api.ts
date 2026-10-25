import type { ReviewWorkspace, ReviewDraftRequest, ReviewMessageRequest, ReviewMessage, ReviewPlanRequest, ReviewPlan, ReviewExecutionRequest, ReviewHistoryEntry, ReviewProposalAdoptionRequest, ReviewProposalAdoptionResponse, Run } from '@bondbuddy/contracts';
import { isReviewReport } from '@bondbuddy/contracts';
import { ApiClient, ApiError, type Dto } from './api.js';
import type { ReviewUpdateRequest } from '@bondbuddy/contracts';

/** All M3 endpoint mapping lives here; identity, CSRF and refresh stay in ApiClient. */
export class ReviewApi {
  constructor(readonly api: ApiClient, readonly projectId: string, readonly signal?: AbortSignal) {}
  private path(name: string) { return `/projects/${encodeURIComponent(this.projectId)}/${name}`; }
  async workspace(reportId?: string): Promise<ReviewWorkspace> {
    const result = await this.api.request<ReviewWorkspace>('GET', this.path('review-workspace') + (reportId ? `?report_id=${encodeURIComponent(reportId)}` : ''), undefined, {}, this.signal);
    if (result.project?.project_id !== this.projectId ||
      !Array.isArray(result.materials) || !Array.isArray(result.messages) || !Array.isArray(result.message_drafts) || !Array.isArray(result.reports) || !Array.isArray(result.artifacts) ||
      !Number.isInteger(result.draft?.version) || result.draft.version < 0 ||
      result.selected_report && (!isReviewReport(result.selected_report) || result.selected_report.project_id !== this.projectId || reportId && result.selected_report.report_id !== reportId) ||
      result.active_run && result.active_run.project_id !== this.projectId ||
      result.messages.some(m => m.context.project_id !== this.projectId) || result.message_drafts.some(m => m.context.project_id !== this.projectId) ||
      result.timeline?.some(item=>item.kind==='message'?item.message.context.project_id!==this.projectId:item.task.run.project_id!==this.projectId||item.task.events.some(event=>event.run_id!==item.task.run.run_id))) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return result;
  }
  drafts() { return this.api.request<Pick<ReviewWorkspace, 'draft' | 'message_drafts'>>('GET', this.path('review-draft'), undefined, {}, this.signal); }
  saveDraft(input: ReviewDraftRequest) { return this.api.request<unknown>('PUT', this.path('review-draft'), input, {}, this.signal); }
  send(input: ReviewMessageRequest) { return this.api.request<{ message: ReviewMessage }>('POST', this.path('review-messages'), input, {}, this.signal); }
  plan(input: ReviewPlanRequest) { return this.api.request<ReviewPlan>('PUT', this.path('revision-plan'), input, {}, this.signal); }
  adopt(input: ReviewProposalAdoptionRequest) { return this.api.request<ReviewProposalAdoptionResponse>('POST',this.path('review-proposal-adoptions'),input,{},this.signal); }
  quoteExecution(input: ReviewExecutionRequest) { return this.api.request<Dto<'FixedQuoteResponse'>>('POST',this.path('review-executions/quote'),input,{},this.signal); }
  quoteUpdate(input: ReviewUpdateRequest) { return this.api.request<Dto<'FixedQuoteResponse'>>('POST',this.path('review-updates/quote'),input,{},this.signal); }
  execute(input: ReviewExecutionRequest) { return this.api.request<Run>('POST', this.path('review-executions'), input, {}, this.signal); }
  updateFromReview(input: ReviewUpdateRequest) { return this.api.request<Run>('POST', this.path('review-updates'), input, {}, this.signal); }
  async history() {
    const result = await this.api.request<{ items: ReviewHistoryEntry[] }>('GET', this.path('review-history'), undefined, {}, this.signal);
    if (!Array.isArray(result.items) || result.items.some(item => item.run.project_id !== this.projectId || item.report_id && typeof item.report_id !== 'string')) throw new ApiError(0, 'DATA_UNAVAILABLE');
    return result;
  }
}
