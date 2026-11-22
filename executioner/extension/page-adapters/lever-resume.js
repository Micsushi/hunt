/** Lever wraps its question, picker and every parsing status in one native label. */
export function createLeverResumeTitleReader() {
  if (!['https://jobs.lever.co','https://jobs.eu.lever.co'].includes(location.origin)) return () => null;
  const clean = text => (text || '').replace(/\s+/g,' ').trim();
  const oversizeMessage = /^file exceeds the maximum upload size of \d+\s*(?:kb|mb)\. please try a smaller size\.$/i;
  const allowedHint = value => {
    const text = clean(value);
    if (!text || oversizeMessage.test(text) || /^(?:[✱*]|(?:required|optional)(?: field)?|(?:(?:attach|upload) (?:your )?)?(?:résumé|resume|cv)(?:\s*\/\s*cv)?\s*[✱*]?|analyzing resume\.{3}|couldn't auto-read resume\.|success!)$/i.test(text)) return true;
    // A size/format instruction may name formats and limits, never additional document purposes.
    if (!/\b(?:pdf|docx?|rtf|odt|txt|word)\b|\d\s*(?:kb|mb)\b/i.test(text)) return false;
    return !text.replace(/\b\d+(?:[.,]\d+)?\s*(?:kb|mb)\b/gi,'').replace(/\b(?:pdf|docx?|rtf|odt|txt|word|accepted|accepts|allowed|supported|formats?|files?|types?|are|only|or|and|max(?:imum)?|size|limit|up|to)\b/gi,'').replace(/[\s.(),:;/|+\-–—]/g,'');
  };
  const attributes = ['aria-label','aria-description','alt','title'];
  const references = ['aria-labelledby','aria-describedby','aria-details','aria-errormessage'];
  const named = [...attributes,...references].map(key=>'['+key+']').join(',');
  return input => {
    const checked = new Set();
    function checkNames(node) {
      if (checked.has(node)) return true;
      checked.add(node);
      if (attributes.some(name=>!allowedHint(node.getAttribute(name)))) return false;
      for (const attr of references) for (const id of clean(node.getAttribute(attr)).split(' ').filter(Boolean)) {
        const targets=node.getRootNode().querySelectorAll('[id="'+CSS.escape(id)+'"]');
        if (targets.length!==1 || !allowedHint(targets[0].textContent) ||
            ![targets[0],...targets[0].querySelectorAll(named)].every(checkNames)) return false;
      }
      return true;
    }
    const selector = 'input[type=file][name=resume][data-qa=input-resume]';
    if (!input?.matches(selector) || input.multiple || input.getRootNode().querySelectorAll(selector).length !== 1) return null;
    const question = input.closest('li.application-question.resume');
    const label = input.closest('label');
    if (!question || label?.parentElement !== question || input.labels.length !== 1 || label.control !== input ||
        question.querySelectorAll('input:not([type=hidden]),select,textarea').length !== 1) return null;
    const titles = label.querySelectorAll(':scope > .application-label');
    const fields = label.querySelectorAll(':scope > .application-field');
    const picker = input.closest('a.visible-resume-upload[href="#"]');
    if (titles.length !== 1 || fields.length !== 1 || picker?.parentElement !== fields[0] ||
        fields[0].querySelectorAll(':scope > a.visible-resume-upload').length !== 1 ||
        !titles[0].checkVisibility({visibilityProperty:true,opacityProperty:true}) ||
        titles[0].closest('[hidden],[inert],[aria-hidden=true]')) return null;
    const prompt = picker.querySelector(':scope > .default-label');
    if (!/^attach resume\s*\/\s*cv$/i.test(prompt?.textContent.trim() || '')) return null;
    if (![question,...question.querySelectorAll(named)].every(checkNames)) return null;
    const rest = question.cloneNode(true);
    rest.querySelector(':scope > label > .application-label').remove();
    const field = rest.querySelector(':scope > label > .application-field');
    const pickerCopy = field.querySelector(':scope > a.visible-resume-upload');
    pickerCopy.querySelector(':scope > .default-label').remove();
    const filename = pickerCopy.querySelector(':scope > .filename');
    if (input.files?.length === 1 && filename?.textContent.trim() === input.files[0].name) filename.remove();
    for (const [selector, message] of [
      ['.resume-upload-failure',"Couldn't auto-read resume."],
      ['.resume-upload-working','Analyzing resume...'],
      ['.resume-upload-success','Success!'],
    ]) {
      const status = field.querySelector(':scope > ' + selector);
      if (status?.textContent.trim() === message) status.remove();
    }
    const oversize = rest.querySelector(':scope > .resume-upload-oversize');
    if (oversize && oversizeMessage.test(clean(oversize.textContent))) oversize.remove();
    if (!allowedHint(rest.textContent)) return null;
    return titles[0];
  };
}
