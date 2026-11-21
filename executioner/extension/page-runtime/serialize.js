import { applicationAttachmentControls, observeCurrentDocument, smartRecruitersForm, workdayNoticeMarkers } from '../page-adapters/document.js';
import { createUploadReader } from './upload-reader.js';
import { createLegacyAnswerReader } from './legacy-page-answers.js';
import { createFabricControl } from '../page-adapters/fabric-control.js';
import { createProvinceMenu } from '../page-adapters/bamboo-province.js';
import { createCompositeControlActions } from './composite-control-actions.js';
import { readNavigationDiagnostics } from './navigation-diagnostics.js';
import { createRequiredFieldReader } from './required-field.js';
import { createFieldObserver } from './field-observation.js';
import { createDomReader } from './dom-reader.js';
import { createFieldRecognition } from './field-recognition.js';
import { createUploadVerification } from './upload-verification.js';
import { createControlInteraction } from './control-interaction.js';
import { createPhoneReader } from './phone-reader.js';
import { ripplingLocationChoices } from '../page-adapters/rippling-location.js';
import { revealRipplingPhoneSelection } from '../page-adapters/rippling-phone.js';

import { observeWorkdayDocument } from '../workday-page.js';
import { observeFormDocument, currentPageInterruption } from '../form-page.js';
import { addressGroupLabel } from '../page-adapters/jazz-address.js';
import { clientAttachmentState, verifiedClientAttachment } from '../page-adapters/client-attachment.js';
import { markedRequired, smartRecruitersUploadHeading } from '../page-adapters/required-markers.js';
import { smartRecruitersCityChoices } from '../page-adapters/smartrecruiters-city.js';
import { createSearchChoiceReader } from '../page-adapters/workday-choice.js';
import { isPortalResumeBinding } from '../jobvite-resume.js';
import { jobviteResumeAcknowledgment, jobviteScreeningPanel, watchJobviteScreening } from '../page-adapters/jobvite-screening.js';
import { createUploadStatusReader } from '../page-adapters/upload-status.js';
import { runPageFill } from './fill.js';

// Bind site-owned readers here, before serializing into the selected browser document.
export function fillPageDocument(input) {
  return runPageFill(input, {observeCurrentDocument, currentPageInterruption, createSearchChoiceReader, smartRecruitersCityChoices,
    createFabricControl, createProvinceMenu, isPortalResumeBinding, jobviteScreeningPanel, watchJobviteScreening, createUploadStatusReader, addressGroupLabel, markedRequired, clientAttachmentState, verifiedClientAttachment,
    ripplingLocationChoices, revealRipplingPhoneSelection, customApplicationForm:smartRecruitersForm, uploadHeading:smartRecruitersUploadHeading, noticeMarkers:workdayNoticeMarkers});
}

// Only shipped module functions enter the serialized program. Applicant data travels as a separate argument.
function isolatedFunction(entry, dependencies) {
  const markers = {applicationAttachmentControls, smartRecruitersUploadHeading, workdayNoticeMarkers};
  return `(function(...args) {
    const {applicationAttachmentControls, smartRecruitersUploadHeading, workdayNoticeMarkers} = ${JSON.stringify(markers)};
    ${dependencies.map(fn => fn.toString()).join('\n')}
    return (${entry})(...args);
  })`;
}
export const pageFillSource = isolatedFunction(fillPageDocument, [
  runPageFill,
  observeCurrentDocument,
  smartRecruitersForm,
  createUploadReader,
  createLegacyAnswerReader,
  createFabricControl,
  createProvinceMenu,
  createCompositeControlActions,
  readNavigationDiagnostics,
  createRequiredFieldReader,
  createFieldObserver,
  createDomReader,
  createFieldRecognition,
  createUploadVerification,
  createControlInteraction,
  createPhoneReader,
  revealRipplingPhoneSelection,
  ripplingLocationChoices,
  observeWorkdayDocument,
  observeFormDocument,
  currentPageInterruption,
  addressGroupLabel,
  markedRequired,
  clientAttachmentState,
  verifiedClientAttachment,
  isPortalResumeBinding,
  jobviteResumeAcknowledgment,
  jobviteScreeningPanel,
  watchJobviteScreening,
  createUploadStatusReader,
  createSearchChoiceReader,
  smartRecruitersCityChoices,
]);
export const observePageSource = isolatedFunction(observeCurrentDocument, [observeFormDocument, observeWorkdayDocument]);
export const checkPageSource = currentPageInterruption.toString();
