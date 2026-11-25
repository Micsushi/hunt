// Registered on known ATS hosts only. This read-only check runs locally and
// sends neither field values nor labels to the worker or the employer.
(() => {
  if (window!==top || location.port || location.username || location.password) return;
  let host, timer, toolbarUrl, currentUrl = location.href, dismissed = false;
  const observed = new Map();
  const hidden = '[hidden],[inert],[aria-hidden=true],[aria-disabled=true]';
  const visible = e => !e.closest(hidden) && e.checkVisibility({checkVisibilityCSS:true, checkOpacity:true}) && e.getClientRects().length > 0;
  const normalize = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_*-]/g,' ').toLowerCase().replace(/\s+/g,' ').trim();
  const supported = /^(?:(?:first|given|last|family|full|legal first|legal last|preferred) name|name|e ?mail(?: address)?|phone(?: number)?|mobile(?: phone| number)?|address(?: line [12])?|street address|city|state|province|state\/province|country|zip(?: code)?|postal code|zip\/postal code|linkedin(?: profile| url)?|r[eé]sum[eé]|cv)$/;
  const autocomplete = /^(?:given-name|family-name|name|email|tel|address-line[12]|address-level[12]|postal-code|country-name)$/;
  const fieldLabel = e => e.getAttribute('aria-label') ||
    (e.getAttribute('aria-labelledby') || '').split(/\s+/).map(id => e.getRootNode().getElementById(id)?.textContent || '').join(' ').trim() ||
    [...e.labels || []].map(label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('select,input,button,textarea').forEach(control => control.remove());
      return copy.textContent;
    }).join(' ').trim() || e.name || e.placeholder || '';
  const sitesApplicationPath = /(?:^|\/)(?:apply|application|candidate|oneclick-ui)(?:\/|$)/i;
  const excludedForm = /newsletter|subscribe|subscription|job[\s_-]*alert|talent[\s_-]*(?:community|network)|contact (?:us|support)|(?:sign|log)[\s_-]*in|search/i;

  function hasApplicationField(root, applicationPath) {
    const owners = new Map();
    for (const e of root.querySelectorAll('input,textarea,select')) {
      if (!['text','email','tel','url','file','textarea','select-one'].includes(e.type) || e.matches(':disabled,[readonly]') || !visible(e)) continue;
      const owner = e.form || e.closest('[role=form]') || root;
      const label = normalize(fieldLabel(e)).replace(/(?:\s*\(required\)|\s+required|:)\s*$/i,'').trim();
      if (!supported.test(label) && !autocomplete.test(e.autocomplete)) continue;
      if (e.type === 'file' && (!/^(?:r[eé]sum[eé]|cv)$/.test(label) ||
          e.accept && !e.accept.split(',').some(type=>['.pdf','application/pdf','application/*','*/*'].includes(type.trim().toLowerCase())))) continue;
      const group = owners.get(owner) || {labels:new Set(), blank:false, resume:false};
      owners.set(owner,group);
      group.labels.add(label || e.autocomplete);
      group.resume ||= e.type === 'file';
      // Only emptiness is inspected. Ignore placeholder selects without any
      // usable option (for example Province before Country is chosen).
      if (e.tagName === 'SELECT') {
        const placeholder = opt => !opt?.value || /^(?:[-–—\s]*|[-–—\s]*(?:please )?(?:select|choose)(?:\b.*)?|make a selection)$/i.test(opt.text.trim().replace(/^[-–—\s]+|[-–—\s]+$/g,''));
        group.blank ||= placeholder(e.selectedOptions[0]) && [...e.options].some(opt=>!opt.disabled && !placeholder(opt));
      } else {
        group.blank ||= e.type === 'file' ? !e.files.length : !e.value.trim();
      }
    }
    for (const [owner,group] of owners) {
      if (!group.blank || owner.closest?.('nav,header,footer,[role=search]')) continue;
      const hints = [owner.id,owner.getAttribute?.('name'),owner.getAttribute?.('action'),owner.getAttribute?.('aria-label'),
        ...[...owner.querySelectorAll('h1,h2,legend,button,input[type=submit]')].filter(visible).map(e=>e.textContent?.trim() || (e.type==='submit' ? e.value : ''))].join(' ');
      if (excludedForm.test(hints)) continue;
      const auth = [...owner.querySelectorAll('input[type=password],input[autocomplete=one-time-code]')].some(visible);
      if (auth && !(group.labels.size >= 2 && /(?:submit|create) profile|candidate profile/i.test(hints))) continue;
      if (applicationPath || group.resume || /(?:submit|start|your|job) application|apply (?:now|for)|candidate profile/i.test(hints) ||
          /\/(?:careers|jobs?)\/[^/]+/i.test(location.pathname) && group.labels.size >= 2 &&
          /(?:first|given|family|last)[ -]name/.test([...group.labels].join(' '))) return true;
    }
    return false;
  }

  function remove() {
    host?.remove();
    host = null;
  }
  function dismiss() {
    dismissed = true;
    remove();
  }
  function show() {
    if (host?.isConnected) return;
    host = document.createElement('aside');
    host.id = 'hunt-c3-fill-invitation';
    host.setAttribute('aria-label','Hunt C3');
    // The employer page must not be able to relabel the control which starts a fill.
    const shadow = host.attachShadow({mode:'closed'});
    const style = document.createElement('style');
    style.textContent = ':host{all:initial!important;position:fixed!important;inset:12px 12px auto auto!important;z-index:2147483646!important;display:block!important;max-width:calc(100vw - 24px)!important}section{box-sizing:border-box;padding:12px;background:#17251b;color:#f2f4ed;border:1px solid #526955;border-radius:10px;box-shadow:0 3px 14px #0004;font:14px/1.4 "Segoe UI",system-ui,sans-serif}header{display:flex;align-items:center;gap:14px}strong{font-weight:650}button{font:inherit;cursor:pointer;border:0;border-radius:6px}button:focus-visible{outline:2px solid #e0f6df;outline-offset:2px}.close{background:transparent;color:#d5e5d5;min-width:28px;min-height:28px;margin-left:auto;font-size:20px}.fill{display:block;background:#97d39d;color:#102417;padding:7px 12px;margin-top:6px;font-weight:600}p{max-width:230px;margin:6px 0 0}';
    const section = document.createElement('section'), header = document.createElement('header');
    const name = document.createElement('strong'), close = document.createElement('button'), fill = document.createElement('button');
    name.textContent = 'Hunt C3';
    close.type = fill.type = 'button';
    close.className = 'close';
    close.setAttribute('aria-label','Dismiss invitation');
    close.textContent = '×';
    close.onclick = event => {if (event.isTrusted) dismiss();};
    fill.className = 'fill';
    fill.textContent = 'Fill current page';
    const message = document.createElement('p');
    message.setAttribute('role','status');
    message.hidden = true;
    fill.onclick = async event => {
      if (!event.isTrusted || fill.disabled || shadow.host !== host) return;
      // A field or route may have changed since the last debounced scan.
      refresh(true);
      if (!section.isConnected) return;
      const expectedUrl = currentUrl;
      message.hidden = true;
      fill.disabled = true;
      fill.textContent = 'Checking this page…';
      let reply;
      try { reply = await chrome.runtime.sendMessage({action:'fillFromInvitation',expectedUrl}); } catch {}
      if (!section.isConnected || location.href !== expectedUrl) return;
      if (reply?.ok) dismiss();
      else {
        message.textContent = reply?.error || 'Hunt lost the connection. Check the form before trying again.';
        message.hidden = false;
        fill.textContent = 'Check again and fill';
        fill.disabled = false;
      }
    };
    header.append(name,close);
    section.append(header,message,fill);
    shadow.append(style,section);
    document.documentElement.append(host);
  }

  function schedule() {
    if (!timer) timer = setTimeout(refresh,160);
  }
  function refresh(keepOffer=false) {
    clearTimeout(timer);
    timer = null;
    if (location.href !== currentUrl) {currentUrl = location.href; dismissed = false; if(!keepOffer)remove();}
    const icims = location.hostname.endsWith('.icims.com');
    if (document.getElementById('hunt-c3-field-review')) dismissed = true;
    if (dismissed || document.hidden || toolbarUrl === currentUrl ||
        icims && !( /^(?:careers?|jobs?)[\w-]*\./.test(location.hostname) || /^\/jobs(?:\/|$)/.test(location.pathname) && !location.hostname.startsWith('www.'))) {
      remove();
      return;
    }
    // iCIMS embeds the candidate form in a separate same-origin document.
    // Observe its actual fields and late rendering, never its frame title alone.
    const seen = new Set();
    let eligible = false;
    function visit(root, applicationPath) {
      if (!root || seen.has(root)) return;
      seen.add(root);
      if (!observed.has(root)) {
        const observer = new MutationObserver(schedule);
        observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','disabled','readonly','value','aria-hidden','aria-disabled','aria-label','autocomplete','type','name']});
        root.addEventListener('input',schedule,true);
        root.addEventListener('change',schedule,true);
        root.addEventListener('load',schedule,true);
        observed.set(root,observer);
      }
      eligible ||= hasApplicationField(root,applicationPath);
      for (const frame of root.querySelectorAll('iframe')) {
        if (visible(frame) && frame.contentDocument) visit(frame.contentDocument,applicationPath || sitesApplicationPath.test(frame.contentDocument.location.pathname));
      }
      if (location.hostname === 'jobs.smartrecruiters.com') {
        for (const element of root.querySelectorAll('*')) if (element.shadowRoot && element !== host && visible(element)) visit(element.shadowRoot,applicationPath);
      }
    }
    visit(document,sitesApplicationPath.test(location.pathname));
    for (const [root,observer] of observed) if (!seen.has(root)) {
      observer.disconnect();
      root.removeEventListener('input',schedule,true);
      root.removeEventListener('change',schedule,true);
      root.removeEventListener('load',schedule,true);
      observed.delete(root);
    }
    if (eligible) show();
    else remove();
  }
  document.addEventListener('visibilitychange',schedule);
  chrome.runtime.onMessage.addListener((message,sender,respond)=>{
    if (sender.id !== chrome.runtime.id || sender.tab || sender.url && sender.url !== chrome.runtime.getURL('background.js') ||
        message.expectedUrl !== location.href) return;
    if (message.action === 'toolbarPresence' && typeof message.open === 'boolean') {
      toolbarUrl = message.open ? message.expectedUrl : undefined;
      refresh();
    } else if (message.action === 'dismissFillInvitation') {
      currentUrl = message.expectedUrl;
      dismiss();
    } else return;
    respond(true);
  });
  window.addEventListener('pageshow',schedule);
  window.navigation?.addEventListener('currententrychange',schedule);
  refresh();
})();
