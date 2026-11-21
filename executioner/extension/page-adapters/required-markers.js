export const smartRecruitersUploadHeading = 'spl-typography-title[data-test="section-title"]';

// Keep selector precedence when a site marker is nested inside a generic group.
export function markedRequired(e, composedClosest, deepQuery) {
  const owner=composedClosest(e,'[data-automation-id="formField"],[data-automation-id^="formField-"],[data-required],.ashby-application-form-field,[role=group]');
  // A shared group marker does not identify which sibling must be filled.
  if (owner?.matches('[role=group]') && deepQuery(owner,'input:not([type=hidden]),textarea,select,button[aria-haspopup=listbox],button[role=combobox]').some(control=>control!==e)) return false;
  return !!owner && (owner.getAttribute('data-required')==='true' || owner.getAttribute('aria-required')==='true' ||
    !!owner.querySelector('[data-automation-id="required"],abbr[title="required" i],[aria-label="required" i],.ashby-application-form-field-required'));
}
