import type { OwnedApplicationOperation } from '../browser/playwright-live/private/application-page-types.ts';
import type { ApplicationWalkFailurePacket } from '../ats/workday/application/page-walk-contract.ts';
import type { C3Component, ComponentFailure } from './component-diagnostics.ts';

const layers: Partial<Record<ApplicationWalkFailurePacket['unknownLayer'], C3Component>> = {
  page_type: 'page_state',
  question: 'answer_matching',
  answer: 'answer_matching',
  required_field: 'field_recognition',
  ui_behavior: 'browser_interaction',
  repeatable_row: 'field_recognition',
};

const primitives: Record<ApplicationWalkFailurePacket['primitive'], C3Component> = {
  page_observation: 'page_state',
  file_upload: 'uploads',
  profile_control: 'browser_interaction',
  question_control: 'browser_interaction',
  required_field_verification: 'field_recognition',
  repeatable_row_reconciliation: 'field_recognition',
  next: 'browser_interaction',
  record: 'workflow',
};

/** The walk identifies the layer it could not verify. This identifies the observed boundary. */
export function walkFailureComponent(failure: ApplicationWalkFailurePacket): ComponentFailure {
  return {
    component: layers[failure.unknownLayer] ?? primitives[failure.primitive],
    operation: failure.primitive,
  };
}

// Profile and questionnaire reconciliation invoke several components. Attribute an
// undifferentiated exception to workflow until a narrower boundary supplies evidence.
export const operationComponent: Record<OwnedApplicationOperation['kind'], C3Component> = {
  observe: 'page_state',
  next: 'browser_interaction',
  reconcile_resume: 'uploads',
  reconcile_profile: 'workflow',
  reconcile_questionnaire: 'workflow',
  inspect_recovery: 'page_state',
  reload: 'browser_interaction',
  review_expectations: 'review',
  capture_review: 'review',
  monitor_auth_state: 'page_state',
};
