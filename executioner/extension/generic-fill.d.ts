import type { PageAnswerPlan, PageQuestion } from '../src/product/page-matching.ts';
export interface PartialFillResult {
  status: 'partial';
  matching?: PageQuestion[];
  filled: string[];
  skipped: { label: string; reason: string; fieldId?: string; frameId?: string }[];
  canUndo: boolean;
  canRedo: boolean;
  resume?: 'verified' | 'missing' | 'unverified' | 'optional';
}
export function bambooResumeControl(): {input:HTMLInputElement;button:HTMLButtonElement;group:HTMLElement;form:HTMLFormElement}|null;
export function fillVisibleFields(input?: {
  matchingPlans?: PageAnswerPlan[];
  matchingRunId?: string;
  facts?: readonly { factId: string; value: unknown }[];
  action?: 'fill' | 'undo' | 'redo' | 'status';
  scope?: 'application' | 'page';
  expectedUrl?: string;
  expiresAt?: number;
  resume?: { name: string; base64: string };
  replaceExistingResume?: boolean;
}): Promise<PartialFillResult>;
