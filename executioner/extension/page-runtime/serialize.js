import { applicationAttachmentControls, observeCurrentDocument, smartRecruitersForm, smartRecruitersScreeningFooter, workdayNoticeMarkers } from '../page-adapters/document.js';
import { uploadLabelKind, readUploadOwnerLabels } from './upload-label.js';
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
import { leverResumeTitle } from '../page-adapters/lever-resume.js';
import { clientAttachmentState, verifiedClientAttachment } from '../page-adapters/client-attachment.js';
import { markedRequired, smartRecruitersUploadHeading } from '../page-adapters/required-markers.js';
import { createSmartRecruitersScreening } from '../page-adapters/smartrecruiters-screening.js';
import { smartRecruitersCityChoices, smartRecruitersOptions } from '../page-adapters/smartrecruiters-city.js';
import { createSearchChoiceReader } from '../page-adapters/workday-choice.js';
import { isPortalResumeBinding } from '../jobvite-resume.js';
import { jobviteResumeAcknowledgment, jobviteRetainedResume, jobviteScreeningPanel, watchJobviteScreening, readJobviteGroup, createJobviteGroups } from '../page-adapters/jobvite-screening.js';
import { createUploadStatusReader } from '../page-adapters/upload-status.js';
import { runPageFill } from './fill.js';

// Bind site-owned readers here, before serializing into the selected browser document.
export function fillPageDocument(input) {
  return runPageFill(input, {observeCurrentDocument, currentPageInterruption, createSearchChoiceReader, smartRecruitersCityChoices, createSmartRecruitersScreening,
    createFabricControl, createProvinceMenu, isPortalResumeBinding, jobviteScreeningPanel, jobviteRetainedResume, watchJobviteScreening, createJobviteGroups, createUploadStatusReader, addressGroupLabel, markedRequired, clientAttachmentState, verifiedClientAttachment,
    ripplingLocationChoices, revealRipplingPhoneSelection, customApplicationForm:smartRecruitersForm, uploadHeading:smartRecruitersUploadHeading, wrappedUploadTitle:leverResumeTitle, noticeMarkers:workdayNoticeMarkers});
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
export const pageFillWorld = 'Hunt C3 page fill v1';
export const pageFillSource = isolatedFunction(fillPageDocument, [
  runPageFill,
  observeCurrentDocument,
  smartRecruitersScreeningFooter,
  smartRecruitersForm,
  createUploadReader,
  uploadLabelKind,
  readUploadOwnerLabels,
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
  leverResumeTitle,
  markedRequired,
  clientAttachmentState,
  verifiedClientAttachment,
  isPortalResumeBinding,
  jobviteResumeAcknowledgment,
  jobviteRetainedResume,
  jobviteScreeningPanel,
  watchJobviteScreening,
  readJobviteGroup,
  createJobviteGroups,
  createUploadStatusReader,
  createSearchChoiceReader,
  smartRecruitersCityChoices,
  smartRecruitersOptions,
  createSmartRecruitersScreening,
]);
export const observePageSource = isolatedFunction(observeCurrentDocument, [observeFormDocument, observeWorkdayDocument, smartRecruitersScreeningFooter]);
export const oneClickPersonalReadySource = isolatedFunction(() => {
  const {deepQuery, composedClosest, visible} = createDomReader();
  return smartRecruitersForm(deepQuery, composedClosest, visible)?.personalReady?.() === true;
}, [createDomReader, smartRecruitersForm]);
export const checkPageSource = currentPageInterruption.toString();
