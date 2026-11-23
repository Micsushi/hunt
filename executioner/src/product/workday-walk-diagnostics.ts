import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OwnedApplicationOperation } from '../browser/playwright-live/private/application-page-types.ts';
import type { ApplicationPageTruth } from '../ats/workday/application/page-walk-contract.ts';
import type { ComponentFailure } from './component-diagnostics.ts';

const navigationStages = new Set([
  'source_guard_failed','action_unavailable','action_admitted','hit_test_started','admitted_control_activated','activation_failed',
  'destination_readback_started','unchanged_source_retry_started','unchanged_source_retry_activated',
  'unchanged_source_retry_activation_failed','destination_readback_succeeded','destination_readback_failed',
  'validation_downgrade','destination_not_allowed','semantic_guard_failed','navigation_advanced',
  'navigation_exception_after_admission','navigation_exception_before_admission','snapshot_failed',
  'destination_candidate_unstable','destination_wait_exhausted','action_event_evidence','action_event_evidence_unavailable',
]);

export class WorkdayWalkDiagnostics {
  private readonly learningRoot?: string;

  constructor(learningRoot?: string) {
    this.learningRoot = learningRoot;
  }

  failureCode: string | undefined;
  failureField: string | undefined;
  private readonly observations: object[] = [];
  private lastApplicationTruth: ReturnType<typeof applicationTruthDiagnostic> | undefined;
  activeOperation: OwnedApplicationOperation['kind'] | undefined;
  private walkFailureRecorded = false;
  failureBoundary: ComponentFailure | undefined;
  readonly controlDiagnostics: Record<string, string | boolean | number>[] = [];
  readonly reviewIssues: {code:string;fieldIds:string[]}[]=[];
  readonly recordDiagnostic = (name:string,value:object)=>{
    if(!this.learningRoot)return;
    mkdirSync(this.learningRoot,{recursive:true});
    writeFileSync(join(this.learningRoot,name),JSON.stringify(value));
  };
  readonly recordWalkFailure = (failure:object)=>{
    if(this.walkFailureRecorded)return;
    try {
      this.recordDiagnostic('application-walk-failure.json',{schemaVersion:1,...failure,
        ...this.failureBoundary, failureFieldId:this.failureField??null,activeOperation:this.activeOperation??null,
        lastObservation:this.lastApplicationTruth??null,controlDiagnostics:this.controlDiagnostics});
      this.walkFailureRecorded=true;
    } catch { /* Optional diagnostics must preserve the original failure. */ }
  };

  readonly trace = (event: string, detail?: object) => {
    if(event==='application_navigation_stage' && detail) {
      const data=detail as Record<string,unknown>;
      if(typeof data.code==='string' && navigationStages.has(data.code)) {
        const diagnostic:Record<string,string|boolean|number>={event,code:data.code};
        if(typeof data.errorClass==='string' && ['timeout','detached','closed','other'].includes(data.errorClass))diagnostic.errorClass=data.errorClass;
        for(const key of ['activationTimeout','pointerIntercepted','elementDetached','snapshotAvailable','sourceUnchanged','validationChanged','busySeen','clickObserved','trustedClickObserved','targetClickObserved','clickDefaultPrevented','pointerDownObserved','pointerUpObserved','invalidEventObserved','windowErrorObserved','unhandledRejectionObserved'] as const) {
          if(typeof data[key]==='boolean')diagnostic[key]=data[key];
        }
        for(const key of ['nativeInvalidBeforeCount','nativeInvalidCount','nativeInvalidFileCount','nativeInvalidOptionalCount','nativeCustomInvalidCount'] as const) {
          const value=data[key];
          if(typeof value==='number' && Number.isInteger(value) && value>=0 && value<=512)diagnostic[key]=value;
        }
        this.controlDiagnostics.push(diagnostic);
        if(this.controlDiagnostics.length>32)this.controlDiagnostics.shift();
      }
    }
    if(detail && ['profile_control_observed','profile_driver_failed','profile_inspection_failed','profile_reconciliation_blocked'].includes(event)) {
      const diagnostic:Record<string,string|boolean>={event};
      for(const key of ['code','fieldId','uiBehavior','errorClass','failureStage','profileInspectionClassification','profileInspectionPhase','profileInspectionDeadlineOutcome'] as const) {
        const value=(detail as Record<string,unknown>)[key];
        if(typeof value==='string' && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value))diagnostic[key]=value;
      }
      for(const key of ['backingValueCommitted','validationCleared'] as const) {
        const value=(detail as Record<string,unknown>)[key];
        if(typeof value==='boolean')diagnostic[key]=value;
      }
      this.controlDiagnostics.push(diagnostic);
      if(this.controlDiagnostics.length>32)this.controlDiagnostics.shift();
    }
    if(['review_summary_field_missing','review_row_attribution_unavailable','review_repeatable_row_mismatch'].includes(event) && detail) {
      const data=detail as {fieldId?:unknown;fieldIds?:unknown};
      const ids=Array.isArray(data.fieldIds)?data.fieldIds:[data.fieldId];
      this.reviewIssues.push({code:event,fieldIds:ids.filter((id):id is string=>typeof id==='string'&&/^[a-zA-Z0-9_.:-]{1,160}$/.test(id))});
    }
    if (event === 'workday_page_observed' && detail && this.learningRoot && JSON.stringify(this.observations.at(-1)) !== JSON.stringify(detail)) {
      this.observations.push(detail);
      if (this.observations.length>128) this.observations.shift();
      mkdirSync(this.learningRoot,{recursive:true});
      writeFileSync(join(this.learningRoot,'page-observations.json'),JSON.stringify(this.observations));
    }
    if (event === 'questionnaire_attachment_unverified' && detail && 'issue' in detail &&
        typeof detail.issue === 'string' && ['download_failed','download_unavailable','no_download','mismatch','picker_mismatch'].includes(detail.issue)) {
      this.failureCode = 'questionnaire_attachment_' + detail.issue;
    }
    if (event === 'questionnaire_reconciliation_blocked' && detail && 'code' in detail && (detail.code === 'salary_readback_needs_review' || detail.code === 'employee_relationship_needs_review')) {
      this.failureCode = detail.code;
    }
    if (event === 'questionnaire_reconciliation_blocked' && detail && 'uiBehavior' in detail &&
        detail.uiBehavior === 'file_upload' && 'code' in detail && (detail.code === 'unsupported' || detail.code === 'verification_unavailable')) {
      this.failureCode = 'questionnaire_attachment_needs_review';
    }
    if (event === "profile_reconciliation_blocked" && detail && "code" in detail && typeof detail.code === "string") {
      this.failureCode = detail.code;
      this.failureField = "fieldId" in detail && typeof detail.fieldId === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(detail.fieldId) ? detail.fieldId : undefined;
    }
    if (process.env.HUNT_C3_VALUE_FREE_ACCOUNT_TRACE === "1" && detail &&
        (["profile_control_observed", "profile_driver_failed", "profile_file_upload_reconciled", "profile_row_mutation_failed", "profile_inspection_failed", "profile_option_observation_failed", "profile_option_observation_cleanup_failed", "profile_reconciliation_blocked", "questionnaire_reconciliation_failed",
          "questionnaire_reconciliation_uncertain", "questionnaire_reconciliation_exception",
          "questionnaire_field_rebind_failed", "questionnaire_field_drive_completed",
          "questionnaire_field_verification_completed"].includes(event))) {
      const diagnostic: Record<string, string> = { event };
      for (const key of ["code", "fieldId", "uiBehavior", "errorClass", "failureStage", "underlyingError", "profileInspectionClassification", "profileInspectionPhase", "profileInspectionDeadlineOutcome"] as const) {
        const value = (detail as Record<string, unknown>)[key];
        if (typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,120}$/.test(value)) diagnostic[key] = value;
      }
      try { process.stderr.write(`${JSON.stringify({ c3ProfileDiagnostic: diagnostic })}\n`); } catch { /* Diagnostics never change filling. */ }
    }
  };

  observe(truth: ApplicationPageTruth) {
    this.lastApplicationTruth = applicationTruthDiagnostic(truth);
  }
}

function applicationTruthDiagnostic(truth:ApplicationPageTruth) {
  return {page:truth.page,lanes:truth.lanes??[],c3OwnedDuplicateRows:truth.c3OwnedDuplicateRows,submitActivated:truth.submitActivated,
    requiredFields:truth.requiredFields.map(field=>({fieldId:field.fieldId,page:field.page,verification:field.verification,
      ...(field.uiState?{navigationEligible:field.uiState.navigationEligible,blockedBy:field.uiState.blockedBy}:{})}))};
}
