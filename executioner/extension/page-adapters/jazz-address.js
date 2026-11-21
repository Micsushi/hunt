export function addressGroupLabel(e, norm) {
  const labels={'resumator-address-value':'Address','resumator-city-value':'City','resumator-state-value':'State/Province','resumator-postal-value':'Postal'};
  const expected=labels[e.id],group=e.closest('.form-group#resumator-address');
  if (!expected || !group || e.name!==e.id || e.type!=='text' || e.placeholder!==expected ||
      e.closest('.form-group')!==group || !group.querySelector('#resumator-address-field')?.contains(e)) return '';
  const heading=[...group.children].filter(child=>child.matches('label#resumator-address-label[for="resumator-address-value"]'));
  if (heading.length!==1 || norm(heading[0].textContent)!=='address' || heading[0].control?.id!=='resumator-address-value' ||
      e.getRootNode().querySelectorAll(`[id="${e.id}"]`).length!==1) return '';
  return expected==='Postal'?'Postal code':expected;
}
