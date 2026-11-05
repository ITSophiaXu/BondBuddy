import type { ReviewArtifact } from '@bondbuddy/contracts';
import { prototypeIcon } from './prototype-design';
import { esc } from './ui';

/** Presentation only. The caller retains its existing authorized download control. */
export function documentDeliverable(artifact: ReviewArtifact, detail: string, control: string): string {
  return `<article class="document-download"><span class="document-download-icon" aria-hidden="true">${prototypeIcon('file')}</span><div class="document-download-copy"><h3>${esc(artifact.filename)}</h3><p>${esc(detail)}</p></div>${control}</article>`;
}
