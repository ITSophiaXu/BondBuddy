import {esc} from './ui';
import {prototypeIcon} from './prototype-design';
import './upload-ux.css';

export function uploadPickerContent(label='选择文件',hint='或将文件拖到这里'){
  return `${prototypeIcon('upload')}<span class="bb-upload-copy"><strong>${esc(label)}</strong>${hint?`<small>${esc(hint)}</small>`:''}</span>`;
}

const documents=new WeakSet<Document>();
/** Delegation survives repaint without replacing file inputs or their change handlers. */
export function bindUploadPickers(doc:Document){
  if(documents.has(doc))return;documents.add(doc);
  const picker=(event:Event)=>event.target instanceof Element?event.target.closest<HTMLElement>('[data-upload-picker]'):null;
  const input=(host:HTMLElement)=>host.querySelector<HTMLInputElement>('input[type=file]');
  const enabled=(host:HTMLElement)=>{const file=input(host);return file&&!file.disabled&&!file.matches(':disabled')&&!file.closest('[inert]')&&!file.webkitdirectory;};
  doc.addEventListener('dragover',event=>{const host=picker(event);if(!host||!enabled(host))return;event.preventDefault();host.classList.add('is-dragging');});
  doc.addEventListener('dragleave',event=>{const host=picker(event);if(host&&!(event.relatedTarget instanceof Node&&host.contains(event.relatedTarget)))host.classList.remove('is-dragging');});
  doc.addEventListener('drop',event=>{
    const host=picker(event);if(!host)return;event.preventDefault();host.classList.remove('is-dragging');
    if(!enabled(host))return;const file=input(host)!,files=event.dataTransfer?.files;if(!files?.length)return;
    const message=host.querySelector<HTMLElement>('[data-upload-picker-error]')!;
    if(!file.multiple&&files.length>1){message.textContent='每次请选择一份文件。';message.hidden=false;return;}
    message.textContent='';message.hidden=true;file.files=files;file.dispatchEvent(new Event('change',{bubbles:true}));
  });
  doc.addEventListener('change',event=>{const host=picker(event),message=host?.querySelector<HTMLElement>('[data-upload-picker-error]');if(message){message.textContent='';message.hidden=true;}});
}

/** Keep caller-owned IDs, names, constraints and input events intact. */
export function uploadPicker(inputHtml:string,options:{label?:string;size?:'standard'|'compact'}={}){
  if(typeof document!=='undefined')bindUploadPickers(document);
  const size=options.size??'standard',label=options.label??'选择文件';
  return `<span class="bb-upload-picker bb-upload-picker--${size}" data-upload-picker>${uploadPickerContent(label,size==='standard'?'或将文件拖到这里':'')}${inputHtml}<span class="bb-upload-picker-error" data-upload-picker-error role="alert" hidden></span></span>`;
}
