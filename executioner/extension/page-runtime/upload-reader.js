import {uploadLabelKind,readUploadOwnerLabels,createInlineUploadLabelReader} from './upload-label.js';

export function createUploadReader({ isPortalResumeBinding, uploadHeading, wrappedUploadTitle,
  state, regionFor, deepQuery, composedClosest, composedParent, composedContains, visible, editable, norm, verifiedDialogUpload, resumeLabel, otherAttachment
}) {
  const inlineUploadLabel=createInlineUploadLabelReader();
  const fileBinding = e => {
    if (!e.isConnected || e.type !== 'file' || e.disabled || e.readOnly || e.matches(':disabled') || composedClosest(e,'[inert]')) return null;
    const wrappingLabel = e.closest('label');
    if (wrappingLabel && wrappingLabel.control !== e) return null;
    const labels = [...e.labels ?? []].filter(label=>label.control === e);
    const widgetVisible = node => visible(node) && Number(getComputedStyle(node).opacity) > 0;
    const nativeVisible = editable(e) && widgetVisible(e);
    const proven=state.nativeFileBindings?.get(e);
    const refs = node => (node.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean).flatMap(id => {
      const matches = [...node.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)];
      return matches.length === 1 && matches[0] !== e && widgetVisible(matches[0]) ? matches : [];
    });
    const title = wrappedUploadTitle(e);
    const inline=inlineUploadLabel(e);
    const bound=widget=>({label:'Resume',widget,...inline && {renderedFilename:inline.filename}});
    const text = [e.getAttribute('aria-label') ?? '', ...refs(e).map(node=>node.textContent ?? ''),
      ...labels.flatMap(label=>[label.getAttribute('aria-label') ?? '', ...refs(label).map(node=>node.textContent ?? ''),
        inline?.title ?? (title?.parentElement === label ? title : label).textContent ?? ''])];
    const fieldset = composedClosest(e,'fieldset');
    const legend = fieldset?.querySelector(':scope > legend');
    if (legend && fieldset.querySelectorAll('input:not([type=hidden]),select,textarea').length===1) text.push(legend.textContent ?? '');
    const [owner] = readUploadOwnerLabels([e]);
    if (owner.ambiguous || [...text,...owner.labels].some(label=>uploadLabelKind(label)==='other')) return null;
    if (isPortalResumeBinding(proven)) {
      const proof=verifiedDialogUpload(e);
      return proof && !e.multiple ? bound(proof.label) : null;
    }
    if (proven && regionFor(e)===proven.region &&
        proven.region.isConnected && proven.group.isConnected && proven.button.isConnected &&
        proven.group.contains(e) && proven.group.contains(proven.button) &&
        deepQuery(proven.group,'input[type=file]').length===1 && widgetVisible(proven.button) &&
        !composedClosest(proven.button,'[inert],[aria-hidden=true]') &&
        resumeLabel((proven.group.innerText??'').split('\n').find(line=>line.trim())??'') &&
        !proven.button.disabled && proven.button.type==='button' && norm(proven.button.textContent)==='choose file') {
      return bound(proven.button);
    }
    const boundLabels = labels.filter(label=>widgetVisible(label) && !composedClosest(label,'[aria-hidden="true"],[inert]') &&
      deepQuery(label,'input[type=file]').length <= 1);
    const uploadGroup=composedClosest(e,'[role=group][aria-labelledby]');
    if (uploadGroup && uploadGroup!==regionFor(e)) {
      const ids=(uploadGroup.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
      const names = ids.flatMap(id=>[...uploadGroup.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
      if (!names.length) return null;
      const primary = names[0];
      const namedGroups=deepQuery(uploadGroup.getRootNode(),'[role=group][aria-labelledby]').filter(group=>
        (group.getAttribute('aria-labelledby')??'').split(/\s+/).includes(ids[0]));
      const labelGroup=primary.closest('[role=group]');
      if(namedGroups.length!==1 || regionFor(primary)!==regionFor(e) || labelGroup && labelGroup!==uploadGroup)return null;
      const name=widgetVisible(primary) ? primary.textContent??'' : '';
      if (resumeLabel(name)) {
        if (!widgetVisible(uploadGroup) || composedClosest(uploadGroup,'[aria-hidden=true],[inert]') ||
            deepQuery(uploadGroup,'input,textarea,select').some(control=>control!==e)) return null;
        if (nativeVisible || boundLabels.length===1 && composedContains(uploadGroup,boundLabels[0])) return bound(uploadGroup);
        return null;
      }
    }
    if ([...text,...owner.visibleHeadings].some(resumeLabel)) {
      if (nativeVisible) return bound(e);
      if (boundLabels.length === 1) return bound(boundLabels[0]);
    }
    // Some native inputs have only a technical aria-label. Stay inside their
    // nearest small upload field, never a whole form or an unrelated heading.
    const region = regionFor(e);
    let group = composedParent(e);
    for (let depth=0; depth<6 && group && group !== region && group !== document.body; depth++,group=composedParent(group)) {
      if (deepQuery(group,'input[type=file]').length !== 1 ||
          deepQuery(group,'input,textarea,select').some(control=>control!==e && control.type!=='hidden')) return null;
      if (!widgetVisible(group) || composedClosest(group,'[aria-hidden="true"],[inert]')) continue;
      const lines=(group.innerText ?? '').split(/\n/).map(line=>line.trim()).filter(Boolean);
      if (lines.some(otherAttachment)) return null;
      const headings=[...group.children].filter(child=>child.matches('h1,h2,h3,h4,h5,h6,[role=heading],' + uploadHeading));
      if (!resumeLabel(lines[0] ?? '') && !(headings.length===1 && resumeLabel(headings[0].textContent))) continue;
      const visibleWidget=nativeVisible || boundLabels.some(label=>composedContains(group,label));
      if (visibleWidget) return bound(group);
    }
    return null;
  };
  const uploadOwner = e => {
    const proven=state.nativeFileBindings?.get(e)?.group;
    for(let group=proven??composedParent(e),depth=0;group && depth<6 && group!==regionFor(e) && group!==document.body;group=composedParent(group),depth++) {
      if(deepQuery(group,'input[type=file]').length>1 || deepQuery(group,'input,textarea,select').some(control=>control!==e && control.type!=='hidden'))return null;
      if(resumeLabel((group.innerText??'').split('\n').find(line=>line.trim())??''))return group;
    }
    return null;
  };
  return { fileBinding, uploadOwner };
}
