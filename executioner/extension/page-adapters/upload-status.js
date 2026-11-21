// These upload widgets expose completion and parsing progress as rendered messages.
export function createUploadStatusReader(norm, deepQuery) {
  const parserComplete = () => /résumé parsing was successful\./i.test(document.body?.innerText ?? '');
  const parserBusy = () => /(?:parsing (?:your )?(?:résumé|resume)|(?:résumé|resume) (?:is being parsed|parsing (?:in progress|has started)))/i.test(document.body?.innerText ?? '');
  const uploadSuccess = (owner,fileName) => deepQuery(owner,'[role=status],[aria-live]').filter(node=>
    norm(node.textContent)===norm(`File ${fileName} uploaded successfully`));
  const hasPdfUploadNotice = text => /file .+\.pdf uploaded successfully/i.test(text);
  return {parserComplete, parserBusy, uploadSuccess, hasPdfUploadNotice};
}
