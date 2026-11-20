import { execFile } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const repo = resolve(fileURLToPath(import.meta.url), '../../../..');
const reasons = new Set(['renderer_missing', 'renderer_failed', 'renderer_process_failed', 'render_timeout',
  'render_output_missing', 'render_output_invalid', 'render_pdf_unreadable', 'probe_page_count_invalid', 'baseline_invalid']);
type RendererDiagnostic = { stderr_category?: string; exit_code?: number };

export class HostWordRendererError extends Error {
  constructor(public readonly code: 'WORD_RENDERER_PROBE_FAILED' | 'WORD_RENDERER_REPORT_INVALID' | 'WORD_RENDERER_UNAVAILABLE',
    public readonly reason?: string, public readonly diagnostic: RendererDiagnostic = {}) {
    super(code + (reason ? ':' + reason : '') + (diagnostic.stderr_category ? ':' + diagnostic.stderr_category : '')
      + (diagnostic.exit_code === undefined ? '' : ':exit=' + diagnostic.exit_code));
    this.name = 'HostWordRendererError';
  }
}

/** Probe the installed host package on synthetic content before recording a provider intent.
 * This does not certify the eventual document: finalization still renders both manuscripts.
 */
export async function verifyHostWordRenderer(baselinePath?: string, signal?: AbortSignal): Promise<void> {
  let stdout: string;
  let exit = 0;
  try {
    ({ stdout } = await promisify(execFile)(
      process.env.BONDBUDDY_WORD_PYTHON ?? process.env.BONDBUDDY_TEST_PYTHON ?? 'python3',
      ['-B', '-s', '-m', 'bondbuddy_file_authoring.document_size', ...(baselinePath ? ['--source', baselinePath] : [])],
      { cwd: repo, env: { ...process.env, PYTHONPATH: join(repo, 'python'), PYTHONIOENCODING: 'utf-8' },
        timeout: 105_000, maxBuffer: 16 * 1024, signal }));
  } catch (error) {
    if (signal?.aborted) throw error;
    const failure = error as { code?: unknown; signal?: unknown; killed?: boolean; stdout?: unknown };
    if (failure.code !== 1 || failure.signal != null || failure.killed === true || typeof failure.stdout !== 'string')
      throw new HostWordRendererError('WORD_RENDERER_PROBE_FAILED');
    stdout = failure.stdout; exit = 1;
  }
  let report: Record<string, unknown>;
  try { report = JSON.parse(stdout); } catch { throw new HostWordRendererError('WORD_RENDERER_REPORT_INVALID'); }
  if (!report || typeof report !== 'object' || Array.isArray(report) || report.version !== 'word-renderer-capability-v1')
    throw new HostWordRendererError('WORD_RENDERER_REPORT_INVALID');
  if (exit === 0 && report.status === 'ready' && report.renderer === 'LibreOffice' && report.pages === 1) return;
  if (exit === 0 && baselinePath && report.status === 'not_required' && report.reason === 'short_source') return;
  if (exit === 1 && report.status === 'unavailable' && typeof report.reason === 'string' && reasons.has(report.reason)) {
    const diagnostic: RendererDiagnostic = {};
    if (report.diagnostic && typeof report.diagnostic === 'object' && !Array.isArray(report.diagnostic)) {
      const detail = report.diagnostic as Record<string, unknown>;
      if (['proc_access_denied', 'filesystem_access_denied', 'dependency_missing', 'unclassified', 'empty'].includes(String(detail.stderr_category)))
        diagnostic.stderr_category = String(detail.stderr_category);
      if (Number.isSafeInteger(detail.exit_code) && Number(detail.exit_code) >= -128 && Number(detail.exit_code) <= 255)
        diagnostic.exit_code = Number(detail.exit_code);
    }
    throw new HostWordRendererError('WORD_RENDERER_UNAVAILABLE', report.reason, diagnostic);
  }
  throw new HostWordRendererError('WORD_RENDERER_REPORT_INVALID');
}
