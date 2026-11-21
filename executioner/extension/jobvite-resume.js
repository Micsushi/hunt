/** Prove a Jobvite portal belongs to Add Resume before the shared filler supplies bytes. */
export async function proveJobviteResumeInput({expectedUrl,expiresAt}={}) {
  if (location.hostname!=='jobs.jobvite.com') return false;
  const state=globalThis.__huntC3PartialFill??={undo:[],redo:[],busy:false};
  if (state.busy || state.resumeAttempt) return false;
  const url=location.href,doc=document;
  const norm=value=>String(value??'').replace(/[✱*]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
  const visible=e=>e.isConnected && e.getClientRects().length>0 && getComputedStyle(e).visibility!=='hidden' && Number(getComputedStyle(e).opacity)>0 && !e.closest('[aria-hidden=true],[inert]');
  const triggers=()=>[...document.querySelectorAll('button[jv-add-attachment]')];
  const dialogs=()=>[...document.querySelectorAll('[role=dialog][aria-label="Attachment Options"]')].filter(visible);
  const candidates=triggers().filter(e=>e.type==='button' && e.getAttribute('attachment-label')==='Resume' && visible(e) && !e.disabled);
  if (candidates.length!==1) return false;
  const trigger=candidates[0],triggerParent=trigger.parentElement,id=trigger.getAttribute('aria-labelledby');
  const headings=id && !/\s/.test(id)?[...document.querySelectorAll(`[id="${CSS.escape(id)}"]`)]:[];
  if (headings.length!==1 || norm(headings[0].textContent)!=='add resume' || trigger.getAttribute('aria-haspopup')!=='true') return false;
  const heading=headings[0],region=trigger.form || trigger.closest('form,[role=form]') || trigger.getRootNode();
  const context=()=>document===doc && location.href===url && trigger.isConnected && trigger.parentElement===triggerParent && heading.isConnected &&
    trigger.type==='button' && !trigger.disabled && visible(trigger) && trigger.hasAttribute('jv-add-attachment') &&
    trigger.getAttribute('attachment-label')==='Resume' && trigger.getAttribute('aria-labelledby')===id &&
    trigger.getAttribute('aria-haspopup')==='true' && norm(heading.textContent)==='add resume' &&
    (trigger.form || trigger.closest('form,[role=form]') || trigger.getRootNode())===region &&
    document.querySelectorAll(`[id="${CSS.escape(id)}"]`).length===1 &&
    triggers().filter(e=>e.getAttribute('attachment-label')==='Resume').length===1;
  const check=()=>{if (expectedUrl && url!==expectedUrl || location.href!==url || Date.now()>=(expiresAt??Infinity)) throw new Error('The attachment action expired or the application changed.');};
  check();
  // An already open, unproven attachment menu may belong to a manual action.
  if (dialogs().length || triggers().some(e=>e.getAttribute('aria-expanded')==='true') || !context()) return false;
  state.busy=true;
  try {
    trigger.click();
    const until=Math.min(Date.now()+1200,expiresAt??Infinity);
    do {
      await new Promise(resolve=>setTimeout(resolve,40));check();
      if (!context() || triggers().some(e=>e!==trigger && e.getAttribute('aria-expanded')==='true')) return false;
      if (trigger.getAttribute('aria-expanded')==='true' && dialogs().length) break;
    } while(Date.now()<until);
    const opened=dialogs();
    if (trigger.getAttribute('aria-expanded')!=='true' || opened.length!==1) return false;
    const dialog=opened[0],inputs=[...dialog.querySelectorAll('input[type=file]')];
    if (inputs.length!==1) return false;
    const input=inputs[0],labels=[...input.labels??[]].filter(e=>dialog.contains(e) && e.control===input && visible(e) && norm(e.textContent)==='file');
    if (labels.length!==1) return false;
    const label=labels[0];
    const valid=()=>context() && dialog.isConnected && visible(dialog) && dialog.getAttribute('aria-hidden')==='false' &&
      dialog.getAttribute('role')==='dialog' && dialog.getAttribute('aria-label')==='Attachment Options' &&
      dialogs().length===1 && dialogs()[0]===dialog && trigger.getAttribute('aria-expanded')==='true' &&
      !triggers().some(e=>e!==trigger && e.getAttribute('aria-expanded')==='true') &&
      input.isConnected && input.type==='file' && !input.disabled && !input.matches(':disabled') && !input.multiple && !input.closest('[inert],[aria-hidden=true]') &&
      dialog.contains(input) && dialog.querySelectorAll('input[type=file]').length===1 &&
      label.isConnected && dialog.contains(label) && label.control===input && visible(label) && norm(label.textContent)==='file';
    if (!valid()) return false;
    (state.nativeFileBindings??=new WeakMap()).set(input,{kind:'jobvite',input,trigger,dialog,label,region,valid});
    return true;
  } finally {state.busy=false;}
}

// The binding persists in the selected document across extension reloads.
export function isPortalResumeBinding(proof) {
  return proof?.kind === 'jobvite';
}
