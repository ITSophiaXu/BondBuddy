export type KnowledgeCase = { id: string; title: string; url: string; topic: string; approach: string; status: 'pending' | 'reference'; sample?: boolean };
import { newId, type DesignState, type Project, type Job } from './model.js';
import type { WordParagraph } from './word-export.js';
export type QAQuestion = { id: string; question: string; answer: string; status: 'draft' | 'missing'; materials: string; basis: string };
export type QADraft = { fileId: string; attachments: string[]; questions: QAQuestion[]; messages: { role: 'user' | 'assistant'; text: string }[]; useKnowledge: boolean; touchedAt?: string };
export type QASnapshot = { fileName: string; questions: QAQuestion[]; attachments: string[]; useKnowledge: boolean; simulated: true };
export function qaFor(p: Project): QADraft { return p.qa ??= { fileId: '', attachments: [], questions: [], messages: [], useKnowledge: true }; }
export function qaTouch(p: Project) { qaFor(p).touchedAt = p.updatedAt = new Date().toISOString(); }
export function validateQAFile(file: Pick<File, 'name' | 'size'>, supplement = false) {
  if (!(supplement ? /\.(docx|doc|pdf|xlsx)$/i : /\.(docx|doc)$/i).test(file.name)) throw new Error(supplement ? '请补充 Word、PDF 或 Excel 材料。' : '请上传 Word 问题清单（DOCX / DOC）。');
  if (file.size <= 0 || file.size > 100 * 1024 * 1024) throw new Error('文件不能为空，且单份不超过 100 MB。');
}
export function addQAFile(p: Project, file: Pick<File, 'name' | 'size'>, supplement = false) {
  validateQAFile(file, supplement);
  const f = { id: newId(), type: supplement ? 'source' : 'qa-input', name: file.name, folder: 'sources' as const, origin: 'upload' as const, size: file.size, version: 1, createdAt: new Date().toISOString() };
  p.files.push(f); const d = qaFor(p);
  if (supplement) d.attachments.push(f.id); else { d.fileId = f.id; d.questions = []; }
  qaTouch(p); return f;
}
export function exampleQuestions(): QAQuestion[] {
  return [
    { id: newId(), question: '请说明本期募集资金用途，以及相应的偿债安排。', answer: '【回答草稿示例】本期募集资金拟用于偿还到期有息债务。应逐项列明债权人、余额、到期日与拟偿还金额，并说明与本期发行规模的对应关系。具体金额须以本项目债务清单及募集说明书为准。', status: 'draft', materials: '', basis: '合成问答示例：说明用途 → 列明细 → 核对规模 → 解释偿债安排。' },
    { id: newId(), question: '请说明非经营性往来占款的形成原因、回收安排及回收风险。', answer: '【待补充材料】目前无法判断款项可回收性。请补充非经营性往来占款明细、交易背景及最近一期回款记录，确认后完善形成原因、回收安排和风险提示。', status: 'missing', materials: '非经营性往来占款明细；交易背景说明；回款计划与最近一期回款凭证。', basis: '不能用其他公募案例的事实或结论替代本项目证据。' },
    { id: newId(), question: '请说明报告期经营活动现金流净额变化的原因。', answer: '【待补充材料】尚缺现金流量表及变动分析。需按回款、采购支付及其他经营收支解释变动，并与财务附注核对。', status: 'missing', materials: '报告期现金流量表；其他经营收支明细；大额变动说明。', basis: '回答思路示例：按期间列变化 → 拆分驱动因素 → 与科目和附注勾稽。' },
  ];
}
export function runQAPreview(state: DesignState, p: Project): Job {
  const d = qaFor(p), source = p.files.find(f => f.id === d.fileId && f.type === 'qa-input');
  if (!source) throw new Error('请先上传本项目的 Word 问题清单，或使用示例清单。');
  if (!d.questions.length || d.questions.some(q => !q.question.trim())) throw new Error('请先准备问题清单，并填写每个问题。');
  if (d.attachments.some(id => !p.files.some(f => f.id === id))) throw new Error('补充材料不属于当前项目。');
  const questions = structuredClone(d.questions).map(q => q.status === 'missing' || !q.answer.trim() ? { ...q, status: 'missing' as const, answer: q.answer || '【暂无法回答】请补充资料后继续。', materials: q.materials.trim() || '与本问题相关的原始依据和业务说明（需人工确认具体清单）。' } : q);
  const snapshot: QASnapshot = { fileName: source.name, questions, attachments: d.attachments.map(id => p.files.find(f => f.id === id)!.name), useKnowledge: d.useKnowledge, simulated: true };
  const job: Job = { id: newId(), projectId: p.id, kind: 'qa', createdAt: new Date().toISOString(), fileIds: [], qa: structuredClone(snapshot) };
  const f = { id: newId(), type: 'qa-answer', name: source.name.replace(/\.docx?$/i, '') + '_已回填回答（设计示例）.docx', folder: '4.2' as const, version: Math.max(0, ...p.files.filter(f => f.type === 'qa-answer').map(f => f.version)) + 1, createdAt: job.createdAt, origin: 'qa' as const, jobId: job.id, qa: structuredClone(snapshot) };
  p.files.push(f); job.fileIds.push(f.id); state.jobs.unshift(job); p.updatedAt = job.createdAt;
  d.messages.push({ role: 'assistant', text: `已准备 ${questions.length} 个问题的回填示例，其中 ${questions.filter(q => q.status === 'missing').length} 个问题待补材料。问题、回答、依据和待补清单均已写入 Word 示例，可在右侧预览下载。` });
  return job;
}
export function qaParagraphs(snapshot: QASnapshot): WordParagraph[] {
  return [{ text: '问题清单：' + snapshot.fileName }, ...snapshot.questions.flatMap((q, i) => [
    { text: `${i + 1}. ${q.question}`, heading: true }, { text: q.answer || '【待回答】' },
    ...(q.status === 'missing' ? [{ text: '【待补材料 / 暂无法定稿】' + q.materials }] : []),
    { text: '回答依据 / 思路：' + q.basis },
  ]), { text: '公募案例知识库：' + (snapshot.useKnowledge ? '已选择参考回答思路（本轮为静态示例，未检索真实知识库）。' : '本轮未选用。') }];
}
