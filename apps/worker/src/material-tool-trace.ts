import { createHash } from 'node:crypto';
import type { MaterialToolData } from './authoring-material-tools.js';

/** Host-authored read evidence; an agent's stdout never establishes a material read. */
export type MaterialToolTrace = {
  version: 'material-tool-trace-v1';
  data_sha256: string;
  read_record_ids: string[];
};
export type MaterialModelEnvelope = {
  version: 'material-tool-result-v1';
  model_output: unknown;
  tool_trace: MaterialToolTrace;
};
export function materialToolDataHash(data: MaterialToolData): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex');
}
export function createMaterialToolTrace(data: MaterialToolData): MaterialToolTrace {
  const materials = new Set<string>(), records = new Set<string>();
  for (const material of data.materials) {
    if (materials.has(material.id)) throw Error('MATERIAL_TOOL_IDS_AMBIGUOUS');
    materials.add(material.id);
    for (const record of material.records) {
      if (records.has(record.id)) throw Error('MATERIAL_TOOL_IDS_AMBIGUOUS');
      records.add(record.id);
    }
  }
  return { version: 'material-tool-trace-v1', data_sha256: materialToolDataHash(data), read_record_ids: [] };
}
export function validateMaterialToolTrace(data: MaterialToolData, value: unknown): value is MaterialToolTrace {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const trace = value as MaterialToolTrace;
  if (Object.keys(trace).sort().join(',') !== 'data_sha256,read_record_ids,version'
    || trace.version !== 'material-tool-trace-v1' || trace.data_sha256 !== materialToolDataHash(data)
    || !Array.isArray(trace.read_record_ids)) return false;
  try { createMaterialToolTrace(data); } catch { return false; }
  const ids = new Set(data.materials.flatMap(m => m.records.map(r => r.id)));
  return new Set(trace.read_record_ids).size === trace.read_record_ids.length
    && trace.read_record_ids.every(id => typeof id === 'string' && ids.has(id));
}
export function recordMaterialToolRead(trace: MaterialToolTrace, tool: string, output: unknown): void {
  if (!['search_material', 'read_records'].includes(tool)) return;
  const records = (output as { records: { id: string }[] }).records;
  trace.read_record_ids = [...new Set([...trace.read_record_ids, ...records.map(r => r.id)])].sort();
}
export function isMaterialModelEnvelope(value: unknown, data: MaterialToolData): value is MaterialModelEnvelope {
  const envelope = value as MaterialModelEnvelope | null;
  return !!envelope && envelope.version === 'material-tool-result-v1'
    && Object.hasOwn(envelope, 'model_output') && validateMaterialToolTrace(data, envelope.tool_trace);
}
