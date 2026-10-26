import { ApiError, friendlyError, type Dto } from './api';
import { resultFilename } from '@bondbuddy/contracts';

export function artifactFilename(artifact: Dto<'ArtifactResponse'>): string {
  return artifact.filename ?? resultFilename({ kind: artifact.word_delivery ? ({revision:'募集书修订版',clean:'募集书清洁版',baseline:'募集书基线版'} as const)[artifact.word_delivery.variant] : '成果', version:artifact.display_version ?? artifact.version, mediaType:artifact.media_type });
}

export function artifactError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 404) return '成果或下载授权不可用，请重新读取；也可能已移除或不属于当前账号。';
    if (error.code === 'DATA_UNAVAILABLE') return '成果文件暂时无法读取或校验未通过，请稍后重试。';
    return friendlyError(error, 'download');
  }
  return friendlyError(error, 'download');
}

// Call only after artifactBytes has verified the file and the caller is still current.
export class ArtifactDownloads {
  private objectUrls = new Map<string, ReturnType<typeof setTimeout>>();

  save(bytes: Blob, filename: string) {
    const url = URL.createObjectURL(bytes);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    document.body.append(link); link.click(); link.remove();
    this.objectUrls.set(url, setTimeout(() => { URL.revokeObjectURL(url); this.objectUrls.delete(url); }, 60_000));
  }

  dispose() {
    for (const [url, timer] of this.objectUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    this.objectUrls.clear();
  }
}
