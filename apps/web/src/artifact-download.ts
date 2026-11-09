import { ApiError, friendlyError, type Dto } from './api.js';
import { resultFilename } from '@bondbuddy/contracts';
export { boundedDownload } from './download-timeout.js';

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

  save(bytes: Blob, filename: string, fallbackHost?:HTMLElement) {
    const url = URL.createObjectURL(bytes);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
    if(fallbackHost){
      // Some browsers suppress a synthetic download after a long async ZIP read.
      // Keep a real, user-clickable link to the same bytes; retrying it is free.
      fallbackHost.replaceChildren(document.createTextNode('文件已准备好。如未自动下载，请点击：'));
      link.className='text-button';link.textContent='保存文件';fallbackHost.append(link);
    }else document.body.append(link);
    link.click();if(!fallbackHost)link.remove();
    this.objectUrls.set(url, setTimeout(() => { URL.revokeObjectURL(url); this.objectUrls.delete(url);if(fallbackHost?.contains(link))fallbackHost.replaceChildren(document.createTextNode('保存链接已过期，请重新点击下载。')); }, fallbackHost?300_000:60_000));
  }

  dispose() {
    for (const [url, timer] of this.objectUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
    this.objectUrls.clear();
  }
}
