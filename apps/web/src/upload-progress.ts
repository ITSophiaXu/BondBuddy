import {esc} from './ui.js';

/** Percentages describe observed bytes only. Saving/processing has no invented percentage. */
export type FileUploadProgress = {message:string; loaded?:number; total?:number};
export type UploadStatus = (message:string, progress?:FileUploadProgress)=>void;
export const uploadActivity = (message='正在准备文件…'):FileUploadProgress => ({message});
export function uploadTransfer(loaded:number,total:number):FileUploadProgress {
  if(!Number.isFinite(loaded)||!Number.isFinite(total)||total<=0)return uploadActivity('正在上传文件…');
  return {loaded:Math.min(total,Math.max(0,loaded)),total,message:loaded>=total?'文件传输完成，正在确认保存…':'正在上传文件…'};
}
export function uploadProgressHtml(progress:FileUploadProgress|undefined, filename='文件', options:{error?:string;paused?:boolean;complete?:boolean;showMessage?:boolean;announce?:boolean}={}){
  const known=progress?.loaded!==undefined&&progress.total!==undefined&&progress.total>0;
  const percent=known?Math.min(100,Math.floor(progress!.loaded!/progress!.total!*100)):undefined;
  const stopped=!!options.error||!!options.paused;
  const state=options.error?'error':options.paused?'paused':options.complete?'complete':known?'uploading':'processing';
  const message=options.error??(options.paused?progress?.message??'上传待确认，请继续原保存。':options.complete?'文件已保存。':progress?.message??'正在准备文件…');
  const value=options.complete?100:percent??(stopped?0:undefined);
  const amount=percent===undefined||stopped||options.complete?'':percent+'%';
  return '<span class="file-upload-progress" data-upload-state="'+state+'"><span class="file-upload-progress-track"><progress max="100"'+(value===undefined?'':' value="'+value+'"')+' aria-label="'+esc(filename)+' 上传进度" aria-valuetext="'+esc(message+(amount?' '+amount:''))+'"></progress>'+(amount?'<span class="file-upload-percent">'+amount+'</span>':'')+'</span>'+(options.showMessage===false?'':'<span class="file-upload-message"'+(options.announce===false?'':' role="'+(options.error?'alert':'status')+'"')+'>'+esc(message)+'</span>')+'</span>';
}
