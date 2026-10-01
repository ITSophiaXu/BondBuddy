import { ApiError, type ApiClient, type Dto } from './api.js';
import { Value } from '@sinclair/typebox/value';
import { draftFromProject, projectKind, validateDraft, type ProjectCreate } from './form-model.js';
import type { UpdateDetails, Market, Offering } from '@bondbuddy/contracts';

export type DraftFields = { name: string; issuer_name: string; market: Market | null; offering: Offering | null; update_details: UpdateDetails };
export function fieldsFromProject(project: Dto<'ProjectResponse'>): DraftFields {
  const value = draftFromProject(project);
  return { name: value.name, issuer_name: value.issuer_name ?? '', market: value.market, offering: value.offering, update_details: value.update_details! };
}
export function createFromFields(fields: DraftFields): ProjectCreate { return { ...structuredClone(fields), kind: projectKind(fields.update_details.has_historical), issuer_name: fields.issuer_name || null }; }
export type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error';

/** One serialized writer per open project. No background retries after conflict/network failure. */
export class Draft {
  fields: DraftFields;
  state: SaveState = 'saved';
  error: unknown;
  private timer?: ReturnType<typeof setTimeout>;
  private pending?: Promise<boolean>;
  private disposed = false;
  constructor(public project: Dto<'ProjectResponse'>, private api: ApiClient, private changed: () => void) {
    this.fields = fieldsFromProject(project);
  }
  get dirty() { return !Value.Equal(this.fields, fieldsFromProject(this.project)); }
  get validationErrors() { return this.fields.name.trim() ? validateDraft(createFromFields(this.fields)) : ['请填写项目名称。']; }
  get valid() { return this.validationErrors.length === 0; }
  edit(fields: Partial<DraftFields>) {
    this.fields = { ...this.fields, ...structuredClone(fields) };
    clearTimeout(this.timer);
    if (!['conflict', 'error', 'saving'].includes(this.state)) this.state = this.dirty ? 'dirty' : 'saved';
    this.changed();
    if (this.state === 'dirty' && this.valid) this.timer = setTimeout(() => { void this.save(); }, 800);
  }
  save(): Promise<boolean> {
    clearTimeout(this.timer);
    if (this.pending) return this.pending;
    if (this.disposed || this.state === 'conflict' || !this.valid) return Promise.resolve(false);
    if (!this.dirty) { this.state = 'saved'; this.changed(); return Promise.resolve(true); }
    const task = this.persist();
    this.pending = task;
    void task.finally(() => { if (this.pending === task) this.pending = undefined; });
    return task;
  }
  private async persist(): Promise<boolean> {
    // Edits during a request are saved only after its new server revision is known.
    while (this.dirty && !this.disposed) {
      if (!this.valid) { this.state = 'dirty'; this.changed(); return false; }
      this.state = 'saving'; this.error = undefined; this.changed();
      const sent = structuredClone(this.fields);
      try {
        const result = await this.api.patch(this.project.project_id, this.project.draft_revision, {
          ...sent, issuer_name: sent.issuer_name || null
        });
        if (this.disposed) return false;
        this.project = result;
      } catch (error) {
        if (this.disposed) return false;
        this.error = error;
        this.state = error instanceof ApiError && error.status === 409 ? 'conflict' : 'error';
        this.changed(); return false;
      }
    }
    if (this.disposed) return false;
    this.state = 'saved'; this.changed(); return true;
  }
  dispose() { this.disposed = true; clearTimeout(this.timer); }
}
