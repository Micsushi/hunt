import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  captureResumeArtifact,
  upstreamResumeId,
} from "../../../../src/contracts/index.ts";
import {
  createWorkdayResumeFileIntent,
  createWorkdayResumeUploadDriver,
  createWorkdayResumeUploadHandler,
  createWorkdayResumeVerifier,
  type WorkdayResumeFileIntent,
} from "../../../../src/ats/workday/application/resume/index.ts";

const fixturePath = new URL(
  "./fixtures/workday-resume-upload-v1.html",
  import.meta.url,
);

async function fixture(): Promise<ResumeFixturePage> {
  const source = await readFile(fixturePath, "utf8");
  assert.match(source, /data-automation-id="file-upload-input-ref"/u);
  assert.match(source, /dataset\.automationId = "file-upload-item"/u);
  assert.match(source, /dataset\.uploadState = "success"/u);
  return new ResumeFixturePage();
}

class ResumeFixturePage {
  uploadEffects = 0;
  deleteEffects = 0;
  uploadedFileCount = 0;
  uploadComplete = false;
  requiredErrorVisible = true;
  clearInputAfterUpload = false;
  inputFileCount = 0;
  uploadedFileName = "";
  bytes = new Uint8Array();
  fileType = "";

  locator(selector: string): ResumeFixtureLocator {
    return new ResumeFixtureLocator(this, selector);
  }

  setFile(bytes: Uint8Array, fileType: string, fileName = "resume.pdf"): void {
    this.uploadEffects += 1;
    this.bytes = Uint8Array.from(bytes);
    this.fileType = fileType;
    this.inputFileCount = this.clearInputAfterUpload ? 0 : 1;
    this.uploadedFileName = fileName;
    this.uploadedFileCount = 1;
    this.uploadComplete = true;
    this.requiredErrorVisible = false;
  }

  remove(): void {
    this.deleteEffects += 1;
    this.bytes.fill(0);
    this.bytes = new Uint8Array();
    this.fileType = "";
    this.inputFileCount = 0;
    this.uploadedFileName = "";
    this.uploadedFileCount = 0;
    this.uploadComplete = false;
    this.requiredErrorVisible = true;
  }
}

class ResumeFixtureLocator {
  private readonly page: ResumeFixturePage;
  private readonly selector: string;

  constructor(
    page: ResumeFixturePage,
    selector: string,
  ) {
    this.page = page;
    this.selector = selector;
  }

  async count(): Promise<number> {
    if (this.selector.includes("file-upload-input-ref")) return 1;
    if (this.selector.includes("file-upload-success")) return this.page.uploadComplete ? 1 : 0;
    if (this.selector.includes("delete-file")) return this.page.uploadedFileCount;
    if (this.selector.includes("file-upload-item")) return this.page.uploadedFileCount;
    if (this.selector.includes("file-upload-error")) return 1;
    return 0;
  }

  async isVisible(): Promise<boolean> {
    return this.selector.includes("file-upload-error")
      ? this.page.requiredErrorVisible
      : await this.count() === 1;
  }

  async click(): Promise<void> {
    if (this.selector.includes("delete-file")) this.page.remove();
  }

  async setInputFiles(file: {
    readonly name: string;
    readonly mimeType: string;
    readonly buffer: Buffer;
  }): Promise<void> {
    this.page.setFile(file.buffer, file.mimeType, file.name);
  }

  async evaluate<Result, Argument>(
    _operation: (element: HTMLElement, argument: Argument) => Result | Promise<Result>,
    argument: Argument,
  ): Promise<Result> {
    if (this.selector.includes("file-upload-item")) {
      return {
        identityMatches: this.page.uploadedFileName === argument,
        busy: false,
        buttonCount: 0,
        progressCount: 0,
        complete: this.page.uploadComplete,
      } as Result;
    }
    const expected = argument as {
      readonly sha256: string;
      readonly sizeBytes: number;
      readonly mimeType: string;
    };
    const sha256 = createHash("sha256").update(this.page.bytes).digest("hex");
    return {
      fileCount: this.page.inputFileCount,
      identityMatches: this.page.inputFileCount === 1 &&
        this.page.bytes.byteLength === expected.sizeBytes &&
        this.page.fileType === expected.mimeType &&
        sha256 === expected.sha256,
    } as Result;
  }
}

function intent(
  value = "synthetic selected resume",
  artifactId = "resume_0123456789abcdef",
): { readonly intent: WorkdayResumeFileIntent; readonly bytes: Uint8Array } {
  const bytes = new TextEncoder().encode(value);
  const resumeId = upstreamResumeId(artifactId);
  const captured = captureResumeArtifact({
    resumeId,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  }, bytes);
  assert.equal(captured.ok, true);
  if (!captured.ok) throw new Error("capture failed");
  const created = createWorkdayResumeFileIntent({
    artifactId: resumeId,
    artifact: captured.value,
    fileType: "pdf",
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error("intent failed");
  return { intent: created.value, bytes };
}

test("Workday preserves the selected resume across upload, replay, and replacement", async () => {
  const page = await fixture();
  page.clearInputAfterUpload = true;
  const signal = new AbortController().signal;
  const upload = (selection: WorkdayResumeFileIntent) => createWorkdayResumeUploadHandler({
    driver: createWorkdayResumeUploadDriver(page),
    verifier: createWorkdayResumeVerifier(page, { maxAttempts: 3, intervalMs: 0 }),
    replaceExisting: true,
  }).upload(selection, signal);

  const first = intent().intent;
  assert.deepEqual(await upload(Object.freeze({ ...first })), {
    ok: false, error: { code: "artifact_handle_invalid", retryable: false },
  });
  assert.equal(page.uploadEffects, 0);

  const uploaded = await upload(first);
  assert.ok(uploaded.ok);
  assert.equal(uploaded.value.browserState.uploadComplete, true);
  assert.equal(uploaded.value.browserState.removeControlCardinality, 1);
  assert.equal(page.inputFileCount, 0);
  assert.equal(page.uploadedFileCount, 1);

  assert.deepEqual(await upload(first), {
    ok: false, error: { code: "artifact_already_consumed", retryable: false },
  });
  assert.equal(page.uploadEffects, 1);

  const duplicate = await upload(intent().intent);
  assert.ok(duplicate.ok);
  assert.equal(duplicate.value.duplicateUploadAvoided, true);
  assert.equal(duplicate.value.replacedExisting, false);
  assert.equal(page.uploadEffects, 1);

  const changed = await upload(intent("different artifact", "resume_aaaaaaaaaaaaaaaa").intent);
  assert.ok(changed.ok);
  assert.equal(changed.value.replacedExisting, true);
  assert.equal(page.uploadedFileCount, 1);
  assert.equal(page.uploadEffects, 2);
  assert.equal(page.deleteEffects, 1);
});

test("does not accept a driver's success without fresh structural verification", async () => {
  const selected = intent();
  const result = await createWorkdayResumeUploadHandler({
    driver: {
      async upload() {
        return { ok: true as const, value: { attempted: true as const, replacedExisting: false } };
      },
    },
    verifier: {
      async inspect() {
        return { ok: true as const, value: { kind: "empty" as const } };
      },
    },
    replaceExisting: true,
  }).upload(selected.intent, new AbortController().signal);

  assert.deepEqual(result, {
    ok: false,
    error: { code: "resume_verification_failed", retryable: false },
  });
});
