import type { Page } from "playwright";
import type { AccountEvent } from "./account-journal.ts";

export interface WorkableReviewAttempt { selectedSize: number; rechecked: boolean }
export interface ResumeUploadReceipt { token: string; selectedSha256: string; filename: string; applicationKey: string }
export interface ProductInput {
  url: string;
  profile: unknown;
  resume: Buffer;
  credentials?: { email: string; password: string };
  requireScriptSignIn?: boolean;
  verifyEmail?: (page: Page, since: number, signal: AbortSignal) => Promise<void>;
  /** Internal queue-owned path; never accepted from an HTTP application request. */
  learningRoot?: string;
  /** Queue-owned durable recorder. Absence forbids account mutation. */
  recordAccountAction?: (event: AccountEvent, trace?: string) => void;
  resumeExpected?: boolean;
  onResumeObserved?: () => void;
  resumeUpload?: ResumeUploadReceipt;
  onResumeUpload?: (receipt: ResumeUploadReceipt | undefined) => void;
}
export class ApplicationPause extends Error {}
export class AttachmentPreviewUnavailable extends ApplicationPause {}
