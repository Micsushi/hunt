import type { Page } from 'playwright';
import { observeWorkdayDocument, type WorkdayPageObservation } from '../../../extension/workday-page.js';
export type { WorkdayPageObservation } from '../../../extension/workday-page.js';

/** Shared evidence only. Each caller retains its own action and target guards. */
export function observeWorkdayPage(page: Pick<Page, 'evaluate'>): Promise<WorkdayPageObservation> {
  return page.evaluate(observeWorkdayDocument);
}

export function workdayObservationMessage(observation: WorkdayPageObservation): string | undefined {
  const messages: Partial<Record<WorkdayPageObservation['kind'], string>> = {
    employer_coded_error: 'Workday is showing a coded page error. C3 has paused without refreshing or submitting; the current page is preserved.',
    employer_error: 'Workday is showing a site error. The draft is preserved.',
    closed: 'This posting is no longer available. Choose another job at this employer.',
    completed: 'The employer shows this application as already applied or completed. C3 will stop here.',
    security_challenge: 'Complete the employer security check in this tab, then retry.',
    email_verification: 'The employer requires email verification.',
    password_reset: 'The employer requires a password reset. C3 has not requested or changed a password.',
    credential_rejected: 'The site rejected account access. Check the account details before retrying.',
  };
  return messages[observation.kind];
}
