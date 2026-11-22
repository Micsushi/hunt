// A file picker action describes how to select a file, not which document belongs there.
export function uploadLabelKind(value) {
  const label = String(value ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[✱*]/g, '').replace(/\s+/g, ' ').replace(/\s*[:：]\s*$/, '').trim();
  const formatHint = text => {
    const formats = /\b(?:pdf|docx?|rtf|odt|txt|word)\b/g;
    const sizes = /\b\d+(?:[.,]\d+)?\s*(?:kb|mb|ko|mo)\b/g;
    if (!text.match(formats) && !text.match(sizes)) return false;
    return !text.replace(formats, '').replace(sizes, '')
      .replace(/\b(?:accepted|accepts|allowed|supported|formats?|files?|types?|are|only|or|and|max(?:imum)?|size|limit|up to|au format|ou|et|taille|maximale?|acceptes?|autorises?)\b/g, '')
      .replace(/[\s.(),:;|/+\-–—<>]/g, '');
  };
  const purpose = /^(?:(?:upload|attach|add|select|choose)(?:\s+(?:your|a))?\s+|(?:veuillez\s+)?(?:televerser|telecharger|joindre|joignez|ajouter|deposer|selectionner)(?:\s+(?:votre|un|le))?\s+|your\s+|votre\s+)?(?:resume|cv|curriculum vit(?:ae|æ)(?:\s*\(cv\))?)(?:(?:\s*\/\s*|\s+(?:or|ou)\s+)(?:resume|cv))?(?=$|[\s(:\-–—,])/;
  const match = purpose.exec(label);
  if (match) {
    const suffix = label.slice(match[0].length).trim().replace(/^\((?:required|optional|obligatoire|facultatif)\)\s*/,'');
    if (!suffix || formatHint(suffix)) return 'resume';
  }
  if (!label || formatHint(label)) return 'action';
  const picker = /^(?:file(?:-input)?|(?:attach|replace|choose|select|upload|browse)(?:\s+(?:a |your )?files?)?|drop or select (?:your )?files?|choose a file or drop it here|(?:click to upload|browse files?)(?: or drag and drop)?|(?:drag(?: and| &)?)?\s*drop (?:a |your )?files? here(?: or (?:click to )?(?:browse|select|choose)(?: (?:a )?files?)?)?|click (?:here )?to (?:browse|select|upload)(?: (?:a )?files?)?|parcourir|(?:choisir|selectionner|televerser) (?:un |des |vos )?fichiers?|glissez[- ]deposez (?:un |vos )?fichiers? ici)$/;
  if (picker.test(label)) return 'action';
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
    const visibleHeadings = [];
    let ambiguous = false;
    const names = (node, destination=labels) => {
      destination.push(node.getAttribute('aria-label') || '');
      const ids = (node.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
      for (const [index,id] of ids.entries()) {
        const refs=node.getRootNode().querySelectorAll('[id="'+CSS.escape(id)+'"]');
        if (refs.length>1 || index===0 && refs.length===0) ambiguous=true;
        if (refs.length===1 && refs[0]!==input) {
          const text=refs[0].textContent || '';
          destination.push(text);
          if (index===0 && !text.trim() && !refs[0].getAttribute('aria-label')?.trim()) ambiguous=true;
          destination.push(refs[0].getAttribute('aria-label') || '');
        }
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
      const preceding = group.matches('.application-field') && group.previousElementSibling?.matches('.application-label') ? group.previousElementSibling : null;
      if (preceding) headings.push(preceding);
      if (controls.length!==1 || controls[0]!==input) {
        // A file group may also own a notes input. Its explicit title can veto a
        // contradictory picker, but cannot establish a positive resume binding.
        if (controls.filter(node=>node.matches('input[type=file]')).length!==1) break;
        const titles = [];
        names(group,titles);
        for (const title of headings) {
          let container = parent(title);
          while (container && container!==group && !container.matches(owner)) container=parent(container);
          if (container!==group && title!==preceding) continue;
          names(title,titles);
          titles.push(title.textContent || '');
        }
        // A section called "Your documents" is neutral when it owns several controls.
        labels.push(...titles.filter(text => !/^(?:(?:your|my|application|required) )?(?:documents|attachments|files)$/i.test(text.trim())));
        continue;
      }
      names(group);
      if (group.getClientRects().length && group.checkVisibility({visibilityProperty:true,opacityProperty:true}) &&
          !group.closest('[hidden],[inert],[aria-hidden=true]')) visibleHeadings.push(group.getAttribute('aria-label') || '');
      for (const title of headings) {
        names(title);
        const text=title.textContent || '';
        labels.push(text);
        if (title.getClientRects().length && !title.closest('[hidden],[inert],[aria-hidden=true]') &&
            title.checkVisibility({visibilityProperty:true,opacityProperty:true})) visibleHeadings.push(text);
      }
    }
    return {key:input.getAttribute('data-c3-hosted'), labels, visibleHeadings, ambiguous};
  });
}
