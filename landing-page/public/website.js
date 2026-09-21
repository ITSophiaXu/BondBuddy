'use strict';

// Set these two URLs when the desktop installer and public web app are released.
const config=JSON.parse(document.querySelector('#site-config').textContent);
const appUrl=new URL(config.appUrl,window.location.href);
if(['http:','https:','file:'].includes(appUrl.protocol)){
  document.querySelectorAll('[data-app-link]').forEach(link=>{
    const target=new URL(appUrl);target.hash=link.dataset.appLink;link.href=target.href;
  });
}
document.querySelector('#copyright-year').textContent=new Date().getFullYear();

const menuButton=document.querySelector('.menu-toggle');
const nav=document.querySelector('#site-nav');
function closeMenu(){nav.classList.remove('is-open');menuButton.setAttribute('aria-expanded','false');menuButton.setAttribute('aria-label','展开导航');}
menuButton.addEventListener('click',()=>{
  const open=menuButton.getAttribute('aria-expanded')!=='true';
  menuButton.setAttribute('aria-expanded',String(open));menuButton.setAttribute('aria-label',open?'收起导航':'展开导航');nav.classList.toggle('is-open',open);
});
nav.addEventListener('click',event=>{if(event.target.closest('a'))closeMenu();});
document.addEventListener('keydown',event=>{if(event.key==='Escape')closeMenu();});
window.matchMedia('(min-width:701px)').addEventListener('change',event=>{if(event.matches)closeMenu();});

const tabs=[...document.querySelectorAll('[data-feature]')];
function selectFeature(tab){
  for(const item of tabs){const selected=item===tab;item.setAttribute('aria-selected',String(selected));item.tabIndex=selected?0:-1;document.getElementById(item.getAttribute('aria-controls')).hidden=!selected;}
}
for(const tab of tabs){
  tab.addEventListener('click',()=>selectFeature(tab));
  tab.addEventListener('keydown',event=>{
    const index=tabs.indexOf(tab);
    const target=event.key==='ArrowRight'?tabs[(index+1)%tabs.length]:event.key==='ArrowLeft'?tabs[(index-1+tabs.length)%tabs.length]:event.key==='Home'?tabs[0]:event.key==='End'?tabs.at(-1):null;
    if(target){event.preventDefault();selectFeature(target);target.focus();}
  });
}

const dialog=document.querySelector('#download-dialog');
let downloadTrigger;
function download(){
  if(config.windowsDownloadUrl){
    const url=new URL(config.windowsDownloadUrl,window.location.href);
    if(['https:','http:'].includes(url.protocol)){window.location.assign(url.href);return;}
  }
  downloadTrigger=document.activeElement;dialog.showModal();document.body.classList.add('dialog-open');
}
document.querySelectorAll('[data-download]').forEach(button=>button.addEventListener('click',download));
document.querySelectorAll('[data-close-dialog]').forEach(button=>button.addEventListener('click',()=>dialog.close()));
dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const box=dialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)dialog.close();});
dialog.addEventListener('close',()=>{document.body.classList.remove('dialog-open');downloadTrigger?.focus();});

const previewDialog=document.querySelector('#preview-dialog');
const previewImage=document.querySelector('#preview-dialog-image');
let previewTrigger;
for(const frame of document.querySelectorAll('.desktop-frame,.feature-image-wrap')){
  const img=frame.querySelector('.hero-screen')||frame.querySelector('img');
  const button=document.createElement('button');button.type='button';button.className='preview-enlarge';button.textContent='放大查看 ↗';button.setAttribute('aria-label','放大查看'+img.alt);
  button.addEventListener('click',()=>{previewTrigger=button;previewImage.src=img.src;previewImage.alt=img.alt;previewDialog.showModal();document.body.classList.add('dialog-open');});frame.append(button);
}
document.querySelector('[data-close-preview]').addEventListener('click',()=>previewDialog.close());
previewDialog.addEventListener('click',event=>{if(event.target!==previewDialog)return;const box=previewDialog.getBoundingClientRect();if(event.clientX<box.left||event.clientX>box.right||event.clientY<box.top||event.clientY>box.bottom)previewDialog.close();});
previewDialog.addEventListener('close',()=>{document.body.classList.remove('dialog-open');previewTrigger?.focus();});

if('IntersectionObserver' in window){
  const sections=[...nav.querySelectorAll('a[href^="#"]')];
  const observer=new IntersectionObserver(entries=>{
    for(const entry of entries){if(!entry.isIntersecting)continue;for(const item of sections){const active=item.hash==='#'+entry.target.id;item.classList.toggle('active',active);if(active)item.setAttribute('aria-current','location');else item.removeAttribute('aria-current');}}
  },{rootMargin:'-15% 0px -65% 0px'});
  for(const link of sections){const section=document.querySelector(link.hash);if(section)observer.observe(section);}
}
