import type { Page } from 'playwright';
import { advanceJobviteScreening } from './jobvite-workflow.ts';
import { advanceSmartRecruiters } from './smartrecruiters-workflow.ts';
import { fillGenericApplication } from './generic-application.ts';
import { ApplicationPause, type ProductInput } from './application-contract.ts';
import { componentFailure, recordComponentFailure } from './component-diagnostics.ts';

export async function prepareCurrentPage(page: Page, input: ProductInput, signal: AbortSignal, progress: (stage: string) => void): Promise<never> {
  progress("Filling this unfamiliar application page");
  const fill = () => fillGenericApplication(page, input.url, input.profile, input.resume, signal, input.learningRoot);
  let advanced = false;
  try {
    const url = page.url();
    let report = await fill();
    signal.throwIfAborted();
    const smartStep = await advanceSmartRecruiters(page,url,report,signal);
    let smartStop = typeof smartStep === 'string' ? smartStep : undefined;
    if (smartStep && typeof smartStep !== 'string') {
      advanced = true;
      signal.throwIfAborted();
      if (page.url() !== smartStep.screeningUrl) throw new ApplicationPause('The employer screening page changed before filling.');
      progress('Filling the SmartRecruiters screening step');
      const screening = await fill();
      const terminal = await advanceSmartRecruiters(page,smartStep.screeningUrl,screening,signal);
      smartStop = typeof terminal === 'string' ? terminal : 'The employer screening step is open. Review the remaining questions.';
      report = {...screening, filled:[...new Set([...report.filled,...screening.filled])], skipped:[...report.skipped,...screening.skipped],
        resume:report.resume, componentFailure:screening.componentFailure ?? report.componentFailure};
    }
    advanced = await advanceJobviteScreening(page, url, input.resume, report, signal);
    if (advanced) {
      progress('Filling the Jobvite screening step');
      const next = await fill();
      const skips = new Map([...report.skipped,...next.skipped].map(row=>[JSON.stringify(row),row]));
      report = {...next,filled:[...report.filled,...next.filled],skipped:[...skips.values()],
        componentFailure:report.componentFailure ?? next.componentFailure,
        resume:report.resume==='unverified' ? 'unverified' : next.resume};
    }
    const reasons:Record<string,string>={saved_value_conflict:'saved profile differs',value_changed_after_fill:'site changed the filled value',existing_attachment_preserved:'existing attachment needs review',resume_attachment_not_verified:'attachment could not be verified',choice_requires_mapping:'no matching saved option',no_stored_mapping:'no saved answer',value_not_accepted:'site rejected the value',ambiguous_duplicate:'more than one matching field'};
    Object.assign(reasons,{
      uploaded_attachment_requires_review:'check the uploaded attachment on the page',
      resume_filename_visible_contents_unverified:'the employer shows the matching filename. PDF contents unverified',
      resume_upload_already_attempted_review_attachment:'upload already attempted; check the attachment before retrying',
      resume_parsing_pending_profile_not_filled:'waiting for upload or parsing confirmation; profile fields were left unchanged',
      resume_parser_value_conflict:'resume parsing produced a value that differs from your saved profile',
      resume_parser_unmapped_value_requires_review:'review the value entered by resume parsing; no saved answer confirms it',
      resume_control_not_identified:'resume upload control could not be verified',
      application_form_not_identified:'application form could not be identified',
      field_replaced_without_stable_identity:'field changed during filling',
      field_no_longer_editable:'field is not editable',
      different_resume_requires_manual_review:'a different resume is present; review it manually',
      attachment_not_verified_native_file_retained:'file remains selected, but the upload could not be verified',
      phone_country_requires_review:'check the phone country and number',
      phone_country_change_requires_review:'phone country changed; check the number before retrying',
      province_change_requires_review:'province selection changed; check it before retrying',
      province_control_changed:'province control changed before selection',
      province_menu_binding_changed:'province menu no longer matches its control',
      province_menu_open_changed:'province control changed while its menu opened',
      province_option_not_unique:'saved province is not uniquely available in the menu',
      province_selection_not_verified:'province selection or reset could not be confirmed',
      selected_resume_already_present:'selected resume is already present',
    });
    const privateValues = (input.profile as {profile?:{facts?:{value:unknown}[]}})?.profile?.facts?.flatMap(fact=>typeof fact.value==='string' && fact.value.length>3 ? [fact.value] : []) ?? [];
    const label = (value:string) => {
      let text=value.replace(/[\u0000-\u001f\u007f]/g,' ').replace(/https?:\/\/\S+|\b[^\s@]+@[^\s@]+\b/g,'[hidden]');
      for(const value of privateValues) text=text.split(value).join('[hidden]');
      return text.trim().slice(0,70) || 'Field';
    };
    const unresolved=report.skipped.filter(item=>!['saved_value_already_present','selected_resume_already_present','optional_field'].includes(item.reason));
    const warnings=unresolved.slice(0,4).map(item=>`${label(item.label)}: ${reasons[item.reason] ?? 'needs review'}`);
    if (unresolved.length > 4) warnings.push(`${unresolved.length - 4} more fields need review`);
    const resumeVerified=report.resume === 'verified';
    const paused = new ApplicationPause(`Partial page fill: ${report.filled.length} fields filled. ${resumeVerified ? 'Selected resume verified.' : report.resume==='optional' ? 'Optional resume left unchanged.' : 'Selected resume needs review.'}${warnings.length ? ` ${warnings.join('; ')}.` : ''} ${smartStop ?? (advanced ? 'Review the screening step. C3 stopped before submission.' : 'Review the draft. C3 has not advanced or submitted.')}`);
    if (report.componentFailure) {
      recordComponentFailure(paused, report.componentFailure.component, report.componentFailure.operation);
    }
    throw paused;
  } catch (error) {
    if (error instanceof ApplicationPause) throw error;
    const wrapped = new ApplicationPause(advanced ? "C3 clicked Next once. Inspect the application before retrying." : "This unfamiliar application needs review. Open its exact application form before retrying; C3 has not advanced or submitted.");
    const boundary = componentFailure(error);
    if (boundary) recordComponentFailure(wrapped, boundary.component, boundary.operation);
    throw wrapped;
  }
}
