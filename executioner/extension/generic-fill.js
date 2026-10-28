/** Runs in the extension's isolated world. Keep self-contained for executeScript. */
export async function fillVisibleFields({ facts = [], action = 'fill', scope = 'application', expectedUrl, expiresAt } = {}) {
  const checkDeadline = () => { if (expiresAt !== undefined && Date.now() >= expiresAt) throw new Error('Field changes expired. Check the page and reopen C3 before retrying.'); };
  checkDeadline();
  if (expectedUrl !== undefined && location.href !== expectedUrl) throw new Error('The page changed. Reopen C3 on the application.');
  const norm = value => String(value ?? '').normalize('NFKC').toLowerCase().replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/[:：]\s*$/, '').trim();
  const state = globalThis.__huntC3PartialFill ??= { undo: [], redo: [], busy: false };
  if (state.busy) throw new Error('A field fill is already running.');
  state.busy = true;
  const result = { status: 'partial', filled: [], skipped: [], canUndo: false, canRedo: false };
  const changes = [];
  const visible = e => e.getClientRects().length > 0 && getComputedStyle(e).visibility !== 'hidden';
  const read = e => e.type === 'radio' || e.type === 'checkbox' ? e.checked : e.value;
  const write = (e, value) => {
    const proto = e instanceof HTMLSelectElement ? HTMLSelectElement.prototype : e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, typeof value === 'boolean' ? 'checked' : 'value').set.call(e, value);
    e.dispatchEvent(new Event('input', { bubbles: true }));
    e.dispatchEvent(new Event('change', { bubbles: true }));
  };
  try {
    if (action === 'status') return result;
    if (action === 'undo' || action === 'redo') {
      const from = state[action], to = state[action === 'undo' ? 'redo' : 'undo'], changes = from.at(-1);
      if (!changes) return result;
      const previous = action === 'undo' ? 'after' : 'before', next = action === 'undo' ? 'before' : 'after';
      if (changes.some(c => !c.element.isConnected || read(c.element) !== c[previous])) throw new Error('Fields changed since C3 filled them. Your edits were preserved.');
      let written = 0;
      try {
        for (const c of changes) { checkDeadline(); write(c.element, c[next]); written++; }
      } catch (error) {
        await new Promise(resolve => setTimeout(resolve, 100));
        // Transfer only verified writes; the untouched remainder stays retryable.
        const applied = changes.slice(0, written).filter(c => c.element.isConnected && read(c.element) === c[next]);
        if (applied.length) {
          const remaining = changes.filter(c => !applied.includes(c));
          from.pop();
          if (remaining.length) from.push(remaining);
          to.push(applied);
        }
        throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
      if (changes.some(c => read(c.element) !== c[next])) throw new Error('The website did not keep the restored values. Check the form.');
      from.pop(); to.push(changes); result.filled = changes.map(c => c.label); return result;
    }
    if (action !== 'fill') throw new Error('Unknown field action.');
    const aliases = {
      'first name': 'given_name', 'given name': 'given_name', 'legal first name': 'given_name', 'prénom': 'given_name',
      'last name': 'family_name', 'family name': 'family_name', 'legal last name': 'family_name', 'nom de famille': 'family_name',
      'preferred name': 'preferred_name', 'email': 'email_address', 'email address': 'email_address', 'e-mail': 'email_address', 'adresse e-mail': 'email_address',
      'phone': 'phone_number', 'phone number': 'phone_number', 'mobile phone': 'phone_number', 'téléphone': 'phone_number',
      'city': 'city', 'ville': 'city', 'postal code': 'postal_code', 'zip code': 'postal_code', 'code postal': 'postal_code',
      'country': 'country', 'pays': 'country', 'state': 'region', 'province': 'region', 'state/province': 'region',
      'current company': 'current_company', 'current title': 'current_title', 'linkedin': 'linkedin_url', 'linkedin profile': 'linkedin_url',
    };
    const fact = id => facts.find(f => f.factId === id)?.value;
    const answer = label => {
      const key = norm(label);
      if (/^(full name|name|first (?:&|and) last name|legal first and last name|nom complet)$/.test(key)) {
        return typeof fact('given_name') === 'string' && typeof fact('family_name') === 'string' ? `${fact('given_name')} ${fact('family_name')}` : undefined;
      }
      return fact(aliases[key]);
    };
    const autocomplete = { 'given-name': 'First name', 'family-name': 'Last name', name: 'Full name', email: 'Email', tel: 'Phone', 'address-level2': 'City', 'address-level1': 'State', 'postal-code': 'Postal code', 'country-name': 'Country' };
    const controls = [...document.querySelectorAll('input,textarea,select')].filter(e => visible(e) && !e.disabled && !e.readOnly && !['hidden', 'password', 'file', 'submit', 'button', 'reset'].includes(e.type));
    const fields = controls.map(element => {
      const refs = (element.getAttribute('aria-labelledby') ?? '').split(/\s+/).map(id => document.getElementById(id)?.textContent ?? '').join(' ').trim();
      const label = element.getAttribute('aria-label') || refs || [...element.labels ?? []].map(l => {
        const copy = l.cloneNode(true); copy.querySelectorAll('input,textarea,select,button').forEach(e => e.remove()); return copy.textContent;
      }).join(' ').trim() || autocomplete[element.autocomplete] || element.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ') || element.placeholder;
      return { element, label, expected: answer(label) };
    });
    // A newsletter or account form must not receive application data.
    const regions = new Set(fields.filter(f => /name|prénom|nom de famille/i.test(f.label) && f.expected !== undefined).map(f => f.element.form || f.element.closest('[role=form]') || document.body));
    const applicationRegions = [...regions].filter(region => {
      const own = fields.filter(f => (f.element.form || f.element.closest('[role=form]') || document.body) === region);
      const candidates = [region];
      // Some employers split the resume upload and profile into sibling forms.
      let parent = region.parentElement;
      for (let depth = 0; depth < 3 && parent && parent !== document.body; depth++, parent = parent.parentElement) candidates.push(parent);
      return own.some(f => /e.?mail/i.test(f.label)) && ![...region.querySelectorAll('input[type=password]')].some(visible) &&
        candidates.some(container => container.querySelector('input[type=file]') || /submit application|apply for|job application|candidature/i.test(container.innerText ?? ''));
    });
    for (const f of fields) {
      const e = f.element, skip = reason => result.skipped.push({ label: f.label, reason });
      if (scope !== 'page' && !applicationRegions.includes(e.form || e.closest('[role=form]') || document.body)) { skip('application_form_not_identified'); continue; }
      if (e.type === 'checkbox' || e.type === 'radio' || e.multiple || e.getAttribute('role') === 'combobox' || e.getAttribute('aria-autocomplete')) { skip('choice_requires_mapping'); continue; }
      if (typeof f.expected !== 'string' || !f.expected) { skip('no_stored_mapping'); continue; }
      const region = e.form || e.closest('[role=form]') || document.body;
      if (fields.filter(other => norm(other.label) === norm(f.label) && (other.element.form || other.element.closest('[role=form]') || document.body) === region).length > 1) { skip('ambiguous_duplicate'); continue; }
      if (e.value && !(e instanceof HTMLSelectElement && e.selectedOptions[0]?.disabled)) { skip('existing_value_preserved'); continue; }
      let value = f.expected;
      if (e instanceof HTMLSelectElement) {
        const options = [...e.options].filter(o => !o.disabled && (norm(o.textContent) === norm(value) || norm(o.value) === norm(value)));
        if (options.length !== 1) { skip('option_not_found'); continue; }
        value = options[0].value;
      }
      checkDeadline();
      const before = e.value;
      write(e, value);
      await new Promise(resolve => setTimeout(resolve, 100));
      const after = e.value;
      if (!e.isConnected || (after !== value && !(/phone|téléphone/i.test(f.label) && after.replace(/\D/g, '') === value.replace(/\D/g, ''))) || !e.validity.valid || e.getAttribute('aria-invalid') === 'true') {
        if (e.isConnected && e.value === after) write(e, before);
        skip('value_not_accepted'); continue;
      }
      changes.push({ element: e, before, after, label: f.label }); result.filled.push(f.label);
    }
    return result;
  } finally {
    if (action === 'fill' && changes.length) { state.undo.push(changes); state.undo = state.undo.slice(-10); state.redo = []; }
    state.busy = false; result.canUndo = state.undo.length > 0; result.canRedo = state.redo.length > 0;
  }
}
