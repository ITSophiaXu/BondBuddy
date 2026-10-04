/** Update progress in place so polling preserves reading, selection, focus and expanded history. */
export function patchReviewContent(host: HTMLElement, html: string): void {
  const template=document.createElement('template');template.innerHTML=html;
  const selection=getSelection(),range=selection&&!selection.isCollapsed&&selection.rangeCount?selection.getRangeAt(0):undefined;
  const key=(node:Node):string|undefined=>node instanceof Element?node.id||node.getAttribute('data-task-run')||node.getAttribute('data-message-id')||node.getAttribute('data-finding-id')||undefined:undefined;
  const same=(left:Node,right:Node)=>left.nodeType===right.nodeType&&(!(left instanceof Element)||right instanceof Element&&left.tagName===right.tagName)&&key(left)===key(right);
  const selected=(node:Node)=>{try{return Boolean(range?.intersectsNode(node));}catch{return false;}};
  function sync(previous:Node,next:Node):void {
    if(previous.nodeType===Node.TEXT_NODE){if(previous.nodeValue!==next.nodeValue&&!selected(previous))previous.nodeValue=next.nodeValue;return;}
    if(previous instanceof HTMLElement&&next instanceof HTMLElement){
      for(const attribute of [...previous.attributes])if(!next.hasAttribute(attribute.name)&&!(previous instanceof HTMLDetailsElement&&attribute.name==='open'))previous.removeAttribute(attribute.name);
      for(const attribute of [...next.attributes])if(previous.getAttribute(attribute.name)!==attribute.value&&!(previous instanceof HTMLDetailsElement&&attribute.name==='open'))previous.setAttribute(attribute.name,attribute.value);
      if(previous instanceof HTMLTextAreaElement&&next instanceof HTMLTextAreaElement){if(previous.value!==next.value)previous.value=next.value;return;}
      if(previous instanceof HTMLInputElement&&next instanceof HTMLInputElement){if(previous.value!==next.value)previous.value=next.value;previous.checked=next.checked;}
    }
    syncChildren(previous,next);
  }
  function syncChildren(previous:Node,next:Node):void {
    let position=previous.firstChild;
    for(const child of [...next.childNodes]){
      let match=position&&same(position,child)?position:undefined;
      if(!match){const childKey=key(child);if(childKey)match=[...previous.childNodes].find(node=>key(node)===childKey&&same(node,child));}
      if(match){if(match!==position)previous.insertBefore(match,position);sync(match,child);position=match.nextSibling;}
      else{const added=child.cloneNode(true);previous.insertBefore(added,position);position=added.nextSibling;}
    }
    while(position){const leftover=position;position=position.nextSibling;if(!selected(leftover))previous.removeChild(leftover);}
  }
  syncChildren(host,template.content);
}
