function collectAttachments(result, warnings, errors){
  const rows=result.skipped??[], reasons=new Set(rows.map(row=>row.reason));
  if(['undo','redo'].includes(result.operation) && (reasons.has('remote_upload_preserved')||reasons.has('client_attachment_preserved')))warnings.push('The attachment stayed on the employer page.');
  if(reasons.has('different_resume_requires_manual_review'))errors.push('Your selected PDF differs from the earlier resume selection on this page. Check which resume the employer has.');
  else if(reasons.has('resume_filename_differs'))errors.push('The employer shows a different resume filename. Check it against your selected PDF.');
  else if(result.resumeEvidence==='filename'||reasons.has('resume_filename_visible_contents_unverified'))warnings.push('The employer shows the matching resume filename. PDF contents unverified.');
  else if(result.resumeEvidence==='earlier_filename')warnings.push('The previous step showed the matching resume filename. PDF contents unverified.');
  else if(reasons.has('resume_filename_visible'))warnings.push('The employer shows a resume filename. Check it against your selected PDF. Contents unverified.');
  else if(reasons.has('resume_picker_occupied'))warnings.push('The local resume picker contains a file. Check it against your selected PDF. Employer contents unverified.');
  else if(['existing_attachment_preserved','existing_remote_attachment_requires_review','existing_smartrecruiters_attachment_requires_review','remote_upload_preserved','client_attachment_preserved'].some(reason=>reasons.has(reason)))warnings.push('A resume is already present. Check it against your selected PDF.');
  else if(reasons.has('required_resume_missing') || result.operation==='inspect' && result.resume==='missing')errors.push('The required resume field is empty.');
  else if(reasons.has('resume_control_not_identified'))errors.push('C3 could not identify the resume field. Check the employer page.');
  else if(['resume_attachment_not_verified','resume_upload_already_attempted_review_attachment','uploaded_attachment_requires_review','attachment_not_verified_native_file_retained','ambiguous_resume_attachment','resume_parsing_pending_profile_not_filled'].some(reason=>reasons.has(reason)))errors.push('The resume attachment was not confirmed. Check it on the employer page.');
  for(const row of rows){
    if(!['required_attachment_missing','required_attachment_unconfirmed'].includes(row.reason))continue;
    const name=/transcript|relev[ée] de notes/i.test(row.label)?'transcript':/cover[ -]?letter|lettre de/i.test(row.label)?'cover letter':'document';
    errors.push(row.reason==='required_attachment_missing'?`The required ${name} is missing.`:`Check the required ${name}. Its upload is unconfirmed.`);
  }
}

export function summarizeFill(result) {
  const profileCountryConflict=result.profileCountryConflict===true;
  const countryMismatch='Country is set to United States. Your profile uses Canada.';
  const warnings=[],errors=[],fieldIssues=[];
  for(const row of result.skipped??[]){
    if(row.reason==='radio_reset_unavailable')fieldIssues.push({label:row.label,message:'This form keeps a radio choice once selected. You can change the answer on the form.'});
    if(row.reason==='country_reset_unavailable')fieldIssues.push({label:row.label,message:'Undo kept the phone country because this form requires a selection. You can change it on the form.'});
  }
  const required=(result.requiredIssues??[]).map(target=>({
    label:target.label,
    message:target.reason==='required_empty'?'This required field is empty.':
      target.reason==='required_invalid'?'The current value needs a correction.':'C3 could not verify this required field.',
    target,
  }));
  const conflictItems=(result.skipped||[]).filter(item=>['saved_value_conflict','value_changed_after_fill'].includes(item.reason)
    && !(profileCountryConflict && item.reason==='saved_value_conflict' && /^country\b/i.test(item.label?.trim())));
  const cleanLabel=value=>String(value||'Field').replace(/[\u2009*✱]/g,'').trim();
  const observed=(result.matching??[]).filter(row=>row.canReveal && row.frameId && row.fieldId);
  const conflictMessage='The form value differs from your saved answer or changed after filling.';
  const suggestionMessage='Check the suggested answer on the form.';
  function addReview(label,message,row){
    label=cleanLabel(label);
    const target=row && {frameId:row.frameId,fieldId:row.fieldId};
    if(!fieldIssues.some(issue=>issue.label===label && issue.target?.frameId===target?.frameId && issue.target?.fieldId===target?.fieldId))
      fieldIssues.push({label,message,target});
  }
  for(const item of conflictItems){
    addReview(item.label,conflictMessage,item.fieldId && item.frameId ? item : undefined);
  }
  for(const row of observed)if(row.previousReview && (result.operation==='inspect' ||
    row.previousReview==='suggestion' && row.provisional && row.reason==='existing_value_confirmed'))
    addReview(row.question,row.previousReview==='conflict'?conflictMessage:suggestionMessage,row);
  collectAttachments(result, warnings, errors);
  const addressReason=result.skipped?.find(item=>['bamboo_address_change_unconfirmed','bamboo_address_restore_unconfirmed'].includes(item.reason))?.reason;
  if(addressReason)errors.push(addressReason==='bamboo_address_restore_unconfirmed'
    ? 'C3 could not verify the restored address. Check Country, region and postal code on the form.'
    : 'BambooHR did not confirm the address update. Check the address and your saved profile.');
  for(const label of new Set(result.reviewFields??[])){
    if(!label || required.some(issue=>issue.label===label))continue;
    const matches=observed.filter(row=>row.provisional && cleanLabel(row.question)===cleanLabel(label) &&
      !['existing_value_preserved','optional_field','existing_value_confirmed'].includes(row.reason));
    if(matches.length)for(const row of matches)addReview(label,suggestionMessage,row);
    else if(!fieldIssues.some(issue=>issue.label===label))addReview(label,suggestionMessage);
  }
  if (result.componentFailure && !addressReason) {
    const {component, operation} = result.componentFailure;
    errors.push('Check ' + component.replaceAll('_', ' ') + ' (' + operation.replaceAll('_', ' ') + ').');
  }
  const submissionDisabled=Boolean(result.skipped?.some(item=>item.reason==='employer_submission_disabled'));
  if(submissionDisabled)errors.push('The employer still has submission disabled.');
  if (result.frames?.some(frame => frame.status === 'unavailable')) {
    errors.push('C3 could not inspect an embedded section. Check it on the form.');
  } else if (result.incomplete && !result.componentFailure && !submissionDisabled && !addressReason && !required.length && !fieldIssues.length && !warnings.length && !errors.length && !profileCountryConflict) {
    errors.push('Check the incomplete fields before retrying.');
  }
  if(result.needsOwnerReview && !fieldIssues.length && !required.length && !errors.length && !warnings.length && !profileCountryConflict)
    warnings.push('Some answers need review. Check the page before continuing.');
  const normalize=str=>str.toLowerCase().replace(/[^a-z0-9]/g,'');
  const duplicatesRequired=message=>required.some(issue=>{
    const label=normalize(issue.label);
    return label && (message==='The required resume field is empty.' && /resume|cv/.test(label) ||
      /^The required .+ is missing\.$/.test(message) && normalize(message.slice(13,-12))===label);
  });
  const secondary=[...new Set([...errors,...warnings])].filter(text=>!duplicatesRequired(text));
  const issues=[...required,...fieldIssues,...(profileCountryConflict?[{label:'Country',message:countryMismatch,country:true}]:[]),
    ...secondary.map(message=>({label:message.includes('resume')||message.includes('PDF')?'Review attachment':'Check the form',message}))];
  const count=result.filled?.length??0;
  const summary=result.operation==='inspect'?'':result.operation==='undo'?count+' field changes undone.':
    result.operation==='redo'?count+' field changes restored.':count+' '+(count===1?'field changed.':'fields changed.');
  const note=result.resumeEvidence==='picker'?'The local file picker matches the selected PDF. Employer contents unverified.':'';
  return {issues,summary:issues.length?'':[summary,note].filter(Boolean).join(' ')};
}

// A fresh inspection can clear a field only if it actually read that frame.
// Keep notices for which the fill is the only source of evidence.
export function reconcileFieldReview(previous,index,result) {
  const same=(a,b)=>a?.target && b?.target
    ? a.target.frameId===b.target.frameId && a.target.fieldId===b.target.fieldId
    : !a?.target && !b?.target && a?.label===b?.label && a?.message===b?.message;
  const current=summarizeFill(result).issues;
  // "partial" is the normal current-page fill scope, including successful inspections.
  const inspected=new Set(result.frames?.filter(frame=>['complete','partial'].includes(frame.status)).map(frame=>frame.frameId));
  const issues=[];
  for(const old of previous){
    const fresh=current.find(item=>same(item,old));
    if(fresh)issues.push(fresh);
    else if(old.target ? !inspected.has(old.target.frameId) || result.componentFailure :
      !old.country || result.profileCountryConflict || result.componentFailure)issues.push(old);
  }
  for(const item of current)if((item.target || item.country) && !issues.some(old=>same(old,item)))issues.push(item);
  const retained=issues.findIndex(item=>same(item,previous[index]));
  return {issues,index:retained>=0?retained:Math.max(0,Math.min(index,issues.length-1))};
}

export async function saveFillReview(tabId,page,documentId,issues,index=0,status={}) {
  const listed=issues.map(({label,message,country,target})=>({
    label,message,...(country && {country:true}),
    ...(target && {target:{frameId:target.frameId,fieldId:target.fieldId,...(target.section && {section:target.section})}})
  }));
  const review={page,documentId,index,token:crypto.randomUUID(),issues:listed,
    targets:listed.map(issue=>issue.target ? {frameId:issue.target.frameId,fieldId:issue.target.fieldId} : null),...status};
  await chrome.storage.session.set({['fillReview:'+tabId]:review});
  return review;
}

export async function showPageReview(tabId,expectedUrl,saved,browserDocumentId) {
  const items=saved?.issues?.map(issue=>({label:issue.label,section:issue.target?.section,message:issue.country
    ? issue.message+' Open Hunt to use your profile country.' : issue.message,canShow:Boolean(issue.target)}));
  const review=items?.length || saved?.liveUpdate ? {token:saved.token,index:saved.index,items,liveUpdate:!!saved.liveUpdate} : null;
  const options=browserDocumentId ? {documentId:browserDocumentId} : {frameId:0};
  const send=()=>chrome.tabs.sendMessage(tabId,{action:'renderFieldReview',expectedUrl,review},options);
  try{
    try{return await send()===true;}catch(error){
      if(!review || !/receiving end does not exist/i.test(error.message))return false;
    }
    const target=browserDocumentId ? {tabId,documentIds:[browserDocumentId]} : {tabId,frameIds:[0]};
    await chrome.scripting.executeScript({target,files:['field-review.js']});
    return await send()===true;
  }catch{return false;}
}
