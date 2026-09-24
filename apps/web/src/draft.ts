import { ApiError, type ApiClient, type Dto } from './api';

export type DraftFields = { name: string; issuer_name: string };
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
    this.fields = { name: project.name, issuer_name: project.issuer_name ?? '' };
  }
  get dirty() { return this.fields.name !== this.project.name || this.fields.issuer_name !== (this.project.issuer_name ?? ''); }
  get valid() { return this.fields.name.trim().length > 0 && this.fields.name.length <= 120; }
  edit(fields: DraftFields) {
    this.fields = fields;
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
      const sent = { ...this.fields };
      try {
        const result = await this.api.patch(this.project.project_id, this.project.draft_revision, {
          name: sent.name, issuer_name: sent.issuer_name || null
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
