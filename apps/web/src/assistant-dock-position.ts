/** Keep the collapsed assistant clear of visible workflow actions without adding page space. */
export function followAssistantActionBars(dock:HTMLElement):()=>void {
  const selector='.fg-footer,.pf-footer,.qa-actions,.authoring-actions.is-preparing,.review-materials-footer';
  const observed=new Set<Element>();let frame=0,stopped=false;
  const schedule=()=>{if(!stopped&&!frame)frame=requestAnimationFrame(position);};
  const resize=new ResizeObserver(schedule);
  function position(){
    frame=0;if(stopped)return;
    const bars=[...document.querySelectorAll<HTMLElement>(`.prototype-app ${selector.split(',').join(',.prototype-app ')}`)];
    for(const element of observed)if(!bars.includes(element as HTMLElement)){resize.unobserve(element);observed.delete(element);}
    for(const bar of bars)if(!observed.has(bar)){resize.observe(bar);observed.add(bar);}
    if(!dock.isConnected||dock.hidden||!dock.getClientRects().length)return;
    const box=dock.getBoundingClientRect(),prior=parseFloat(dock.style.getPropertyValue('--ba-dock-offset'))||0;
    const inset=Math.max(0,parseFloat(getComputedStyle(dock).bottom)-prior);
    const preferredBottom=innerHeight-inset;let bottom=preferredBottom;
    const obstacles=bars.filter(bar=>bar.getClientRects().length&&getComputedStyle(bar).visibility!=='hidden')
      .map(bar=>bar.getBoundingClientRect()).filter(rect=>rect.width>0&&rect.height>0&&rect.bottom>0&&rect.top<innerHeight&&rect.right>box.left&&rect.left<box.right)
      .sort((a,b)=>b.top-a.top);
    for(const rect of obstacles)if(bottom>rect.top&&bottom-box.height<rect.bottom)bottom=rect.top-12;
    const offset=Math.min(Math.max(0,preferredBottom-bottom),Math.max(0,preferredBottom-box.height-12));
    if(Math.abs(offset-prior)>.5)dock.style.setProperty('--ba-dock-offset',`${offset}px`);
  }
  const mutations=new MutationObserver(schedule);
  mutations.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['class','hidden','open']});
  window.addEventListener('scroll',schedule,{capture:true,passive:true});
  window.addEventListener('resize',schedule,{passive:true});
  window.visualViewport?.addEventListener('resize',schedule,{passive:true});
  schedule();
  return ()=>{stopped=true;cancelAnimationFrame(frame);resize.disconnect();mutations.disconnect();window.removeEventListener('scroll',schedule,true);window.removeEventListener('resize',schedule);window.visualViewport?.removeEventListener('resize',schedule);dock.style.removeProperty('--ba-dock-offset');};
}
