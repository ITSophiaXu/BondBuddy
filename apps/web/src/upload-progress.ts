import {esc} from './ui.js';

/** Overall upload progress reserves the final 10% for the server receipt and adoption.
 * No timer advances it: only an explicit successful result can reach 100%. */
export type FileUploadProgress = {message:string; loaded?:number; total?:number; finishing?:boolean};
export type UploadStatus = (message:string, progress?:FileUploadProgress)=>void;
export const uploadActivity = (message='正在上传文件…', previous?:FileUploadProgress):FileUploadProgress => ({...previous,message});
export const uploadFinishing = (message='正在上传文件…'):FileUploadProgress => ({message,finishing:true});
export function uploadTransfer(loaded:number,total:number):FileUploadProgress {
  if(!Number.isFinite(loaded)||!Number.isFinite(total)||total<=0)return uploadActivity('正在上传文件…');
  return {loaded:Math.min(total,Math.max(0,loaded)),total,finishing:loaded>=total,message:'正在上传文件…'};
}
export function uploadProgressHtml(progress:FileUploadProgress|undefined, filename='文件', options:{error?:string;paused?:boolean;complete?:boolean;showMessage?:boolean;announce?:boolean}={}){
  const known=Number.isFinite(progress?.loaded)&&Number.isFinite(progress?.total)&&progress!.total!>0;
  const percent=progress?.finishing?90:known?Math.min(90,Math.max(0,Math.floor(progress!.loaded!/progress!.total!*90))):undefined;
  const stopped=!!options.error||!!options.paused;
  const state=options.error?'error':options.paused?'paused':options.complete?'complete':'uploading';
  const message=options.error??(options.paused?progress?.message??'上传已暂停，请重试。':options.complete?'上传成功':'正在上传文件…');
  const value=options.complete&&!stopped?100:percent??(stopped?0:undefined);
  const amount=stopped?'':options.complete?'100%':percent===undefined?'':percent+'%';
  return '<span class="file-upload-progress" data-upload-state="'+state+'"><span class="file-upload-progress-track"><progress max="100"'+(value===undefined?'':' value="'+value+'"')+' aria-label="'+esc(filename)+' 上传进度" aria-valuetext="'+esc(message+(amount?' '+amount:''))+'"></progress>'+(amount?'<span class="file-upload-percent">'+amount+'</span>':'')+'</span>'+(options.showMessage===false?'':'<span class="file-upload-message"'+(options.announce===false?'':' role="'+(options.error?'alert':'status')+'"')+'>'+esc(message)+'</span>')+'</span>';
}
