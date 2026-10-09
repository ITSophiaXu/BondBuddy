/** Stable business filename derived only from the delivered artifact's locked metadata. */
export function resultFilename(input: { project?: string | null; kind?: string | null; version?: number | null; createdAt?: string | Date | null; mediaType: string }): string {
  const text = (value: string | null | undefined, fallback: string, budget: number) => {
    const cleaned = (value ?? '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '_').replace(/\s+/g, ' ').replace(/^[ ._]+|[ ._]+$/g, '');
    let result = '';
    for (const char of cleaned) { if (new TextEncoder().encode(result + char).length > budget) break; result += char; }
    return result.replace(/[ .]+$/g, '') || fallback;
  };
  const extensions: Record<string, string> = {
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document':'docx',
    'application/pdf':'pdf', 'text/plain':'txt', 'application/json':'json',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'xlsx', 'text/csv':'csv', 'application/zip':'zip'
  };
  const date = input.createdAt ? new Date(input.createdAt) : null;
  const stamp = date && Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('sv-SE', { timeZone:'Asia/Shanghai', year:'numeric', month:'2-digit', day:'2-digit' }).format(date).replaceAll('-','') : '日期未记录';
  const version = Number.isSafeInteger(input.version) && input.version! > 0 ? input.version : 1;
  return text(input.project,'项目成果',96) + '_' + text(input.kind,'成果',60) + '_V' + version + '_' + stamp + '.' + (extensions[input.mediaType.split(';')[0].trim()] ?? 'bin');
}
