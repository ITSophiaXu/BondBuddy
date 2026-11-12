import { navigationProjectContext } from './project-navigation.js';

export type AssistantPageProject = { project_id: string; name: string; source_project_id?: string | null };
type TopicPage = { topic: { topic_id: string; project_id: string; source_project_id?: string | null } };
export type AssistantPageReaders = {
  project: (id: string) => Promise<AssistantPageProject>;
  topic: (id: string) => Promise<TopicPage>;
};
const validId = (id: string | null): id is string => !!id && id.length <= 128 && !/[\u0000-\u001f\u007f]/.test(id);

/** The URL selects a read, never an execution identity or authorization. */
export async function readAssistantPageProject(hash: string, read: AssistantPageReaders): Promise<AssistantPageProject | null> {
  const [path, search = ''] = hash.replace(/^#/, '').split('?');
  const query = new URLSearchParams(search);
  // return_project is a navigation hint. Resolve the actual page first, then the
  // server's source relationship; a forged return hint cannot select a project.
  query.delete('return_project');
  let id: string | null = null;
  if (/^\/?generate$/.test(path) && query.has('topic')) {
    if (!validId(query.get('topic'))) return null;
    const topicId = query.get('topic')!;
    const page = await read.topic(topicId);
    if (page.topic.topic_id !== topicId) throw new Error('Page topic mismatch');
    id = page.topic.source_project_id ?? page.topic.project_id;
  } else if (/^\/projects\//.test(path) || /^\/?(?:update|review|generate|integrity|qa|consistency)$/.test(path)) {
    id = navigationProjectContext('#' + path + (query.size ? '?' + query : ''))?.projectId ?? null;
  }
  if (!validId(id)) return null;
  const project = await read.project(id);
  if (project.project_id !== id || !project.name?.trim()) throw new Error('Page project mismatch');
  if (project.source_project_id && project.source_project_id !== id) {
    if (!validId(project.source_project_id)) throw new Error('Invalid source project');
    const source = await read.project(project.source_project_id);
    if (source.project_id !== project.source_project_id || !source.name?.trim()) throw new Error('Source project mismatch');
    return source;
  }
  return project;
}

export type AssistantPageState = { hash: string; status: 'none' | 'loading' | 'ready' | 'unavailable'; project?: AssistantPageProject };
/** Read-only route observer. Late reads never repaint a newer page or conversation. */
export class AssistantPageContext {
  state: AssistantPageState = { hash: '', status: 'none' };
  private generation = 0;
  constructor(private read: AssistantPageReaders, private changed: () => void) {}
  dispose() { this.generation++; }
  current(hash: string) { return this.state.hash === hash && this.state.status === 'ready' ? this.state.project : undefined; }
  async refresh(hash: string, force = false) {
    if (!force && this.state.hash === hash) return;
    const generation = ++this.generation;
    this.state = { hash, status: 'loading' }; this.changed();
    try {
      const project = await readAssistantPageProject(hash, this.read);
      if (generation !== this.generation) return;
      this.state = { hash, status: project ? 'ready' : 'none', ...(project ? { project } : {}) };
    } catch {
      if (generation !== this.generation) return;
      this.state = { hash, status: 'unavailable' };
    }
    this.changed();
  }
}
