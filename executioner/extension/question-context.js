/** Annotate only associated consent text; never borrow a page-wide notice. */
export function annotateQuestionContext() {
  const visible = e => e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden=true],[inert]') &&
    getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  const labelText = node => {
    if (!node.querySelector('input,select,textarea,button')) return node.textContent;
    const copy=node.cloneNode(true);
    copy.querySelectorAll('input,select,textarea,button').forEach(control=>control.remove());
    return copy.textContent;
  };
  // Keep this function self-contained: the extension serializes it into the page.
  const roots = [document];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    for (const e of root.querySelectorAll('input[type=checkbox],[role=checkbox],select,[role=combobox],[aria-haspopup=listbox],fieldset:has(input[type=radio]),[role=radiogroup]')) {
      e.removeAttribute('data-hunt-question-context');
      e.removeAttribute('data-hunt-question-label');
      const refs = attribute => {
        const ids = (e.getAttribute(attribute) ?? '').split(/\s+/).filter(Boolean);
        const nodes = [];
        for (const id of ids) {
          const matches = root.querySelectorAll(`[id="${CSS.escape(id)}"]`);
          // A broken explicit association must not borrow a different local declaration.
          if (matches.length !== 1) return null;
          nodes.push(matches[0]);
        }
        return nodes;
      };
      const labelledBy = refs('aria-labelledby');
      const describedBy = refs('aria-describedby');
      if (labelledBy === null || describedBy === null) continue;
      const checkbox=e.matches('input[type=checkbox],[role=checkbox]');
      const label = clean(labelledBy.map(labelText).join(' ') || e.getAttribute('aria-label') ||
        [...e.labels ?? []].map(labelText).join(' ') || e.querySelector(':scope > legend')?.textContent ||
        (e.getAttribute('role') === 'checkbox' ? e.textContent : ''));
      if (checkbox) e.setAttribute('data-hunt-question-label', label);
      const short=checkbox && /^(?:i )?(?:agree|accept|consent|acknowledge)(?:\s*[✱*])?$/i.test(label);
      if (!short && !/\b(?:consent|privacy|terms|agree|accept|acknowledge)\b/i.test(label)) continue;
      // Explicit ARIA descriptions can legitimately be visually hidden.
      let descriptions = describedBy;
      if (!descriptions.length) {
        for (let owner = e.matches('fieldset,[role=radiogroup]') ? e : e.parentElement, depth = 0; owner && depth < 5 && !owner.matches('form,body,main,[role=form]'); owner = owner.parentElement, depth++) {
          const controls = [...owner.querySelectorAll('input:not([type=hidden]),select,textarea,button,[role=checkbox],[role=radio],[role=combobox]')];
          if (controls.some(control => control !== e && !control.contains(e) && !e.contains(control))) break;
          if (e.matches('fieldset,[role=radiogroup]') && controls.some(control=>!control.matches('input[type=radio],[role=radio]') ||
              control.closest('fieldset,[role=radiogroup]')!==e)) break;
          descriptions = [...owner.querySelectorAll('p,[role=note]')].filter(n => visible(n) && !n.closest('label'));
          if (descriptions.length) break;
        }
      }
      const context = [...new Set(descriptions.map(n => clean(n.textContent)).filter(Boolean))].join(' ');
      // Retain the entire declaration for matching/backlog boundaries. Never truncate.
      const declaration=`${label} ${context}`;
      // A separately worded AI notice changes what agreeing to recruitment terms authorizes.
      if (context && (short || /\b(?:ai|artificial intelligence|automated)\b/i.test(declaration) &&
          /\b(?:terms|privacy)\b/i.test(declaration))) e.setAttribute('data-hunt-question-context', declaration);
    }
  }
}
