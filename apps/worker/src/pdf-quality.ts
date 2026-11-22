import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import {
  PDF_QUALITY_VERSION,
  pdfQualitySamplePages,
  readPdfQuality,
  type PdfQuality,
} from '@bondbuddy/contracts';

/** No model call. The private file was already owner-authorized and hash-verified. */
export function inspectPdfQuality(
  path: string,
  options: { pythonExecutable?: string; repoRoot?: string; timeoutMs?: number } = {},
): Promise<PdfQuality> {
  return new Promise((resolveResult) => {
    const result: PdfQuality = {
      version: PDF_QUALITY_VERSION,
      status: 'unavailable',
      page_count: null,
      checked_pages: 0,
      sampled_pages: [],
      blocking_pages: [],
      low_resolution_pages: [],
    };
    const root = options.repoRoot ?? process.cwd();
    const child = spawn(
      options.pythonExecutable ?? 'python3',
      ['-m', 'bondbuddy_pdf_quality', path],
      {
        cwd: root,
        env: { ...process.env, PYTHONPATH: resolve(root, 'python'), PYTHONIOENCODING: 'utf-8' },
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    );
    let completed = false,
      invalid = false,
      bytes = 0,
      settled = false;
    let plan: number[] = [];
    const timer = setTimeout(() => child.kill('SIGKILL'), options.timeoutMs ?? 5000);
    const lines = createInterface({ input: child.stdout });
    child.stdout.on('data', (chunk) => {
      bytes += chunk.length;
      if (bytes > 8 * 1024) {
        invalid = true;
        child.kill('SIGKILL');
      }
    });
    lines.on('line', (line) => {
      if (invalid) return;
      try {
        const value = JSON.parse(line);
        if (completed) throw Error('Trailing output');
        if (
          Number.isSafeInteger(value.page_count) &&
          value.page_count > 0 &&
          result.page_count === null
        ) {
          result.page_count = value.page_count;
          plan = pdfQualitySamplePages(value.page_count);
        } else if (
          Number.isSafeInteger(value.page) &&
          value.page === plan[result.checked_pages] &&
          !result.blocking_pages!.length &&
          typeof value.blocking === 'boolean' &&
          (!value.blocking || value.dpi !== null) &&
          (value.dpi === null ||
            (Number.isSafeInteger(value.dpi) && value.dpi >= 1 && value.dpi < 200))
        ) {
          result.checked_pages++;
          result.sampled_pages!.push(value.page);
          if (value.dpi !== null)
            result.low_resolution_pages.push({ page: value.page, dpi: value.dpi });
          if (value.blocking) result.blocking_pages!.push(value.page);
        } else if (
          value.complete === true &&
          result.checked_pages > 0 &&
          (result.checked_pages === plan.length || result.blocking_pages!.length > 0)
        )
          completed = true;
        else throw Error('Invalid quality output');
      } catch {
        invalid = true;
        child.kill('SIGKILL');
      }
    });
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      lines.close();
      result.status =
        completed && code === 0 && !invalid
          ? 'complete'
          : result.checked_pages
            ? 'partial'
            : 'unavailable';
      resolveResult(
        readPdfQuality(result) ?? {
          version: PDF_QUALITY_VERSION,
          status: 'unavailable',
          page_count: null,
          checked_pages: 0,
          sampled_pages: [],
          blocking_pages: [],
          low_resolution_pages: [],
        },
      );
    };
    child.on('error', () => finish(null));
    child.on('close', finish);
  });
}
