import type {
  PortResult,
  ResumeArtifactError,
} from "../../../../contracts/index.ts";
import type { WorkdayResumeFileIntent } from "./intent.ts";

export interface WorkdayResumeLocator {
  count(): Promise<number>;
  isVisible?(): Promise<boolean>;
  click(options?: { readonly timeout?: number }): Promise<void>;
  setInputFiles(
    file: {
      readonly name: string;
      readonly mimeType: string;
      readonly buffer: Buffer;
    },
    options?: { readonly timeout?: number },
  ): Promise<void>;
  evaluate<Result, Argument>(
    operation: (element: HTMLElement, argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result>;
}

export interface WorkdayResumePage {
  locator(selector: string): WorkdayResumeLocator;
}

export type WorkdayResumeError =
  | ResumeArtifactError
  | {
      readonly code:
        | "operation_cancelled"
        | "resume_page_invalid"
        | "resume_existing_unverified"
        | "resume_upload_failed"
        | "resume_verification_failed";
      readonly retryable: false;
    };

export interface WorkdayResumeBrowserState {
  readonly variant: "workday_resume_file_upload_v1";
  readonly inputCardinality: 1;
  readonly uploadedFileCount: 1;
  readonly uploadComplete: true;
  readonly requiredErrorVisible: false;
  readonly removeControlCardinality: 0 | 1;
}

export type WorkdayResumeObservation =
  | { readonly kind: "empty" }
  | { readonly kind: "existing" }
  | { readonly kind: "different" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "verified";
      readonly browserState: WorkdayResumeBrowserState;
    };

export interface WorkdayResumeUploadDriver {
  upload(
    intent: WorkdayResumeFileIntent,
    replaceExisting: boolean,
    signal: AbortSignal,
  ): Promise<PortResult<{
    readonly attempted: true;
    readonly replacedExisting: boolean;
  }, WorkdayResumeError>>;
}

export interface WorkdayResumeVerifier {
  inspect(
    intent: WorkdayResumeFileIntent,
    signal: AbortSignal,
  ): Promise<PortResult<WorkdayResumeObservation, WorkdayResumeError>>;
}

export interface WorkdayResumeAcceptance {
  readonly schemaVersion: 1;
  readonly checkpoint: "resume_verified";
  readonly artifactId: WorkdayResumeFileIntent["artifactId"];
  readonly sizeBytes: number;
  readonly fileType: "pdf";
  readonly browserState: WorkdayResumeBrowserState;
  readonly independentlyVerified: true;
  readonly duplicateUploadAvoided: boolean;
  readonly replacedExisting: boolean;
  readonly submitActivated: false;
  readonly privacyScan: "pass";
}

export interface WorkdayResumeEvent {
  readonly schemaVersion: 1;
  readonly variant: "workday_resume_file_upload_v1";
  readonly kind:
    | "resume_upload_attempted"
    | "resume_upload_replaced"
    | "resume_upload_duplicate_avoided"
    | "resume_upload_verified"
    | "resume_upload_failed";
}

export interface WorkdayResumeUploadHandler {
  upload(
    intent: WorkdayResumeFileIntent,
    signal: AbortSignal,
  ): Promise<PortResult<WorkdayResumeAcceptance, WorkdayResumeError>>;
}
