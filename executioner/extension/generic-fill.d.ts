import type { ComponentFailure } from '../src/product/component-diagnostics.ts';
import type { PageAnswerPlan, PageQuestion } from '../src/product/page-matching.ts';
export interface PartialFillResult {
  componentFailure?: ComponentFailure;
  status: 'partial';
  incomplete?: boolean;
  profileCountryConflict?: boolean;
  matching?: PageQuestion[];
  requiredIssues?: {fieldId:string;label:string;section?:string;reason:'required_empty'|'required_invalid'|'required_unconfirmed'}[];
  filled: string[];
  skipped: { label: string; reason: string; componentFailure?: ComponentFailure; fieldId?: string; frameId?: string }[];
  canUndo: boolean;
  canRedo: boolean;
  resumeEvidence?: 'filename' | 'earlier_filename' | 'picker';
  resume?: 'verified' | 'missing' | 'unverified' | 'optional';
}
export function fillVisibleFields(input?: {
  matchingPlans?: PageAnswerPlan[];
  aiConsentDecision?: boolean | null;
  matchingRunId?: string;
  pageHandoff?: string;
  queuedScreening?: boolean;
  facts?: readonly { factId: string; value: unknown }[];
  action?: 'fill' | 'undo' | 'redo' | 'status';
  scope?: 'application' | 'page';
  expectedUrl?: string;
  expiresAt?: number;
  resume?: { name: string; base64: string };
  replaceExistingResume?: boolean;
  useProfileCountry?: boolean;
  currentProfileCountry?: string | null;
}): Promise<PartialFillResult>;
