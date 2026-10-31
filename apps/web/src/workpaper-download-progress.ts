import type {WorkpaperZipPreparation} from '@bondbuddy/contracts';
import {downloadProgressText} from './download-progress';
import './workpaper-download-progress.css';

/** Preparation counts and response bytes are separate measures, never an ETA. */
export class WorkpaperDownloadProgress {
  private started=Date.now();
  private timer:ReturnType<typeof setInterval>;
  private title:HTMLElement;
  private detail:HTMLElement;
  private bar:HTMLProgressElement;
  private elapsed:HTMLElement;
  private slow:HTMLElement;
  constructor(host:HTMLElement,private signal:AbortSignal){
    host.removeAttribute('role');
    host.innerHTML=`<div class="wp-download-progress">
      <div role="status" aria-atomic="true"><strong data-download-title>正在准备下载</strong><p data-download-detail>正在读取已生成的文件并打包；文件较多时可能需要几分钟。</p></div>
      <progress aria-label="下载准备进度"></progress>
      <span class="wp-download-elapsed" aria-live="off"></span>
      <p class="wp-download-slow" role="status" hidden>等待时间较长，请继续等待，无需重复点击下载。</p>
      <small>请保持此页打开；切换页面会停止本次下载，已生成文件会保留。</small>
    </div>`;
    this.title=host.querySelector('[data-download-title]')!;
    this.detail=host.querySelector('[data-download-detail]')!;
    this.bar=host.querySelector('progress')!;
    this.elapsed=host.querySelector('.wp-download-elapsed')!;
    this.slow=host.querySelector('.wp-download-slow')!;
    this.tick();this.timer=setInterval(()=>this.tick(),1000);
    signal.addEventListener('abort',this.stop,{once:true});if(signal.aborted)this.stop();
  }
  private tick(){
    const seconds=Math.max(0,Math.floor((Date.now()-this.started)/1000));
    this.elapsed.textContent=`已等待 ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
    this.slow.hidden=seconds<30;
  }
  prepare(state:WorkpaperZipPreparation){
    const progress=state.progress;
    if(!progress){ // Older API: keep activity and elapsed time, without a guessed count.
      this.title.textContent='正在准备下载';
      this.detail.textContent='正在读取已生成的文件并打包；文件较多时可能需要几分钟。';
      this.bar.removeAttribute('value');this.bar.setAttribute('aria-label','下载准备进度');return;
    }
    const {phase,completed_files:done,total_files:total}=progress;
    this.title.textContent=phase==='retrieving'?'正在准备下载 · 读取文件':'正在准备下载 · 整理文件包';
    this.detail.textContent=phase==='retrieving'?`已准备 ${done} / ${total} 份文件，随后将打包下载。`:`${done} / ${total} 份文件已准备，正在完成打包…`;
    if(phase==='retrieving'){this.bar.max=total;this.bar.value=done;}
    else this.bar.removeAttribute('value');
    this.bar.setAttribute('aria-label',phase==='retrieving'?'下载准备：已读取文件数':'正在整理文件包');
  }
  transfer(received:number,total?:number){
    this.title.textContent='正在下载文件包';
    const known=total!==undefined&&total>0&&received<=total;
    this.detail.textContent=downloadProgressText(received,known?total:undefined);
    if(known){this.bar.max=total;this.bar.value=received;}else this.bar.removeAttribute('value');
    this.bar.setAttribute('aria-label','文件传输进度');
  }
  stop=()=>{clearInterval(this.timer);this.signal.removeEventListener('abort',this.stop);};
}
