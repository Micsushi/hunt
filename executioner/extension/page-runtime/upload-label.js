// A file picker action describes how to select a file, not which document belongs there.
export function uploadLabelKind(value) {
  const label = String(value ?? '').normalize('NFKC').replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/\s*[:：]\s*$/, '').trim();
  if (/^(?:(?:upload|attach|add)\s+)?(?:your\s+)?(?:r[eé]sum[eé]|cv|curriculum vitae)(?:(?:\s*\/\s*|\s+or\s+)(?:r[eé]sum[eé]|cv))?(?:\s*\((?:required|optional)\))?$/i.test(label)) return 'resume';
  if (!label || /^(?:file(?:-input)?|(?:attach|replace|choose|select|upload|browse)(?:\s+(?:a |your )?files?)?|drop or select (?:your )?files?|choose a file or drop it here)$/i.test(label)) return 'action';
  return 'other';
}

// Read corroborating labels, including hidden accessible names. A contradiction can veto an upload
// even when a hidden reference could not, on its own, identify a visible picker.
export function readUploadOwnerLabels(inputs) {
  const heading = 'legend,h1,h2,h3,h4,h5,h6,[role=heading],.application-label,.application-question-title';
  const owner = 'fieldset,[role=group],.application-field,.application-question,.ashby-application-form-field-entry,.field';
  const parent = node => node.assignedSlot || node.parentElement || node.getRootNode().host;
  const children = node => node.localName==='slot' ? node.assignedElements({flatten:true}) : (node.shadowRoot || node).children;
  return inputs.map(input=>{
    const labels = [];
    let ambiguous = false;
    const names = node => {
      labels.push(node.getAttribute('aria-label') || '');
      for (const id of (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
        const refs=node.getRootNode().querySelectorAll('[id="'+CSS.escape(id)+'"]');
        if (refs.length!==1) ambiguous=true;
        else if (refs[0]!==input) labels.push(refs[0].textContent || '');
      }
    };
    names(input);
    for (const label of input.labels || []) names(label);
    for (let group=parent(input); group && !group.matches('body,form,[role=form]'); group=parent(group)) {
      if (!group.matches(owner)) continue;
      const controls=[], headings=[];
      const visit = node => {
        if (node.matches('input:not([type=hidden]),textarea,select')) controls.push(node);
        if (node.matches(heading) && (!node.matches('legend') || node.parentElement===group)) headings.push(node);
        for (const child of children(node)) visit(child);
      };
      visit(group);
      if (controls.length!==1 || controls[0]!==input) break;
      names(group);
      if (group.matches('.application-field') && group.previousElementSibling?.matches('.application-label')) headings.push(group.previousElementSibling);
      for (const title of headings) {
        names(title);
        labels.push(title.textContent || '');
      }
    }
    return {key:input.getAttribute('data-c3-hosted'), labels, ambiguous};
  });
}
