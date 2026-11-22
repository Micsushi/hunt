/** Lever wraps its question, picker and every parsing status in one native label. */
export function leverResumeTitle(input) {
  if (!['https://jobs.lever.co','https://jobs.eu.lever.co'].includes(location.origin)) return null;
  const selector = 'input[type=file][name=resume][data-qa=input-resume]';
  input ??= document.querySelector(selector);
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
  // The shared owner reader checks the native input, wrapping label and headings.
  // Keep other named children intact as conflicting evidence, even if their visible text is empty.
  if (fields[0].querySelector(':not(input):is([aria-label],[aria-labelledby],[aria-describedby])')) return null;
  const prompt = picker.querySelector(':scope > .default-label');
  if (!/^attach resume\s*\/\s*cv$/i.test(prompt?.textContent.trim() || '')) return null;
  const rest = label.cloneNode(true);
  rest.querySelector(':scope > .application-label').remove();
  const field = rest.querySelector(':scope > .application-field');
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
  if (rest.textContent.trim()) return null;
  return titles[0];
}
