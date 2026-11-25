import { readFile } from 'node:fs/promises';
import { parentPort, workerData } from 'node:worker_threads';

type PdfPage = {
  view: number[];
  getOperatorList(): Promise<{ fnArray: number[]; argsArray: unknown[][] }>;
  cleanup(): void;
};
type PdfDocument = { numPages: number; getPage(page: number): Promise<PdfPage> };

// PDF.js normalizes each image into a unit square. Track the graphics transform
// to distinguish a page scan from ordinary charts, stamps, and logos.
export function scannedPageImageCoverage(
  list: { fnArray: number[]; argsArray: unknown[][] }, ops: Record<string, number>, pageArea: number
): number {
  let matrix = [1, 0, 0, 1, 0, 0];
  const saved: number[][] = [];
  let covered = 0;
  for (let index = 0; index < list.fnArray.length; index++) {
    const op = list.fnArray[index];
    const args = list.argsArray[index] ?? [];
    if (op === ops.save) saved.push([...matrix]);
    else if (op === ops.restore) matrix = saved.pop() ?? matrix;
    else if (op === ops.transform && args.length === 6 && args.every(value => typeof value === 'number')) {
      const [a, b, c, d, e, f] = args as number[];
      const [ma, mb, mc, md, me, mf] = matrix;
      matrix = [ma! * a! + mc! * b!, mb! * a! + md! * b!, ma! * c! + mc! * d!, mb! * c! + md! * d!, ma! * e! + mc! * f! + me!, mb! * e! + md! * f! + mf!];
    } else if (op === ops.paintImageXObject || op === ops.paintJpegXObject || op === ops.paintInlineImageXObject) {
      covered += Math.abs(matrix[0]! * matrix[3]! - matrix[1]! * matrix[2]!);
    }
  }
  return Math.min(1, covered / pageArea);
}

async function check(path: string): Promise<boolean> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const bytes = await readFile(path);
  const loading = pdfjs.getDocument({
    data: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
    isEvalSupported: false, useSystemFonts: false,
    stopAtErrors: true
  } as Parameters<typeof pdfjs.getDocument>[0]);
  try {
    const document = await loading.promise as PdfDocument;
    if (document.numPages < 1 || document.numPages > 10_000) throw new Error('Invalid PDF page count');
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const [operators] = await Promise.all([page.getOperatorList()]);
        const area = Math.abs((page.view[2]! - page.view[0]!) * (page.view[3]! - page.view[1]!));
        const coverage = area > 0 ? scannedPageImageCoverage(operators, pdfjs.OPS as Record<string, number>, area) : 0;
        // A page-sized raster remains a scan even when OCR adds a text layer.
        if (coverage >= 0.8) return true;
      } finally { page.cleanup(); }
    }
    return false;
  } finally { await loading.destroy(); }
}

check(workerData.path as string).then(
  scanned => parentPort?.postMessage({ scanned }),
  () => parentPort?.postMessage({ failed: true })
);
