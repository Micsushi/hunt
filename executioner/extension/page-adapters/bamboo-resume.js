/** Read-only candidate discovery shared by service and extension chooser interception. */
export function bambooResumeControl() {
  const state=globalThis.__huntC3PartialFill;
  if (state?.resumeAttempt || state?.busy) return null;
  const forms=[...document.querySelectorAll('form')].filter(form=>form.querySelector('input[type=email],input[type=text][name=email]') &&
    ![...form.querySelectorAll('input[type=password]')].some(e=>e.getClientRects().length));
  const norm=text=>String(text??'').replace(/[✱*]/g,'').trim().toLowerCase();
  const candidates=[];
  for (const form of forms) for (const input of form.querySelectorAll('input[type=file]')) {
    if (input.disabled || input.multiple || input.matches(':disabled') || input.closest('[inert],[aria-hidden=true]') || state?.nativeFileBindings?.has(input)) continue;
    const style=getComputedStyle(input);
    if (input.getClientRects().length && style.visibility!=='hidden' && Number(style.opacity)>0) continue;
    for (let group=input.parentElement,depth=0;group && group!==form && depth<5;group=group.parentElement,depth++) {
      if (group.querySelectorAll('input[type=file]').length!==1 || [...group.querySelectorAll('input,textarea,select')].some(e=>e!==input && !e.matches('input[type=hidden][name=resumeFileId]'))) break;
      const lines=(group.innerText??'').split('\n').map(norm).filter(Boolean);
      if (lines[0]!=='resume' && lines[0]!=='résumé') continue;
      if (/uploaded successfully|remove file/i.test(group.innerText)) break;
      const buttons=[...group.querySelectorAll('button[type=button]')].filter(button=>
        norm(button.textContent)==='choose file' && button.getClientRects().length>0 && getComputedStyle(button).visibility!=='hidden' &&
        !button.disabled && !button.closest('[inert],[aria-hidden=true]'));
      if (buttons.length===1) candidates.push({input,button:buttons[0],group,form});
      break;
    }
  }
  return candidates.length===1 ? candidates[0] : null;
}
