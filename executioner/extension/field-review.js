// Runs in the extension's isolated world on the selected tab. Field handles stay
// in the extension. The page panel can only navigate the list or request a reveal.
function renderFieldReview(expectedUrl, review) {
  if (location.href !== expectedUrl) return false;
  if(review?.liveUpdate && globalThis.__huntC3UpdateFieldReview?.(review))return true;
  globalThis.__huntC3CloseFieldReview?.();
  if (!review) return true;
  const host = document.createElement('div');
  host.id = 'hunt-c3-field-review';
  host.toggleAttribute('data-toolbar-open',globalThis.__huntC3ToolbarUrl===expectedUrl);
  const root = host.attachShadow({mode:'closed'});
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host { all:initial!important; display:block!important; position:fixed!important;
      inset:12px 12px auto auto!important; width:min(310px,calc(100vw - 24px))!important;
      z-index:2147483647!important; color-scheme:dark; }
    :host([data-toolbar-open]), :host([data-resolved]) { display:none!important; }
    section { box-sizing:border-box; max-height:calc(100vh - 24px); overflow:auto; padding:14px;
      background:#18251d; color:#f0f5ef; border:1px solid #51705b; border-radius:12px;
      box-shadow:0 4px 20px #0005; font:14px/1.45 system-ui,sans-serif; }
    header, nav { display:flex; align-items:center; gap:8px; }
    header { justify-content:space-between; color:#bad3bd; font-size:12px; }
    h2 { margin:8px 0 3px; font-size:16px; overflow-wrap:anywhere; }
    p { margin:0; }
    nav { margin-top:12px; flex-wrap:wrap; }
    button { font:inherit; color:inherit; background:#293d2f; border:1px solid #597260;
      border-radius:6px; cursor:pointer; min-height:32px; padding:4px 9px; }
    button:focus-visible { outline:2px solid #b0edbf; outline-offset:2px; }
    button:disabled { opacity:.5; cursor:default; }
    [hidden] { display:none!important; }
    .primary { background:#a1d8a9; color:#152219; margin-right:auto; }
    [role=status]:not(:empty) { margin-top:8px; color:#f1d19d; }
  `);
  root.adoptedStyleSheets = [sheet];
  function node(parent, tag, text) {
    const el = document.createElement(tag);
    if (text) el.textContent = text;
    parent.append(el);
    return el;
  }
  function button(parent, text, action) {
    const el = node(parent, 'button', text);
    el.type = 'button';
    el.addEventListener('click', event => {
      if (!event.isTrusted) return;
      if (location.href !== expectedUrl) { remove(); return; }
      action();
    });
    return el;
  }
  const panel = node(root,'section');
  panel.setAttribute('aria-label','Hunt field review');
  const header = node(panel,'header');
  const position = node(header,'span');
  position.setAttribute('aria-live','polite');
  const close = button(header,'×',() => { void send('close'); remove(); });
  close.setAttribute('aria-label','Close field review');
  const detail = node(panel,'div');
  detail.setAttribute('aria-live','polite');
  detail.setAttribute('aria-atomic','true');
  const label = node(detail,'h2');
  const message = node(detail,'p');
  const nav = node(panel,'nav');
  const show = button(nav,'Show field',async () => {
    const selected=review.items[index]?.key;
    const stillSelected=()=>host.isConnected && selected && review.items[index]?.key===selected;
    revealing=true;
    show.disabled=true;
    status.textContent='';
    try {
      await checking;
      if(!stillSelected())return;
      const reply=await send('show');
      if(!stillSelected() || reply?.ok)return;
      const checked=await send('refresh');
      if(!stillSelected())return;
      status.textContent=checked?.expired?'The form has changed. Open Hunt to review this step.':
        checked?.ok?'Hunt rechecked the form but could not highlight this field.':'Hunt could not recheck this field on the current form.';
    } finally {
      revealing=false;
      if(host.isConnected)show.disabled=false;
      if(dirty && host.isConnected)schedule();
    }
  });
  show.className = 'primary';
  const previous = button(nav,'Previous',() => step(-1));
  const next = button(nav,'Next',() => step(1));
  const status = node(panel,'p');
  status.setAttribute('role','status');
  let index = review.index;
  globalThis.__huntC3UpdateFieldReview = updated => {
    if(!host.isConnected || location.href!==expectedUrl)return false;
    review=updated;
    index=updated.index;
    render();
    return true;
  };
  function send(command) {
    try {
      return chrome.runtime.sendMessage({action:'fieldReview',token:review.token,command,index,expectedUrl}).catch(() => null);
    } catch { return Promise.resolve(null); }
  }
  function step(delta) {
    index = Math.max(0,Math.min(review.items.length-1,index+delta));
    render();
    void send('step');
  }
  function render() {
    const item = review.items[index];
    host.toggleAttribute('data-resolved',!item);
    if(!item)return;
    position.textContent = 'Hunt · Issue '+(index+1)+' of '+review.items.length;
    label.textContent = item.section ? item.section+' · '+item.label : item.label;
    message.textContent = item.message;
    show.hidden = !item.canShow;
    show.disabled = revealing;
    previous.hidden = next.hidden = review.items.length===1;
    previous.disabled = index===0;
    next.disabled = index===review.items.length-1;
    status.textContent = '';
  }
  const routeChanged = () => { if (location.href !== expectedUrl) remove(); };
  let timer, checking=null, revealing=false, dirty=false;
  const listeners=new AbortController();
  async function refresh(){
    if(location.href!==expectedUrl){remove();return;}
    if(checking || revealing || document.hidden || !host.isConnected)return;
    dirty=false;
    checking=send('refresh');
    const reply=await checking;
    checking=null;
    if(host.isConnected && dirty)schedule();
    else if(host.isConnected && !revealing)status.textContent=reply?.ok?'':reply?.expired?'The form has changed. Open Hunt to review this step.':'Could not recheck the form. Reopen Hunt to check the remaining fields.';
  }
  function schedule(){
    dirty=true;
    clearTimeout(timer);
    timer=setTimeout(refresh,350);
  }
  function edited(event){
    if(!event.isTrusted || event.target===host)return;
    if(event.type==='click' && !event.target.closest?.('button,[role=button],[role=option],[role=radio],[role=checkbox],label'))return;
    schedule();
  }
  const watched=new WeakSet();
  const validation=new MutationObserver(schedule);
  function watch(doc){
    if(watched.has(doc))return;
    watched.add(doc);
    validation.observe(doc,{subtree:true,attributes:true,attributeFilter:['aria-invalid','aria-required','aria-checked','aria-selected','required','disabled']});
    for(const type of ['input','change','focusout','click'])doc.addEventListener(type,edited,{capture:true,signal:listeners.signal});
    doc.addEventListener('load',event=>{
      if(event.target?.tagName==='IFRAME' && event.target.contentDocument)watch(event.target.contentDocument);
    },{capture:true,signal:listeners.signal});
    for(const frame of doc.querySelectorAll('iframe'))if(frame.contentDocument)watch(frame.contentDocument);
  }
  watch(document);
  // Edits inside a cross-origin application frame do not bubble to its host.
  // Recheck only while the user is working in that embedded document.
  const frameTimer=setInterval(()=>{
    if(document.hidden || !document.hasFocus() || checking)return;
    let focused=document.activeElement;
    while(focused?.tagName==='IFRAME'){
      if(!focused.contentDocument){void refresh();return;}
      focused=focused.contentDocument.activeElement;
    }
  },2000);
  function remove() {
    clearTimeout(timer);
    clearInterval(frameTimer);
    listeners.abort();
    validation.disconnect();
    host.remove();
    window.removeEventListener('pagehide',remove);
    window.navigation?.removeEventListener('currententrychange',routeChanged);
    delete globalThis.__huntC3CloseFieldReview;
    delete globalThis.__huntC3UpdateFieldReview;
  }
  globalThis.__huntC3CloseFieldReview = remove;
  window.addEventListener('pagehide',remove,{once:true});
  window.navigation?.addEventListener('currententrychange',routeChanged);
  render();
  document.documentElement.append(host);
  return true;
}

// Ordinary toolbar clicks may grant access on another employer's domain.
// Repeated injections there must still deliver each render only once.
if (window===top && !globalThis.__huntC3FieldReviewListener) {
  globalThis.__huntC3FieldReviewListener = true;
  chrome.runtime.onMessage.addListener((message,sender,respond) => {
    if(sender.id!==chrome.runtime.id || !['popup.html','background.js'].some(path=>sender.url===chrome.runtime.getURL(path)) ||
        message.expectedUrl!==location.href)return;
    if(message.action==='identifyFillDocument'){
      chrome.runtime.sendMessage({action:'ownFillDocumentId'}).then(respond,()=>respond(null));
      return true;
    }
    if(message.action==='toolbarPresence'){
      globalThis.__huntC3ToolbarUrl=message.open ? message.expectedUrl : undefined;
      document.getElementById('hunt-c3-field-review')?.toggleAttribute('data-toolbar-open',message.open===true);
    }
    if (message.action === 'renderFieldReview') {
      respond(renderFieldReview(message.expectedUrl,message.review));
    }
  });
}
