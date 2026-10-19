import { workFor } from './work-model.js';
import { templateFor } from './templates.js';
import { pendingIssues } from './consistency-model.js';
import type { DesignState, Project, Job } from './model.js';
export const TASK_KINDS = { update: '更新募集书', review: '复核募集书', generation: '文件生成', integrity: '诚信核查', qa: '项目问答', consistency: '文件一致性检查' };
export type DashboardItem = { id: string; project: string; kind: Job['kind']; group: 'attention' | 'active' | 'done'; title: string; time: string; url: string; detail: string; label: string; action: string };
export function dashboardItems(state: DesignState, project?: Project): DashboardItem[] {
  const projects = project ? [project] : state.projects, items: DashboardItem[] = [];
  const href = (kind: string, p: Project, step: string) => `#${kind === 'generation' ? 'generate' : kind}?project=${encodeURIComponent(p.id)}&step=${step}`;
  for (const p of projects) {
    const jobs = state.jobs.filter(j => j.projectId === p.id);
    for (const j of jobs) {
      if (j.consistency) {
        const latest = jobs.find(x => x.kind === 'consistency')?.id === j.id;
        const pending = j.consistency.snapshot.files.filter(f => pendingIssues(j,f).length).length;
        const manual = j.consistency.snapshot.files.filter(f => f.status === 'manual').length;
        const checking = j.consistency.phase === 'checking', attention = latest && (pending > 0 || manual > 0);
        items.push({ id:j.id, project:p.name, kind:j.kind, group:checking ? 'active' : attention ? 'attention' : 'done', title:'文件一致性检查', time:j.createdAt, url:`#consistency?project=${p.id}&job=${j.id}`, detail:checking ? `${j.consistency.snapshot.files.length} 份文件 · 本地演示进度` : `${pending} 份待更新 · ${manual} 份需人工确认`, label:checking ? '正在检查 · 演示' : !latest ? '已归档 · 演示' : attention ? '待确认 · 演示' : '已完成 · 演示', action:checking ? '查看进度' : attention ? '查看文件冲突' : '查看结果' });
        continue;
      }
      const missing = j.qa?.questions.filter(q => q.status === 'missing').length ?? 0;
      const superseded = j.kind === 'qa' && jobs.find(x => x.kind === 'qa')?.id !== j.id;
      const awaiting = missing > 0 && !superseded;
      items.push({ id: j.id, project: p.name, kind: j.kind, group: awaiting ? 'attention' : 'done', title: `${TASK_KINDS[j.kind]} · 第 ${jobs.filter(x => x.kind === j.kind).length - jobs.filter(x => x.kind === j.kind).findIndex(x => x.id === j.id)} 轮`, time: j.createdAt, url: `${href(j.kind, p, 'result')}&job=${j.id}`, detail: awaiting ? `${missing} 个问题待补材料 · 回答草稿已归档` : `${j.fileIds.length} 份设计示例 · 已归入项目文件`, label: awaiting ? '待补材料 · 演示' : superseded ? '已归档 · 演示' : '已完成 · 演示', action: awaiting ? '补充材料' : '查看结果' });
    }
    const draft = (kind: Job['kind'], time: string, step: string, detail: string) => items.push({ id: `${p.id}-draft-${kind}`, project: p.name, kind, group: 'attention', title: `${TASK_KINDS[kind]} · 草稿`, time, url: href(kind, p, step), detail, label: '草稿', action: '继续填写' });
    for (const k of ['update', 'review'] as const) {
      const d = workFor(p)[k], last = jobs.find(j => j.kind === k);
      if (d.touchedAt && (!last || d.touchedAt > last.createdAt)) draft(k, d.touchedAt, k === 'update' && !d.sourceId ? 'details' : 'materials', '已保存，可继续填写材料与要求');
    }
    const generation = jobs.find(j => j.kind === 'generation'), files = p.files.filter(f => generation?.fileIds.includes(f.id));
    if ((p.draft.sourceId || p.draft.selected.length) && (!generation || files.length !== p.draft.selected.length || files.some(f => f.sourceId !== p.draft.sourceId || !p.draft.selected.includes(f.type) || f.requirements !== p.draft.requirements || f.template?.id !== templateFor(p, f.type)?.id))) draft('generation', p.updatedAt, p.draft.sourceId ? 'materials' : 'source', `${p.draft.selected.length} 类已选文件，可继续准备模板`);
    const integrity = jobs.find(j => j.kind === 'integrity')?.integrity;
    if (p.draft.subjects.length && (!integrity || JSON.stringify(p.draft.subjects) !== JSON.stringify(integrity.subjects) || p.draft.integrity?.notes !== integrity.notes || [...(p.draft.integrity?.siteIds ?? [])].sort().join() !== integrity.sites.map(s => s.id).sort().join())) draft('integrity', p.updatedAt, 'subjects', `${p.draft.subjects.length} 个已保存对象，可准备下一轮`);
    const qa = p.qa, lastQA = jobs.find(j => j.kind === 'qa');
    if (qa?.touchedAt && (!lastQA || qa.touchedAt > lastQA.createdAt)) draft('qa', qa.touchedAt, 'workspace', '问题清单与补充材料已保存');
  }
  return items.sort((a, b) => b.time.localeCompare(a.time));
}
