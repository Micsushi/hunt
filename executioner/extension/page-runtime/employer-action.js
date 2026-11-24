import { fillPageDocument } from './serialize.js';
import { observeCurrentDocument } from '../page-adapters/document.js';
import { currentPageInterruption } from '../form-page.js';
import { inspectChoiceWidget } from '../shared-choice-widget.js';
import { annotateQuestionContext } from '../question-context.js';
import { proveJobviteResumeInput } from '../jobvite-resume.js';

export function revealPageField(fieldId) {
  const state=globalThis.__huntC3PartialFill;
  const field=state?.requiredIssueTargets?.get(fieldId)?.() ?? state?.matchingReviewTargets?.get(fieldId)?.();
  if(!field?.isConnected)return false;
  field.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
  field.animate([{outline:'3px solid #185dd0',outlineOffset:'2px'},{outline:'3px solid #185dd0',outlineOffset:'2px'}],1800);
  return true;
}

// Also serialized for the debugger transport. Both transports verify the same
// controls and keep all values and history inside the selected employer page.
export async function runEmployerAction(input) {
  if(location.href!==input.expectedUrl || Date.now()>=input.expiresAt)throw new Error('The inspected frame changed.');
  if(input.action==='reveal')return revealPageField(input.fieldId);
  const observation=observeCurrentDocument(input.expectedUrl);
  const blocked=currentPageInterruption(observation,input.action,true);
  if(blocked)return blocked;
  globalThis.__huntC3ChoiceWidget=inspectChoiceWidget;
  annotateQuestionContext();
  if(input.action==='fill' && input.resume)await proveJobviteResumeInput(input);
  const result=await fillPageDocument(input);
  if(location.href!==input.expectedUrl)throw new Error('The inspected frame changed.');
  if(result.componentFailure?.component==='page_state')return {observation,...result};
  const current=observation.screeningSubmissionControl?observeCurrentDocument(input.expectedUrl):observation;
  if(current.screeningSubmissionControl==='disabled'){
    if(input.action==='status' || input.action==='fill' && !input.matchingRunId)result.incomplete=true;
    (result.skipped??=[]).push({label:'Application',reason:'employer_submission_disabled'});
  }
  return {observation:current,...result};
}
