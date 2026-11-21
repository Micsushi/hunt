/** Annotate only associated consent text; never borrow a page-wide notice. */
export function annotateQuestionContext() {
  const visible = e => e.getClientRects().length > 0 && !e.closest('[hidden],[aria-hidden=true],[inert]') &&
    getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
  const clean = value => (value ?? '').replace(/\s+/g, ' ').trim();
  // Keep this function self-contained: the extension serializes it into the page.
  const roots = [document];
  for (let index = 0; index < roots.length; index++) {
    const root = roots[index];
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) roots.push(node.shadowRoot);
    for (const e of root.querySelectorAll('input[type=checkbox],[role=checkbox]')) {
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
      const label = clean(labelledBy.map(n => n.textContent).join(' ') || e.getAttribute('aria-label') ||
        [...e.labels ?? []].map(n => n.textContent).join(' ') ||
        (e.getAttribute('role') === 'checkbox' ? e.textContent : ''));
      e.setAttribute('data-hunt-question-label', label);
      if (!/^(?:i )?(?:agree|accept|consent|acknowledge)(?:\s*[✱*])?$/i.test(label)) continue;
      // Explicit ARIA descriptions can legitimately be visually hidden.
      let descriptions = describedBy;
      if (!descriptions.length) {
        for (let owner = e.parentElement, depth = 0; owner && depth < 5 && !owner.matches('form,body,main,[role=form]'); owner = owner.parentElement, depth++) {
          const controls = [...owner.querySelectorAll('input:not([type=hidden]),select,textarea,button,[role=checkbox],[role=radio],[role=combobox]')];
          if (controls.some(control => control !== e && !control.contains(e) && !e.contains(control))) break;
          descriptions = [...owner.querySelectorAll('p,[role=note]')].filter(n => visible(n) && !n.closest('label'));
          if (descriptions.length) break;
        }
      }
      const context = [...new Set(descriptions.map(n => clean(n.textContent)).filter(Boolean))].join(' ');
      // Retain the entire declaration for matching/backlog boundaries. Never truncate.
      if (context) e.setAttribute('data-hunt-question-context', `${label} ${context}`);
    }
  }
}
