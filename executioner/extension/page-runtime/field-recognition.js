import {uploadLabelKind} from './upload-label.js';

export function createFieldRecognition({ addressGroupLabel, wrappedUploadTitle, composedClosest, deepQuery, fabricWidget, norm }) {
  const semanticChoiceButton = e => e.tagName==='BUTTON' && (e.getAttribute('aria-haspopup')==='listbox' || e.getAttribute('role')==='combobox') && !fabricWidget(e);
  const rawLabelFor = element => {
    if(semanticChoiceButton(element)) {
      const owned=[...element.labels??[]].filter(label=>label.control===element);
      if(owned.length && element.id && deepQuery(element.getRootNode(),`[id="${CSS.escape(element.id)}"]`).length===1) {
        return owned.map(label=>{const copy=label.cloneNode(true);copy.querySelectorAll('button,input,select,textarea').forEach(node=>node.remove());return copy.textContent;}).join(' ').trim();
      }
    }
    const fabric=fabricWidget(element);
    if(fabric)return [...fabric.backing.labels??[]].map(label=>label.textContent).join(' ').trim();
    const ids=(element.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
    const labelled=ids.map(id=>[...element.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
    const refs=labelled.length && labelled.every(matches=>matches.length===1) ? labelled.filter(matches=>!semanticChoiceButton(element) || matches[0]!==element && !element.contains(matches[0])).map(matches=>matches[0].textContent??'').join(' ').trim() : '';
    return refs || element.getAttribute('aria-label') || [...element.labels ?? []].map(l => {
      const title = element.type === 'file' && wrappedUploadTitle(element);
      if (title?.parentElement === l) return title.textContent;
      const copy = l.cloneNode(true); copy.querySelectorAll('input,textarea,select,button').forEach(e => e.remove()); return copy.textContent;
    }).join(' ').trim() || addressGroupLabel(element,norm) || ({'given-name':'First name','family-name':'Last name',name:'Full name',email:'Email',tel:'Phone','address-line1':'Address line 1','address-line2':'Address line 2','address-level2':'City','address-level1':'State','postal-code':'Postal code','country-name':'Country'}[element.autocomplete]) || element.name.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ') || element.placeholder || '';
  };
  const labelFor = element => element.getAttribute('data-hunt-question-context') ?? rawLabelFor(element);
  const resumeLabel = text => uploadLabelKind(text)==='resume';
  const otherAttachment = text => /\b(?:cover\s*letter|photo(?:graph)?|headshot|transcript|certificate|portfolio|relev[ée] de notes|lettre de (?:motivation|pr[ée]sentation))\b/i.test(norm(text));
  return { semanticChoiceButton, rawLabelFor, labelFor, resumeLabel, otherAttachment };
}
