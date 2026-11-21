export function createUploadVerification({ deepQuery, composedContains, uploadSuccess, verifiedClientAttachment, state, regionFor, norm, resumeLabel }) {
  const attachmentIds = group => deepQuery(group,'input[type=hidden]').filter(input=>
    /^(?:(?:resume|cv|attachment|upload|file)[_.-]?)*(?:file[_.-]?)?id$/i.test(input.name) && input.name.toLowerCase()!=='id');
  const uploadRemoveControls = (owner,fileName) => deepQuery(owner,'button,[role=button]').filter(button=> {
    if(button.disabled || button.getAttribute('aria-disabled')==='true')return false;
    const refs=(button.getAttribute('aria-labelledby')??'').split(/\s+/).filter(Boolean);
    const labels=refs.map(id=>[...button.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)]);
    const name=refs.length && labels.every(matches=>matches.length===1 && composedContains(owner,matches[0])) ? labels.map(matches=>matches[0].textContent).join(' ') : button.getAttribute('aria-label')||button.textContent;
    return ['remove','delete','remove file','delete file','remove attachment','delete attachment',`remove ${fileName}`,`delete ${fileName}`].some(expected=>norm(name)===norm(expected));
  });
  const ownedUploadCompleted = receipt => {
    const group=receipt?.owner;
    if(!group?.isConnected || !receipt.region.isConnected || !composedContains(receipt.region, group) ||
       !receipt.selectedFileAccepted || state.fileEvents?.get(receipt.element)!==receipt.file || !receipt.fileSha256 || receipt.clientInvalidated || receipt.hadAttachmentId || receipt.hadUploadSuccess ||
       receipt.element.isConnected && (!composedContains(group, receipt.element) || regionFor(receipt.element)!==receipt.region))return false;
    const ids=attachmentIds(group).filter(input=>input.value);
    const hasName = group.textContent.includes(receipt.file.name) || deepQuery(group,'*').some(node=>node.textContent.includes(receipt.file.name));
    if(uploadRemoveControls(group,receipt.file.name).length!==1 || !hasName ||
       group.matches('[aria-busy=true],[aria-invalid=true]') || deepQuery(group,'[aria-busy=true],[role=progressbar],[aria-invalid=true]').length ||
       [group,...deepQuery(group,'*')].some(node=>/\b(?:uploading|upload failed|upload error|invalid file)\b/i.test(node.innerText??'')))return false;
    if(ids.length===1) {
      const id=ids[0].name+':'+ids[0].value;
      if(receipt.attachmentId && receipt.attachmentId!==id)return false;
      receipt.attachmentId=id;return true;
    }
    if(ids.length || receipt.attachmentId)return false;
    if (receipt.clientOnly) return verifiedClientAttachment(receipt, group, resumeLabel, uploadRemoveControls, deepQuery);
    const success=uploadSuccess(group,receipt.file.name);
    if(success.length!==1 || receipt.successStatus && receipt.successStatus!==success[0])return false;
    receipt.successStatus=success[0];return true;
  };
  return { attachmentIds, uploadRemoveControls, ownedUploadCompleted };
}
