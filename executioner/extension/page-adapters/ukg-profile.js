// Read-only evidence from UKG's profile editor on the current application.
export function readUkgRequiredControl(input, shown) {
  if (!/^recruiting\d*\.ultipro\.(?:ca|com)$/i.test(location.hostname) ||
      !/\/JobBoard\/[^/]+\/OpportunityApply\/?$/i.test(location.pathname) ||
      !input.matches('input.tt-input[type=text],input.tt-input:not([type])')) return;
  const field = input.closest('.form-group');
  const kind = input.getAttribute('data-automation');
  const binding = input.getAttribute('data-bind') || '';
  const invalid = input.getAttribute('aria-invalid')==='true' || field?.classList.contains('has-error');
  if (kind==='school-textbox' || kind==='degree-textbox') {
    const name = kind==='school-textbox' ? 'SchoolName' : 'DegreeName';
    if (!input.closest('[data-automation="panel-list-item"]') || input.getAttribute('role')!=='combobox' ||
        !new RegExp('(?:^|,)\\s*value\\s*:\\s*'+name+'\\s*(?:,|$)').test(binding) ||
        !/\btypeahead\s*:/.test(binding) || /\bonSelected\s*:/.test(binding)) return;
    if (invalid || !input.validity.valid && !input.validity.valueMissing) return 'required_invalid';
    if (!input.value.trim()) return 'required_empty';
    // Here the name itself is the employer's value. A separate list option
    // or hidden ID is not part of this particular text binding.
    return input.getAttribute('aria-expanded')==='true' ||
      [...input.parentElement.querySelectorAll('.tt-suggestion')].some(shown) ? 'required_unconfirmed' : 'complete';
  }
  const body = input.closest('.panel-body');
  if (kind!=='item-typeahead' || !body || !body.closest('#skills-panel,[data-automation="skills-panel"]') ||
      body.querySelectorAll('[data-automation="item-typeahead"]').length!==1 ||
      !body.querySelector('[data-automation="item-add-button"]')) return;
  const list = body.querySelector('[data-automation="skills-panel"]');
  if (!list) return;
  if (invalid || [...body.querySelectorAll('[data-automation="error-messages"]')].some(e=>shown(e) && e.textContent.trim()))
    return 'required_invalid';
  const committed = [...list.querySelectorAll('[data-automation="selected-item"] [data-automation="skill-label"]')]
    .some(label=>shown(label) && label.textContent.trim() && /\btext\s*:\s*SkillName\b/.test(label.getAttribute('data-bind') || ''));
  if (committed) return 'complete';
  return input.value.trim() ? 'required_unconfirmed' : 'required_empty';
}
