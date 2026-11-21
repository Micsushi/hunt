export interface WorkdayPageObservation {
  version: 'workday-page-v1';
  documentKey: string;
  documentId?: string;
  kind: 'security_challenge' | 'closed' | 'completed' | 'employer_error' | 'employer_coded_error' | 'email_verification' | 'password_reset' | 'account_exists' | 'credential_rejected' | 'loading' | 'unknown' | 'create_account' | 'sign_in' | 'review' | 'application' | 'entry';
  signals: string[];
  conflicts: string[];
}
export function observeWorkdayDocument(): WorkdayPageObservation;
