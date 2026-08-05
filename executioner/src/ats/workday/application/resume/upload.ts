import {
  disposeResumeArtifact,
  useResumeArtifactUpload,
} from "../../../../contracts/index.ts";
import {
  isWorkdayResumeFileIntent,
  type WorkdayResumeFileIntent,
} from "./intent.ts";
import type {
  WorkdayResumeAcceptance,
  WorkdayResumeBrowserState,
  WorkdayResumeError,
  WorkdayResumeEvent,
  WorkdayResumeLocator,
  WorkdayResumeObservation,
  WorkdayResumePage,
  WorkdayResumeUploadDriver,
  WorkdayResumeUploadHandler,
  WorkdayResumeVerifier,
} from "./types.ts";

const selectors = Object.freeze({
  input: 'input[type="file"][data-automation-id="file-upload-input-ref"]',
  item: '[data-automation-id="file-upload-item"]',
  success: '[data-automation-id="file-upload-success"], [data-automation-id="file-upload-item"][data-upload-state="success"]',
  remove: '[data-automation-id="file-upload-item"] [data-automation-id="delete-file"], [data-automation-id="file-upload-item"] button[aria-label^="Delete"]',
  confirm: '[data-automation-id="confirmDeleteFile"]',
  error: '[data-automation-id="file-upload-error"]',
});

const mimeType = "application/pdf";
const handledResumeArtifacts = new WeakSet<object>();

export function createWorkdayResumeUploadDriver(
  page: WorkdayResumePage,
  options: { readonly timeoutMs?: number } = {},
): WorkdayResumeUploadDriver {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const driver: WorkdayResumeUploadDriver = {
    async upload(intent, replaceExisting, signal) {
      if (signal.aborted) return failure("operation_cancelled");
      if (!validIntent(intent)) return failure("artifact_handle_invalid");
      const input = page.locator(selectors.input);
      const items = page.locator(selectors.item);
      try {
        const inputCount = await input.count();
        const itemCount = await items.count();
        if (inputCount !== 1 || itemCount > 1) {
          return failure("resume_page_invalid");
        }
        if (itemCount === 1 && !replaceExisting) {
          return failure("resume_existing_unverified");
        }
      } catch {
        return failure("resume_page_invalid");
      }

      return useResumeArtifactUpload(intent.artifact, async (bytes) => {
        if (signal.aborted) return failure("operation_cancelled");
        try {
          let replacedExisting = false;
          if (await items.count() === 1) {
            const remove = page.locator(selectors.remove);
            if (!replaceExisting || await remove.count() !== 1) {
              return failure("resume_existing_unverified");
            }
            await remove.click({ timeout: timeoutMs });
            const confirm = page.locator(selectors.confirm);
            const confirmCount = await confirm.count();
            if (confirmCount > 1) return failure("resume_page_invalid");
            if (confirmCount === 1) await confirm.click({ timeout: timeoutMs });
            if (!await waitForCount(items, 0, timeoutMs, signal)) {
              return failure("resume_upload_failed");
            }
            replacedExisting = true;
          }
          if (signal.aborted) return failure("operation_cancelled");
          await input.setInputFiles({
            name: "resume.pdf",
            mimeType,
            buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          }, { timeout: timeoutMs });
          return {
            ok: true,
            value: { attempted: true, replacedExisting },
          };
        } catch {
          return failure("resume_upload_failed");
        }
      });
    },
  };
  return Object.freeze(driver);
}

export function createWorkdayResumeVerifier(
  page: WorkdayResumePage,
  options: { readonly maxAttempts?: number; readonly intervalMs?: number } = {},
): WorkdayResumeVerifier {
  const maxAttempts = options.maxAttempts ?? 20;
  const intervalMs = options.intervalMs ?? 250;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 ||
      !Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new RangeError("invalid resume verifier retry policy");
  }
  const verifier: WorkdayResumeVerifier = {
    async inspect(intent, signal) {
      if (!validIntent(intent)) return failure("artifact_handle_invalid");
      let last: WorkdayResumeObservation = { kind: "unavailable" };
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (signal.aborted) return failure("operation_cancelled");
        try {
          last = await inspectOnce(page, intent);
        } catch {
          last = { kind: "unavailable" };
        }
        if (last.kind !== "unavailable") return { ok: true, value: last };
        if (attempt + 1 < maxAttempts && intervalMs > 0) {
          await delay(intervalMs, signal);
        }
      }
      return { ok: true, value: last };
    },
  };
  return Object.freeze(verifier);
}

export function createWorkdayResumeUploadHandler(options: {
  readonly driver: WorkdayResumeUploadDriver;
  readonly verifier: WorkdayResumeVerifier;
  readonly replaceExisting: boolean;
  readonly emit?: (event: WorkdayResumeEvent) => void;
}): WorkdayResumeUploadHandler {
  const handler: WorkdayResumeUploadHandler = {
    async upload(intent, signal) {
      if (!validIntent(intent)) return failure("artifact_handle_invalid");
      if (handledResumeArtifacts.has(intent.artifact)) {
        return failure("artifact_already_consumed");
      }
      handledResumeArtifacts.add(intent.artifact);
      let before: Awaited<ReturnType<WorkdayResumeVerifier["inspect"]>>;
      try {
        before = await options.verifier.inspect(intent, signal);
      } catch {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return failure(signal.aborted
          ? "operation_cancelled"
          : "resume_verification_failed");
      }
      if (!before.ok) {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return before;
      }
      if (before.value.kind === "verified") {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_duplicate_avoided");
        safeEmit(options.emit, "resume_upload_verified");
        return { ok: true, value: acceptance(intent, before.value.browserState, true, false) };
      }
      const hasExisting = before.value.kind === "different" ||
        before.value.kind === "existing";
      if (
        before.value.kind === "ambiguous" ||
        before.value.kind === "unavailable" ||
        (hasExisting && !options.replaceExisting)
      ) {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return failure(hasExisting
          ? "resume_existing_unverified"
          : "resume_verification_failed");
      }

      safeEmit(options.emit, "resume_upload_attempted");
      let driven: Awaited<ReturnType<WorkdayResumeUploadDriver["upload"]>>;
      try {
        driven = await options.driver.upload(intent, hasExisting, signal);
      } catch {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return failure(signal.aborted
          ? "operation_cancelled"
          : "resume_upload_failed");
      }
      if (!driven.ok) {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return driven;
      }
      if (driven.value.replacedExisting) {
        safeEmit(options.emit, "resume_upload_replaced");
      }
      let after: Awaited<ReturnType<WorkdayResumeVerifier["inspect"]>>;
      try {
        after = await options.verifier.inspect(intent, signal);
      } catch {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return failure(signal.aborted
          ? "operation_cancelled"
          : "resume_verification_failed");
      }
      if (!after.ok || after.value.kind !== "verified") {
        disposeResumeArtifact(intent.artifact);
        safeEmit(options.emit, "resume_upload_failed");
        return after.ok ? failure("resume_verification_failed") : after;
      }
      safeEmit(options.emit, "resume_upload_verified");
      return {
        ok: true,
        value: acceptance(
          intent,
          after.value.browserState,
          false,
          driven.value.replacedExisting,
        ),
      };
    },
  };
  return Object.freeze(handler);
}

async function inspectOnce(
  page: WorkdayResumePage,
  intent: WorkdayResumeFileIntent,
): Promise<WorkdayResumeObservation> {
  const input = page.locator(selectors.input);
  const items = page.locator(selectors.item);
  const success = page.locator(selectors.success);
  const remove = page.locator(selectors.remove);
  const error = page.locator(selectors.error);
  const [inputCount, itemCount, successCount, removeCount, errorCount] =
    await Promise.all([
      input.count(),
      items.count(),
      success.count(),
      remove.count(),
      error.count(),
    ]);
  if (inputCount !== 1 || itemCount > 1 || successCount > 1 ||
      removeCount > 1 || errorCount > 1) return { kind: "ambiguous" };
  const requiredErrorVisible = errorCount === 1 &&
    (error.isVisible === undefined || await error.isVisible());
  const identity = await input.evaluate(
    async (element: unknown, expected: unknown) => {
      if (!(element instanceof HTMLInputElement) || element.type !== "file" ||
          element.files === null || typeof expected !== "object" || expected === null) {
        return { fileCount: -1, identityMatches: false };
      }
      const value = expected as {
        readonly sha256: string;
        readonly sizeBytes: number;
        readonly mimeType: string;
      };
      if (element.files.length !== 1) {
        return { fileCount: element.files.length, identityMatches: false };
      }
      const file = element.files[0]!;
      if (file.size !== value.sizeBytes || file.type !== value.mimeType ||
          globalThis.crypto?.subtle === undefined) {
        return { fileCount: 1, identityMatches: false };
      }
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
        const sha256 = [...new Uint8Array(digest)]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        return { fileCount: 1, identityMatches: sha256 === value.sha256 };
      } finally {
        bytes.fill(0);
      }
    },
    {
      sha256: intent.artifact.sha256,
      sizeBytes: intent.sizeBytes,
      mimeType,
    },
  );
  if (!identityResult(identity)) return { kind: "unavailable" };
  if (identity.fileCount > 1 || identity.fileCount < 0) return { kind: "ambiguous" };
  if (identity.fileCount === 0 && itemCount === 0 && successCount === 0 &&
      removeCount === 0) return { kind: "empty" };
  if (identity.fileCount === 0) return itemCount === 1
    ? { kind: "existing" }
    : { kind: "unavailable" };
  if (itemCount !== 1 || successCount !== 1 || removeCount !== 1 ||
      requiredErrorVisible) return { kind: "unavailable" };
  if (!identity.identityMatches) return { kind: "different" };
  return {
    kind: "verified",
    browserState: Object.freeze({
      variant: "workday_resume_file_upload_v1",
      inputCardinality: 1,
      uploadedFileCount: 1,
      uploadComplete: true,
      requiredErrorVisible: false,
      removeControlCardinality: 1,
    }),
  };
}

function validIntent(value: unknown): value is WorkdayResumeFileIntent {
  return isWorkdayResumeFileIntent(value);
}

function identityResult(value: unknown): value is {
  readonly fileCount: number;
  readonly identityMatches: boolean;
} {
  return typeof value === "object" && value !== null &&
    Object.keys(value).length === 2 &&
    Number.isInteger((value as { readonly fileCount?: unknown }).fileCount) &&
    typeof (value as { readonly identityMatches?: unknown }).identityMatches === "boolean";
}

function acceptance(
  intent: WorkdayResumeFileIntent,
  browserState: WorkdayResumeBrowserState,
  duplicateUploadAvoided: boolean,
  replacedExisting: boolean,
): WorkdayResumeAcceptance {
  return Object.freeze({
    schemaVersion: 1,
    checkpoint: "resume_verified",
    artifactId: intent.artifactId,
    sizeBytes: intent.sizeBytes,
    fileType: intent.fileType,
    browserState,
    independentlyVerified: true,
    duplicateUploadAvoided,
    replacedExisting,
    submitActivated: false,
    privacyScan: "pass",
  });
}

function safeEmit(
  emit: ((event: WorkdayResumeEvent) => void) | undefined,
  kind: WorkdayResumeEvent["kind"],
): void {
  try {
    emit?.(Object.freeze({
      schemaVersion: 1,
      variant: "workday_resume_file_upload_v1",
      kind,
    }));
  } catch {
    // Observability cannot change browser or verification truth.
  }
}

async function waitForCount(
  locator: WorkdayResumeLocator,
  expected: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (signal.aborted) return false;
    if (await locator.count() === expected) return true;
    await delay(25, signal);
  } while (Date.now() < deadline);
  return false;
}

function delay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(resolve, milliseconds);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

function failure(code: WorkdayResumeError["code"]): {
  readonly ok: false;
  readonly error: WorkdayResumeError;
} {
  return { ok: false, error: { code, retryable: false } as WorkdayResumeError };
}
