// Some application forms keep a selected file in the document instead of uploading it remotely.
export function clientAttachmentState(owner, binding) {
  const clientOnly = !!owner?.matches('[role=group][aria-labelledby][data-allow-s3=false]') && binding?.widget === owner;
  const ids = clientOnly ? (owner.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean) : [];
  const headings = ids.length === 1 ? [...owner.getRootNode().querySelectorAll(`[id="${CSS.escape(ids[0])}"]`)] : [];
  return {clientOnly, clientHeading:headings.length === 1 ? headings[0] : null};
}

export function verifiedClientAttachment(receipt, group, resumeLabel, uploadRemoveControls, deepQuery) {
  const heading=receipt.clientHeading,ids=(group.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
  const headings=ids.length===1?[...group.getRootNode().querySelectorAll(`[id="${CSS.escape(ids[0])}"]`)]:[];
  const filenames=deepQuery(group,'p').filter(node=>node.textContent.trim()===receipt.file.name);
  if(group.getAttribute('data-allow-s3')!=='false' || group.getAttribute('role')!=='group' || headings.length!==1 || headings[0]!==heading ||
     !resumeLabel(heading.textContent) || deepQuery(group,'input[type=file]').length || filenames.length!==1 ||
     receipt.clientFilename && receipt.clientFilename!==filenames[0] || receipt.clientRemove && receipt.clientRemove!==uploadRemoveControls(group,receipt.file.name)[0])return false;
  receipt.clientFilename=filenames[0];
  if(!receipt.clientRemove) {
    receipt.clientRemove=uploadRemoveControls(group,receipt.file.name)[0];
    receipt.clientRemove.addEventListener('click',()=>{receipt.clientInvalidated=true;},{capture:true,once:true});
  }
  return true;
}
