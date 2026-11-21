export interface FormPageObservation {
  version: 'hosted-page-v1';
  documentKey: string;
  kind: 'security_challenge' | 'unknown' | 'loading' | 'application';
  signals: string[];
  conflicts: string[];
}
export function observeFormDocument(attachmentControls?: string): FormPageObservation;
export function currentPageInterruption(
  observation: FormPageObservation | import('./workday-page.js').WorkdayPageObservation,
  action?: string,
): undefined | {
  status: 'partial'; observation: typeof observation; incomplete: true;
  filled: string[]; matching: never[]; skipped: {label:string; reason:string; componentFailure:{component:'page_state';operation:string}}[];
  componentFailure: {component:'page_state'; operation:string}; canUndo:boolean; canRedo:boolean;
};
